import { getModelApiKey } from './credentials';
import {
  CliError,
  CommandLine,
  CommandLineSpec,
  optionalValue,
  parseCommandLine,
  promptHidden
} from './cli-support';
import { findModel, findProvider, getModelsPath, loadModels, ModelEntry, ModelsFile, ProviderConfig } from './model-store';
import { DEFAULT_MODEL_TIMEOUT_MS, resolveModelTimeoutMs } from './responses-client';

/**
 * Default prompt used by `test` when --prompt is not supplied.
 */
export const DEFAULT_PROMPT = 'Say hello in one short sentence.';

/**
 * Default request timeout in milliseconds.
 */
export const DEFAULT_TIMEOUT_MS = DEFAULT_MODEL_TIMEOUT_MS;

const COMMON_VALUE_FLAGS: Record<string, string> = {
  '--config_dir': 'configDir',
  '--config-dir': 'configDir',
  '-c': 'configDir'
};

const COMMON_BOOLEAN_FLAGS: Record<string, string> = {
  '-h': 'help',
  '--help': 'help'
};

/**
 * Parses options for one command, merging in the shared flags.
 */
export function parseCommandOptions(argv: string[], spec: CommandLineSpec): CommandLine {
  return parseCommandLine(argv, {
    valueFlags: { ...COMMON_VALUE_FLAGS, ...spec.valueFlags },
    booleanFlags: { ...COMMON_BOOLEAN_FLAGS, ...spec.booleanFlags }
  });
}

/**
 * Looks up a provider or fails with the available names.
 */
export async function requireProvider(
  configDir: string,
  name: string
): Promise<{ file: ModelsFile; provider: ProviderConfig }> {
  const file = await loadModels(configDir);
  const provider = findProvider(file, name);
  if (provider === undefined) {
    const available = file.providers.map((entry) => entry.provider).join(', ') || '(none)';
    throw new CliError(
      `Provider "${name}" not found in ${getModelsPath(configDir)}. Available: ${available}.`
    );
  }
  return { file, provider };
}

/**
 * Looks up a model within a provider or fails with the available names.
 */
export function requireModel(provider: ProviderConfig, name: string): ModelEntry {
  const model = findModel(provider, name);
  if (model === undefined) {
    const available = provider.models.map((entry) => entry.name).join(', ') || '(none)';
    throw new CliError(
      `Model "${name}" not found for provider "${provider.provider}". Available: ${available}.`
    );
  }
  return model;
}

/**
 * Reads the CLI timeout using the same validation as models.json and HTTP calls.
 */
export function modelTimeoutOption(
  value: string | undefined,
  fallback: number = DEFAULT_TIMEOUT_MS
): number {
  try {
    return resolveModelTimeoutMs(value === undefined ? fallback : Number(value));
  } catch (error) {
    throw new CliError(`--timeout: ${(error as Error).message}`);
  }
}

/**
 * Reads a new API key from the command line, the environment, or a prompt.
 */
export async function newApiKey(cli: CommandLine, provider: string): Promise<string> {
  const fromOption = optionalValue(cli, 'apiKey');
  if (fromOption !== undefined && fromOption !== '') {
    return fromOption;
  }

  const fromEnvironment = process.env.OPENAI_API_KEY;
  if (fromEnvironment !== undefined && fromEnvironment !== '') {
    return fromEnvironment;
  }

  const value = await promptHidden(`API key for provider "${provider}": `);
  if (value === '') {
    throw new CliError('An API key is required.');
  }
  return value;
}

/**
 * Finds the API key used to call a provider's models.
 */
export async function existingApiKey(provider: ProviderConfig): Promise<string> {
  return getModelApiKey(provider.provider);
}
