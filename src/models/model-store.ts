import { DEFAULT_MODEL_TIMEOUT_MS } from '../limit';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { resolveModelTimeoutMs } from './responses-client';

/**
 * Name of the file that holds model configurations inside the config folder.
 */
export const MODELS_FILE_NAME = 'models.json';

/**
 * One model served by a provider.
 *
 * API keys are never stored here. Each provider's key lives in the OS credential
 * manager under the provider name.
 */
export interface ModelEntry {
  /** Model identifier sent to the API, for example `gpt-4.1-mini`. */
  id: string;
  /** Name used to refer to this model on the command line. */
  name: string;
}

/**
 * A provider and the models it serves.
 */
export interface ProviderConfig {
  /** Provider name, also the credential manager account for its API key. */
  provider: string;
  /** Required API base URL for Responses (chat) or audio/transcriptions (STT). */
  baseUrl: string;
  /** Timeout for this provider's model requests and tool cycles; defaults to 180000 ms. */
  timeoutMs?: number;
  /** Models available from this provider. */
  models: ModelEntry[];
}

/**
 * Contents of `models.json`.
 */
export interface ModelsFile {
  /** Optional editor schema reference, preserved when the CLI saves this file. */
  $schema?: string;
  version: 1;
  providers: ProviderConfig[];
}

/**
 * Raised when `models.json` is malformed.
 */
export class ModelStoreError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ModelStoreError';
  }
}

/**
 * Returns the path of `models.json` inside a config folder.
 */
export function getModelsPath(configDir: string): string {
  return path.join(configDir, MODELS_FILE_NAME);
}

/**
 * Returns true for plain JSON objects (not null, arrays, or primitives).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates one model entry.
 */
function parseModelEntry(value: unknown, where: string, seen: Set<string>): ModelEntry {
  if (!isPlainObject(value)) {
    throw new ModelStoreError(`${where} must be an object.`);
  }

  if (typeof value.id !== 'string' || value.id.trim() === '') {
    throw new ModelStoreError(`${where}: "id" must be a non-empty string.`);
  }

  const id = value.id.trim();
  const name = value.name ?? id;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new ModelStoreError(`${where}: "name" must be a non-empty string.`);
  }

  const entry: ModelEntry = { id, name: name.trim() };
  if (seen.has(entry.name)) {
    throw new ModelStoreError(`${where}: duplicate model name "${entry.name}".`);
  }
  seen.add(entry.name);

  return entry;
}

/**
 * Validates one provider entry.
 */
function parseProvider(value: unknown, index: number, modelsPath: string): ProviderConfig {
  const where = `${modelsPath}: providers[${index}]`;

  if (!isPlainObject(value)) {
    throw new ModelStoreError(`${where} must be an object.`);
  }

  if (typeof value.provider !== 'string' || value.provider.trim() === '') {
    throw new ModelStoreError(`${where}: "provider" must be a non-empty string.`);
  }

  const baseUrl = value.baseUrl;
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new ModelStoreError(`${where}: "baseUrl" must be a non-empty string.`);
  }

  if (!Array.isArray(value.models)) {
    throw new ModelStoreError(`${where}: "models" must be an array.`);
  }

  let timeoutMs: number;
  try {
    timeoutMs = resolveModelTimeoutMs(value.timeoutMs);
  } catch (error) {
    throw new ModelStoreError(`${where}: "timeoutMs": ${(error as Error).message}`);
  }

  const seen = new Set<string>();
  return {
    provider: value.provider.trim(),
    baseUrl: baseUrl.trim(),
    timeoutMs,
    models: value.models.map((model, modelIndex) =>
      parseModelEntry(model, `${where}.models[${modelIndex}]`, seen)
    )
  };
}

/**
 * Reads `models.json`, returning an empty list when the file does not exist.
 */
export async function loadModels(configDir: string): Promise<ModelsFile> {
  const modelsPath = getModelsPath(configDir);

  let contents: string;
  try {
    contents = await fsp.readFile(modelsPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, providers: [] };
    }
    throw new ModelStoreError(`Unable to read ${modelsPath}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new ModelStoreError(`Invalid JSON in ${modelsPath}: ${(error as Error).message}`);
  }

  if (!isPlainObject(parsed) || !Array.isArray(parsed.providers)) {
    throw new ModelStoreError(`${modelsPath} must contain an object with a "providers" array.`);
  }

  if (parsed.$schema !== undefined && typeof parsed.$schema !== 'string') {
    throw new ModelStoreError(`${modelsPath}: "$schema" must be a string.`);
  }

  const seen = new Set<string>();
  const providers = parsed.providers.map((provider, index) => {
    const config = parseProvider(provider, index, modelsPath);
    if (seen.has(config.provider)) {
      throw new ModelStoreError(
        `${modelsPath}: duplicate provider name "${config.provider}".`
      );
    }
    seen.add(config.provider);
    return config;
  });

  return { ...(parsed.$schema === undefined ? {} : { $schema: parsed.$schema }), version: 1, providers };
}

/**
 * Writes `models.json`, creating the config folder when needed.
 *
 * Returns the file path that was written.
 */
export async function saveModels(configDir: string, file: ModelsFile): Promise<string> {
  const modelsPath = getModelsPath(configDir);
  const payload: ModelsFile = {
    ...(file.$schema === undefined ? {} : { $schema: file.$schema }),
    version: 1,
    providers: file.providers
  };

  try {
    await fsp.mkdir(configDir, { recursive: true });
    await fsp.writeFile(modelsPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch (error) {
    throw new ModelStoreError(`Unable to write ${modelsPath}: ${(error as Error).message}`);
  }

  return modelsPath;
}

/**
 * Finds a provider by name.
 */
export function findProvider(file: ModelsFile, provider: string): ProviderConfig | undefined {
  return file.providers.find((entry) => entry.provider === provider);
}

/**
 * Returns the provider, creating it when missing.
 */
export function ensureProvider(
  file: ModelsFile,
  provider: string,
  baseUrl: string
): ProviderConfig {
  const existing = findProvider(file, provider);
  if (existing !== undefined) {
    return existing;
  }

  if (!baseUrl.trim()) {
    throw new ModelStoreError('A non-empty baseUrl is required to create a provider.');
  }
  const created: ProviderConfig = { provider, baseUrl: baseUrl.trim(), timeoutMs: DEFAULT_MODEL_TIMEOUT_MS, models: [] };
  file.providers.push(created);
  return created;
}

/**
 * Removes a provider by name. Returns true when an entry was removed.
 */
export function removeProvider(file: ModelsFile, provider: string): boolean {
  const index = file.providers.findIndex((entry) => entry.provider === provider);
  if (index === -1) {
    return false;
  }
  file.providers.splice(index, 1);
  return true;
}

/**
 * Finds a model within a provider.
 */
export function findModel(provider: ProviderConfig, name: string): ModelEntry | undefined {
  return provider.models.find((model) => model.name === name);
}

/**
 * Adds a model or replaces the entry with the same name.
 */
export function upsertModel(provider: ProviderConfig, model: ModelEntry): void {
  const index = provider.models.findIndex((candidate) => candidate.name === model.name);
  if (index === -1) {
    provider.models.push(model);
    return;
  }
  provider.models[index] = model;
}

/**
 * Removes a model by name. Returns true when an entry was removed.
 */
export function removeModel(provider: ProviderConfig, name: string): boolean {
  const index = provider.models.findIndex((candidate) => candidate.name === name);
  if (index === -1) {
    return false;
  }
  provider.models.splice(index, 1);
  return true;
}
