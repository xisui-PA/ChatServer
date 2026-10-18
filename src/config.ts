import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Resolved configuration values used at runtime.
 */
export interface ChatServerConfig {
  /** Address the HTTP/WebSocket server binds to. */
  host: string;
  /** TCP port the server listens on. */
  port: number;
  /** Message sent to each client immediately after it connects. */
  welcomeMessage: string;
}

/**
 * Values used when the config file does not specify an option.
 */
export const DEFAULT_CONFIG: ChatServerConfig = {
  host: '0.0.0.0',
  port: 3000,
  welcomeMessage: 'Connected to ChatServer'
};

/**
 * Raised for malformed config files or invalid command-line arguments.
 */
export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Options accepted by the `chatserver` executable.
 */
export interface CliOptions {
  configPath?: string;
  printConfig: boolean;
  help: boolean;
}

/**
 * A config file plus the values that were resolved from it.
 */
export interface LoadedConfig {
  values: ChatServerConfig;
  configPath: string;
  /** True when the file did not exist and a default one was written. */
  created: boolean;
}

export interface LoadConfigOptions {
  configPath?: string;
  /** Set to false to fail instead of creating a missing config file. */
  createIfMissing?: boolean;
}

export const HELP_TEXT = `Usage: chatserver [options]

Options:
  -c, --config <path>  Use a specific config file instead of the per-user default
      --print-config   Print the resolved configuration and exit
  -h, --help           Show this help and exit

Environment variables:
  CHATSERVER_CONFIG        Path to the config file
  CHATSERVER_HOST / HOST   Override the listen address
  CHATSERVER_PORT / PORT   Override the listen port

Default config file:
  macOS    ~/Library/Application Support/chatserver/config.json
  Linux    $XDG_CONFIG_HOME/chatserver/config.json (~/.config by default)
  Windows  %APPDATA%\\chatserver\\config.json
`;

/**
 * Returns the platform-appropriate per-user config file location.
 */
export function getDefaultConfigPath(platform: NodeJS.Platform = process.platform): string {
  const home = os.homedir();

  switch (platform) {
    case 'win32': {
      const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
      return path.join(appData, 'chatserver', 'config.json');
    }
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'chatserver', 'config.json');
    default: {
      const configHome = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
      return path.join(configHome, 'chatserver', 'config.json');
    }
  }
}

/**
 * Writes a config file containing the default values, creating parent directories.
 */
function writeDefaultConfig(configPath: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
}

/**
 * Validates a parsed JSON value and merges it over the defaults.
 */
function validateConfig(input: unknown, configPath: string): ChatServerConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ConfigError(`${configPath} must contain a JSON object.`);
  }

  const record = input as Record<string, unknown>;
  const knownKeys = new Set(Object.keys(DEFAULT_CONFIG));
  const unknownKeys = Object.keys(record).filter((key) => !knownKeys.has(key));
  if (unknownKeys.length > 0) {
    console.warn(`[config] ignoring unknown option(s) in ${configPath}: ${unknownKeys.join(', ')}`);
  }

  const config: ChatServerConfig = { ...DEFAULT_CONFIG };

  if (record.host !== undefined) {
    if (typeof record.host !== 'string' || record.host.trim() === '') {
      throw new ConfigError(`${configPath}: "host" must be a non-empty string.`);
    }
    config.host = record.host.trim();
  }

  if (record.port !== undefined) {
    if (typeof record.port !== 'number' || !Number.isInteger(record.port) ||
      record.port < 1 || record.port > 65535) {
      throw new ConfigError(`${configPath}: "port" must be an integer between 1 and 65535.`);
    }
    config.port = record.port;
  }

  if (record.welcomeMessage !== undefined) {
    if (typeof record.welcomeMessage !== 'string') {
      throw new ConfigError(`${configPath}: "welcomeMessage" must be a string.`);
    }
    config.welcomeMessage = record.welcomeMessage;
  }

  return config;
}

/**
 * Reads and validates a config file.
 */
function readConfigFile(configPath: string): ChatServerConfig {
  let contents: string;
  try {
    contents = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new ConfigError(`Unable to read ${configPath}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new ConfigError(`Invalid JSON in ${configPath}: ${(error as Error).message}`);
  }

  return validateConfig(parsed, configPath);
}

/**
 * Applies environment variable overrides on top of the config file values.
 */
export function applyEnvironment(config: ChatServerConfig): ChatServerConfig {
  const resolved = { ...config };

  const host = process.env.CHATSERVER_HOST ?? process.env.HOST;
  if (host !== undefined) {
    resolved.host = host;
  }

  const port = process.env.CHATSERVER_PORT ?? process.env.PORT;
  if (port !== undefined) {
    const parsedPort = Number(port);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new ConfigError(`Invalid port "${port}" in environment; expected 1-65535.`);
    }
    resolved.port = parsedPort;
  }

  const welcomeMessage = process.env.CHATSERVER_WELCOME_MESSAGE;
  if (welcomeMessage !== undefined) {
    resolved.welcomeMessage = welcomeMessage;
  }

  return resolved;
}

/**
 * Resolves the config path, creating a default file when necessary, then reads it.
 *
 * Precedence (highest first): environment variables, config file, built-in defaults.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const configPath = path.resolve(
    options.configPath ?? process.env.CHATSERVER_CONFIG ?? getDefaultConfigPath()
  );

  let created = false;
  if (!fs.existsSync(configPath)) {
    if (options.createIfMissing === false) {
      throw new ConfigError(`Config file not found: ${configPath}`);
    }
    writeDefaultConfig(configPath);
    created = true;
  }

  const values = applyEnvironment(readConfigFile(configPath));
  return { values, configPath, created };
}

/**
 * Parses the CLI arguments accepted by the executable.
 */
export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { printConfig: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--config' || arg === '-c') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new ConfigError(`${arg} requires a path.`);
      }
      options.configPath = value;
      i += 1;
    } else if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (value === '') {
        throw new ConfigError('--config requires a path.');
      }
      options.configPath = value;
    } else if (arg === '--print-config') {
      options.printConfig = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new ConfigError(`Unknown option: ${arg}. Run "chatserver --help" for usage.`);
    }
  }

  return options;
}
