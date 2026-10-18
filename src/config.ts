import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasFilter, listFilters } from './filters/registry';
import { hasMessager, listMessagers } from './messagers/registry';

/**
 * A named implementation plus its config-file options.
 */
export interface AdapterSpec {
  /** Registered implementation name, e.g. `websocket` or `ignore-sender`. */
  type: string;
  /** Options passed to the implementation's factory. */
  options: Readonly<Record<string, unknown>>;
}

/**
 * One chat pipeline: a messager plus the filters applied to inbound messages.
 */
export interface ChatDefinition {
  /** Unique chat name, used in logs and default WebSocket paths. */
  name: string;
  /** Messager implementation receiving and sending messages. */
  messager: AdapterSpec;
  /** Filters deciding whether a message should be replied to. */
  filters: readonly AdapterSpec[];
  /** Per-chat override for the fallback used when every filter abstains. */
  replyWhenOptional?: boolean;
}

/**
 * Resolved configuration values used at runtime.
 */
export interface ChatServerConfig {
  /** Address the HTTP/WebSocket server binds to. */
  host: string;
  /** TCP port the server listens on. */
  port: number;
  /** Default message sent to each client immediately after it connects. */
  welcomeMessage: string;
  /** Chat pipelines served by this process. */
  chats: readonly ChatDefinition[];
}

/**
 * Values used when the config file does not specify an option.
 */
export const DEFAULT_CONFIG: ChatServerConfig = {
  host: '0.0.0.0',
  port: 3000,
  welcomeMessage: 'Connected to ChatServer',
  chats: [
    {
      name: 'main',
      messager: { type: 'websocket', options: {} },
      filters: []
    }
  ]
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
  configDir?: string;
  printConfig: boolean;
  help: boolean;
}

/**
 * A config file plus the values that were resolved from it.
 */
export interface LoadedConfig {
  values: ChatServerConfig;
  /** Path of the config file that was read. */
  configPath: string;
  /**
   * Folder the config lives in. Also holds `<messager>_ignore` files, so keeping it
   * alongside the config keeps all per-user data in one place.
   */
  configDir: string;
  /** True when the file did not exist and a default one was written. */
  created: boolean;
}

export interface LoadConfigOptions {
  /** Config folder containing `config.json` and optional `<messager>_ignore` files. */
  configDir?: string;
  /** Set to false to fail instead of creating a missing config file. */
  createIfMissing?: boolean;
}

export const HELP_TEXT = `Usage: chatserver [options]

Options:
  -c, --config_dir <dir>  Config folder containing config.json and optional
                          <messager>_ignore files.
                          Defaults to the per-user config folder.
      --print-config      Print the resolved configuration and exit
  -h, --help              Show this help and exit

Environment variables:
  CHATSERVER_CONFIG_DIR    Config folder
  CHATSERVER_HOST / HOST   Override the listen address
  CHATSERVER_PORT / PORT   Override the listen port

Default config folder:
  macOS    ~/Library/Application Support/chatserver
  Linux    $XDG_CONFIG_HOME/chatserver (~/.config by default)
  Windows  %APPDATA%\\chatserver

The folder contains config.json and may contain <messager>_ignore files, which the
ignore-sender filter reads to decide which senders to ignore.
`;

/**
 * Returns the platform-appropriate per-user config folder.
 */
export function getDefaultConfigDir(platform: NodeJS.Platform = process.platform): string {
  const home = os.homedir();

  switch (platform) {
    case 'win32': {
      const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
      return path.join(appData, 'chatserver');
    }
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'chatserver');
    default: {
      const configHome = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');
      return path.join(configHome, 'chatserver');
    }
  }
}

/**
 * Returns the platform-appropriate per-user config file location.
 */
export function getDefaultConfigPath(platform: NodeJS.Platform = process.platform): string {
  return path.join(getDefaultConfigDir(platform), 'config.json');
}

/**
 * Returns true when `target` is an existing directory.
 */
async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fsp.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Returns true when `target` exists.
 */
async function fileExists(target: string): Promise<boolean> {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes a config file containing the default values, creating parent directories.
 */
async function writeDefaultConfig(configPath: string): Promise<void> {
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
}

/**
 * Returns true for plain JSON objects (not null, arrays, or primitives).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Warns about keys that are not part of the schema.
 */
function warnUnknownKeys(record: Record<string, unknown>, known: readonly string[], where: string): void {
  const unknown = Object.keys(record).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    console.warn(`[config] ignoring unknown option(s) in ${where}: ${unknown.join(', ')}`);
  }
}

/**
 * Normalizes a messager/filter spec from either a shorthand string or an object.
 */
function parseAdapterSpec(value: unknown, where: string): AdapterSpec {
  if (typeof value === 'string') {
    if (value.trim() === '') {
      throw new ConfigError(`${where} must not be empty.`);
    }
    return { type: value.trim(), options: {} };
  }

  if (!isPlainObject(value)) {
    throw new ConfigError(
      `${where} must be a string or an object with a "type" and optional "options".`
    );
  }

  warnUnknownKeys(value, ['type', 'options'], where);

  if (typeof value.type !== 'string' || value.type.trim() === '') {
    throw new ConfigError(`${where}: "type" must be a non-empty string.`);
  }

  const options = value.options ?? {};
  if (!isPlainObject(options)) {
    throw new ConfigError(`${where}: "options" must be an object.`);
  }

  return { type: value.type.trim(), options };
}

/**
 * Validates one entry of the `chats` array.
 */
function parseChat(value: unknown, index: number, seenNames: Set<string>): ChatDefinition {
  const where = `chats[${index}]`;

  if (!isPlainObject(value)) {
    throw new ConfigError(`${where} must be an object.`);
  }

  warnUnknownKeys(value, ['name', 'messager', 'filters', 'replyWhenOptional'], where);

  let name = `chat-${index + 1}`;
  if (value.name !== undefined) {
    if (typeof value.name !== 'string' || value.name.trim() === '') {
      throw new ConfigError(`${where}: "name" must be a non-empty string.`);
    }
    name = value.name.trim();
  }

  if (seenNames.has(name)) {
    throw new ConfigError(`${where}: duplicate chat name "${name}".`);
  }
  seenNames.add(name);

  const messager =
    value.messager === undefined
      ? { type: 'websocket', options: {} }
      : parseAdapterSpec(value.messager, `${where}.messager`);

  if (!hasMessager(messager.type)) {
    throw new ConfigError(
      `${where}.messager: unknown messager "${messager.type}". ` +
        `Available: ${listMessagers().join(', ')}.`
    );
  }

  const filtersValue = value.filters ?? [];
  if (!Array.isArray(filtersValue)) {
    throw new ConfigError(`${where}: "filters" must be an array.`);
  }

  const filters = filtersValue.map((filterValue, filterIndex) => {
    const filter = parseAdapterSpec(filterValue, `${where}.filters[${filterIndex}]`);
    if (!hasFilter(filter.type)) {
      throw new ConfigError(
        `${where}.filters[${filterIndex}]: unknown filter "${filter.type}". ` +
          `Available: ${listFilters().join(', ')}.`
      );
    }
    return filter;
  });

  let replyWhenOptional: boolean | undefined;
  if (value.replyWhenOptional !== undefined) {
    if (typeof value.replyWhenOptional !== 'boolean') {
      throw new ConfigError(`${where}: "replyWhenOptional" must be a boolean.`);
    }
    replyWhenOptional = value.replyWhenOptional;
  }

  return { name, messager, filters, replyWhenOptional };
}

/**
 * Validates a parsed JSON value and merges it over the defaults.
 */
function validateConfig(input: unknown, configPath: string): ChatServerConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ConfigError(`${configPath} must contain a JSON object.`);
  }

  const record = input as Record<string, unknown>;
  warnUnknownKeys(record, Object.keys(DEFAULT_CONFIG), configPath);

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

  if (record.chats !== undefined) {
    if (!Array.isArray(record.chats) || record.chats.length === 0) {
      throw new ConfigError(`${configPath}: "chats" must be a non-empty array.`);
    }

    const seenNames = new Set<string>();
    config.chats = record.chats.map((chat, index) => parseChat(chat, index, seenNames));
  }

  return config;
}

/**
 * Reads and validates a config file.
 */
async function readConfigFile(configPath: string): Promise<ChatServerConfig> {
  let contents: string;
  try {
    contents = await fsp.readFile(configPath, 'utf8');
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
 * Loads the config folder's `config.json`, creating it only for the default folder.
 *
 * Precedence (highest first): environment variables, config file, built-in defaults.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const explicit = options.configDir ?? process.env.CHATSERVER_CONFIG_DIR;
  const configDir = path.resolve(explicit ?? getDefaultConfigDir());
  const configPath = path.join(configDir, 'config.json');

  if (explicit !== undefined && !(await isDirectory(configDir))) {
    throw new ConfigError(`Config folder not found: ${configDir}`);
  }

  let created = false;
  if (!(await fileExists(configPath))) {
    if (explicit !== undefined || options.createIfMissing === false) {
      throw new ConfigError(
        `Config file not found: ${configPath}. The config folder must contain config.json.`
      );
    }
    await writeDefaultConfig(configPath);
    created = true;
  }

  const values = applyEnvironment(await readConfigFile(configPath));
  return { values, configPath, configDir, created };
}

/**
 * Parses the CLI arguments accepted by the executable.
 */
export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { printConfig: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--config_dir' || arg === '-c') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new ConfigError(`${arg} requires a directory.`);
      }
      options.configDir = value;
      i += 1;
    } else if (arg.startsWith('--config_dir=')) {
      const value = arg.slice('--config_dir='.length);
      if (value === '') {
        throw new ConfigError('--config_dir requires a directory.');
      }
      options.configDir = value;
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
