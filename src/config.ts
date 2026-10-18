import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasFilter, listFilters } from './filters/registry';
import { hasMessager, listMessagers } from './messagers/registry';

/**
 * A named implementation plus its config-file options.
 */
export interface AdapterSpec {
  /** Registered implementation name, e.g. a messager name or `ignore-sender`. */
  type: string;
  /** Options passed to the implementation's factory. */
  options: Readonly<Record<string, unknown>>;
}

/**
 * One chat pipeline: a messager plus the filters applied to inbound messages.
 */
export interface ChatDefinition {
  /** Unique chat name, used in logs. */
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
  /** Chat pipelines served by this process. */
  chats: readonly ChatDefinition[];
}

/**
 * Values used when the config file does not specify an option.
 */
export const DEFAULT_CONFIG: ChatServerConfig = {
  chats: []
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
  /** True when the file did not exist and a default one was written. */
  created: boolean;
}

export interface LoadConfigOptions {
  /** Set to true to create a missing config file. Defaults to false. */
  createIfMissing?: boolean;
}

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

  const messager = parseAdapterSpec(value.messager, `${where}.messager`);

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

  if (record.chats !== undefined) {
    if (!Array.isArray(record.chats)) {
      throw new ConfigError(`${configPath}: "chats" must be an array.`);
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
  return { ...config };
}

/** Loads config.json from the directory selected at invocation. */
export async function loadConfig(
  configDir: string,
  options: LoadConfigOptions = {}
): Promise<LoadedConfig> {
  const configPath = path.join(configDir, 'config.json');

  if (!options.createIfMissing && !(await isDirectory(configDir))) {
    throw new ConfigError(`Config folder not found: ${configDir}`);
  }

  let created = false;
  if (!(await fileExists(configPath))) {
    if (!options.createIfMissing) {
      throw new ConfigError(
        `Config file not found: ${configPath}. The config folder must contain config.json.`
      );
    }
    await writeDefaultConfig(configPath);
    created = true;
  }

  const values = applyEnvironment(await readConfigFile(configPath));
  return { values, configPath, created };
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
