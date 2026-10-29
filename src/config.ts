import { MAX_MEMORY_TOKEN_LIMIT, MIN_MEMORY_TOKEN_LIMIT } from './limit';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { hasFilter, listFilters } from './filters/registry';
import { hasMessager, listMessagers } from './messagers/registry';
import { parseModelReference } from './models/reference';
import { parseLocalTools } from './tools/registry';
import { ApiToolDefinition, ApiToolSpec, LocalToolSpec } from './tools/interface';
import { parseApiTools } from './tools/api';

/** Configuration for a registered messager implementation. */
export interface MessagerSpec {
  /** Registered messager name, e.g. `wechat`. */
  name: string;
  /** Reply model reference in <provider>/<model id> format. */
  replier: string;
  /** Optional identity, tone, and conversational style for the replier. */
  persona?: string;
  /** Per-conversation budget shared by memory notes and confirmed replies. */
  memoryTokenLimit?: number;
  /** Sender ID authorized to query server status in a direct chat. */
  mainAccount?: string;
  /** Local names or { type } objects; omitted enables all four built-ins, [] disables them. */
  localTools?: readonly LocalToolSpec[];
  /** Hosted type strings or definition objects; omitted or [] disables hosted tools. */
  apiTools?: readonly ApiToolSpec[];
  /** Options passed to the messager factory. */
  options?: Readonly<Record<string, unknown>>;
}

/** Configuration for a registered filter implementation. */
export interface FilterSpec {
  /** Registered filter name, e.g. `ignore-sender`. */
  type: string;
  /** Required for type "model": <provider>/<model id>. */
  model?: string;
  /** Options passed to the filter factory. */
  options?: Readonly<Record<string, unknown>>;
}

/** Speech-to-text configuration for one chat pipeline. */
export interface SttSpec {
  type: 'model';
  /** Required speech-to-text model in <provider>/<model id> format. */
  model: string;
  /** Optional command using {input}/{output} filenames to convert audio to WAV before upload. */
  audioConversionCmd?: string;
}

/** Text-to-speech provider and speech-endpoint options for one chat pipeline. */
export interface TtsSpec {
  type: 'model';
  model: string;
  options?: Readonly<Record<string, unknown>>;
}

/**
 * One chat pipeline: a messager plus the filters applied to inbound messages.
 */
export interface ChatDefinition {
  /** Messager implementation receiving and sending messages. */
  messager: MessagerSpec;
  /** Optional speech-to-text configuration. Omit to ignore voice input. */
  stt?: SttSpec;
  /** Optional speech synthesis, used only for explicitly requested voice replies. */
  tts?: TtsSpec;
  /** Filters deciding whether a message should be replied to. */
  filters: readonly FilterSpec[];
}

/**
 * Structure of config.json, used to create the chat server.
 */
export interface ChatServerOptions {
  /** Chat pipelines served by this process. */
  chats: readonly ChatDefinition[];
}

/**
 * Values used when the config file does not specify an option.
 */
export const DEFAULT_CONFIG: ChatServerOptions = {
  chats: []
};

/**
 * Raised for malformed config files or invalid configuration values.
 */
export class ConfigError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * A config file plus the values that were resolved from it.
 */
export interface LoadedConfig {
  values: ChatServerOptions;
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
 * Normalizes filter fields from either a shorthand string or an object.
 */
function parseSpecFields(value: unknown, where: string): {
  type: string;
  options: Readonly<Record<string, unknown>>;
} {
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

  warnUnknownKeys(value, ['type', 'model', 'options'], where);

  if (typeof value.type !== 'string' || value.type.trim() === '') {
    throw new ConfigError(`${where}: "type" must be a non-empty string.`);
  }

  const options = value.options ?? {};
  if (!isPlainObject(options)) {
    throw new ConfigError(`${where}: "options" must be an object.`);
  }

  return { type: value.type.trim(), options };
}

/** Validates the syntax of a model reference without reading models.json. */
function modelReference(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConfigError(`${where} must be a non-empty <provider>/<model id> reference.`);
  }
  const reference = value.trim();
  try {
    parseModelReference(reference);
  } catch (error) {
    throw new ConfigError(`${where}: ${(error as Error).message}`);
  }
  return reference;
}

/** Parses the chat transport and its bound reply model. */
function parseMessagerSpec(value: unknown, where: string): MessagerSpec {
  if (!isPlainObject(value)) {
    throw new ConfigError(`${where} must be an object with "name", "replier", and optional "options".`);
  }
  if (Object.hasOwn(value, 'tools')) {
    throw new ConfigError(`${where}.tools has been replaced by localTools; rename it and use apiTools for provider-hosted tools.`);
  }
  warnUnknownKeys(value, ['name', 'replier', 'persona', 'memoryTokenLimit', 'mainAccount', 'localTools', 'apiTools', 'options'], where);
  if (typeof value.name !== 'string' || !value.name.trim()) {
    throw new ConfigError(`${where}: "name" must be a non-empty registered messager name.`);
  }
  const name = value.name.trim();
  if (value.persona !== undefined &&
    (typeof value.persona !== 'string' || !value.persona.trim())) {
    throw new ConfigError(`${where}.persona must be a non-empty string.`);
  }
  const persona = (value.persona as string | undefined)?.trim();
  const memoryTokenLimit = value.memoryTokenLimit;
  if (memoryTokenLimit !== undefined && (typeof memoryTokenLimit !== 'number' || !Number.isInteger(memoryTokenLimit) ||
    memoryTokenLimit < MIN_MEMORY_TOKEN_LIMIT || memoryTokenLimit > MAX_MEMORY_TOKEN_LIMIT)) {
    throw new ConfigError(`${where}.memoryTokenLimit must be an integer between ${MIN_MEMORY_TOKEN_LIMIT} and ${MAX_MEMORY_TOKEN_LIMIT}.`);
  }
  if (value.mainAccount !== undefined &&
    (typeof value.mainAccount !== 'string' || !value.mainAccount.trim())) {
    throw new ConfigError(`${where}.mainAccount must be a non-empty sender ID.`);
  }
  const mainAccount = (value.mainAccount as string | undefined)?.trim();
  if (!hasMessager(name)) {
    throw new ConfigError(
      `${where}: unknown messager "${name}". Available: ${listMessagers().join(', ')}.`
    );
  }
  const options = value.options ?? {};
  if (!isPlainObject(options)) {
    throw new ConfigError(`${where}: "options" must be an object.`);
  }
  let localTools: string[] | undefined;
  if (value.localTools !== undefined) {
    try {
      localTools = parseLocalTools(value.localTools);
    } catch (error) {
      throw new ConfigError(`${where}.${(error as Error).message}`);
    }
  }
  let apiTools: ApiToolDefinition[] | undefined;
  if (value.apiTools !== undefined) {
    try {
      apiTools = parseApiTools(value.apiTools);
    } catch (error) {
      throw new ConfigError(`${where}.${(error as Error).message}`);
    }
  }
  return { name, replier: modelReference(value.replier, `${where}.replier`), persona,
    memoryTokenLimit: memoryTokenLimit as number | undefined, mainAccount, options, localTools, apiTools };
}

/** Parses a filter specification and validates its registered name. */
function parseFilterSpec(value: unknown, where: string): FilterSpec {
  const filter = parseSpecFields(value, where);
  if (!hasFilter(filter.type)) {
    throw new ConfigError(
      `${where}: unknown filter "${filter.type}". ` +
        `Available: ${listFilters().join(', ')}.`
    );
  }
  if (filter.type === 'model') {
    return { ...filter, model: modelReference(isPlainObject(value) ? value.model : undefined, `${where}.model`) };
  }
  if (isPlainObject(value) && value.model !== undefined) {
    throw new ConfigError(`${where}: "model" is only supported for type "model".`);
  }
  return filter;
}

/** Validates the STT implementation, required model, and optional conversion command. */
function parseSttSpec(value: unknown, where: string): SttSpec {
  if (!isPlainObject(value)) {
    throw new ConfigError(`${where} must be an object with type "model"; replace old string STT references with { "type": "model", "model": "provider/model-id" }.`);
  }
  warnUnknownKeys(value, ['type', 'model', 'audioConversionCmd'], where);
  if (value.type !== 'model') {
    throw new ConfigError(`${where}.type must be "model".`);
  }
  const model = modelReference(value.model, `${where}.model`);
  if (value.audioConversionCmd !== undefined && (typeof value.audioConversionCmd !== 'string' ||
    !value.audioConversionCmd.trim() || !value.audioConversionCmd.includes('{input}') || !value.audioConversionCmd.includes('{output}'))) {
    throw new ConfigError(`${where}.audioConversionCmd must be a nonempty command containing {input} and {output}.`);
  }
  return { type: 'model', model, audioConversionCmd: (value.audioConversionCmd as string | undefined)?.trim() };
}

/** Keeps application-controlled speech fields out of provider-specific options. */
function parseTtsSpec(value: unknown, where: string): TtsSpec {
  if (!isPlainObject(value) || value.type !== 'model') {
    throw new ConfigError(`${where} must be an object with type "model".`);
  }
  warnUnknownKeys(value, ['type', 'model', 'options'], where);
  const model = modelReference(value.model, `${where}.model`);
  const options = value.options === undefined ? {} : value.options;
  if (!isPlainObject(options)) {
    throw new ConfigError(`${where}.options must be an object.`);
  }
  for (const key of ['model', 'input', 'response_format', 'stream_format']) {
    if (Object.hasOwn(options, key)) {
      throw new ConfigError(`${where}.options.${key} is controlled by ChatServer.`);
    }
  }
  return { type: 'model', model, options };
}

/**
 * Validates one entry of the `chats` array.
 */
function parseChat(value: unknown, index: number): ChatDefinition {
  const where = `chats[${index}]`;

  if (!isPlainObject(value)) {
    throw new ConfigError(`${where} must be an object.`);
  }

  warnUnknownKeys(value, ['messager', 'filters', 'stt', 'tts'], where);

  const messager = parseMessagerSpec(value.messager, `${where}.messager`);

  const filtersValue = value.filters ?? [];
  if (!Array.isArray(filtersValue)) {
    throw new ConfigError(`${where}: "filters" must be an array.`);
  }

  const filters = filtersValue.map((filterValue, filterIndex) =>
    parseFilterSpec(filterValue, `${where}.filters[${filterIndex}]`)
  );

  const stt = value.stt === undefined ? undefined : parseSttSpec(value.stt, `${where}.stt`);
  const tts = value.tts === undefined ? undefined : parseTtsSpec(value.tts, `${where}.tts`);
  return { messager, filters, stt, tts };
}

/**
 * Validates a parsed JSON value and merges it over the defaults.
 */
function validateConfig(input: unknown, configPath: string): ChatServerOptions {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ConfigError(`${configPath} must contain a JSON object.`);
  }

  const record = input as Record<string, unknown>;
  warnUnknownKeys(record, ['$schema', ...Object.keys(DEFAULT_CONFIG)], configPath);

  const config: ChatServerOptions = { ...DEFAULT_CONFIG };

  if (record.chats !== undefined) {
    if (!Array.isArray(record.chats)) {
      throw new ConfigError(`${configPath}: "chats" must be an array.`);
    }

    config.chats = record.chats.map((chat, index) => parseChat(chat, index));
  }

  return config;
}

/**
 * Reads and validates a config file.
 */
async function readConfigFile(configPath: string): Promise<ChatServerOptions> {
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

  const values = await readConfigFile(configPath);
  return { values, configPath, created };
}
