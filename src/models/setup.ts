import { CliError, CommandLine, hasFlag, optionalValue, promptLine } from './cli-support';
import { ModelsFile, ProviderConfig } from './model-store';

/** Reads an optional nonempty, trimmed command-line value. */
export function setupValue(cli: CommandLine, key: string, flag: string): string | undefined {
  const value = optionalValue(cli, key)?.trim();
  if (value === '') {
    throw new CliError(`${flag} must not be empty.`);
  }
  return value;
}

/** Validates a provider endpoint before prompting for or saving credentials. */
export function setupBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError('Base URL must be an absolute http:// or https:// URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new CliError('Base URL must use HTTP(S), without credentials, a query, or a fragment.');
  }
  if (/\/responses\/?$/.test(url.pathname)) {
    throw new CliError('Use the API base URL, without the trailing /responses.');
  }
  return value.trim().replace(/\/+$/, '');
}

/** Requires a terminal for guided setup, keeping scripts from hanging on prompts. */
export function requireSetupTerminal(): void {
  if (!process.stdin.isTTY) {
    throw new CliError('Guided setup requires a terminal. Supply the command options instead.');
  }
}

/** Prompts with an optional current value and retries invalid input. */
export async function setupPrompt(
  label: string,
  fallback?: string,
  validate: (value: string) => string = (value) => {
    if (!value) {
      throw new CliError('A value is required.');
    }
    return value;
  }
): Promise<string> {
  requireSetupTerminal();
  for (;;) {
    const value = (await promptLine(`${label}${fallback === undefined ? '' : ` [${fallback}]`}: `)).trim() || fallback || '';
    try {
      return validate(value);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}

/** Selects a numbered item or, when allowed, accepts a new name/ID directly. */
export async function setupChoice(
  label: string,
  choices: readonly { value: string; label: string; name?: string }[],
  allowCustom = false
): Promise<string> {
  requireSetupTerminal();
  const shown = allowCustom ? choices.slice(0, 30) : choices;
  shown.forEach((choice, index) => console.log(`  ${index + 1}. ${choice.label}`));
  if (choices.length > shown.length) {
    console.log(`Showing ${shown.length} of ${choices.length}; enter an exact name/ID for another choice.`);
  }
  return setupPrompt(`${label}${allowCustom ? ' (number or name/ID)' : ' (number or name)'}`, allowCustom ? undefined : '1', (value) => {
    // Exact names win over numbered shortcuts (including numeric model IDs).
    const exact = choices.find((choice) => choice.value === value || choice.name === value);
    if (exact !== undefined) {
      return exact.value;
    }
    const index = /^[1-9]\d*$/.test(value) ? Number(value) - 1 : -1;
    if (shown[index] !== undefined) {
      return shown[index].value;
    }
    if (allowCustom && value) {
      return value;
    }
    throw new CliError('Choose a listed number or name.');
  });
}

/** Resolves a supplied provider or offers configured providers and a new-name entry. */
export async function setupProvider(file: ModelsFile, cli: CommandLine, allowNew: boolean): Promise<string> {
  const supplied = setupValue(cli, 'provider', '--provider');
  if (supplied !== undefined) {
    return supplied;
  }
  if (!process.stdin.isTTY) {
    throw new CliError('--provider is required without a terminal.');
  }
  if (!allowNew && file.providers.length === 0) {
    throw new CliError('No providers configured. Run chatserver-models add first.');
  }
  return setupChoice(allowNew ? 'Choose a provider or enter a new provider name' : 'Provider',
    file.providers.map((provider) => ({ value: provider.provider, label: `${provider.provider} (${provider.baseUrl})` })), allowNew);
}

/** Enables the editor explicitly or when a terminal command has no edits yet. */
export function setupInteractive(cli: CommandLine, missing: boolean): boolean {
  if (hasFlag(cli, 'interactive')) {
    requireSetupTerminal();
    return true;
  }
  return Boolean(process.stdin.isTTY) && missing;
}

/** Offers the provider's advertised models, falling back to a manually entered ID. */
export async function setupModelId(provider: ProviderConfig, apiKey: string): Promise<string> {
  requireSetupTerminal();
  console.log(`Looking up models at ${provider.baseUrl}...`);
  let ids: string[];
  try {
    const response = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(Math.min(provider.timeoutMs ?? 180_000, 10_000)),
      redirect: 'error'
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('data' in body) || !Array.isArray(body.data)) {
      throw new Error('Unsupported model list');
    }
    ids = [...new Set(body.data.flatMap((model: unknown) =>
      typeof model === 'object' && model !== null && 'id' in model && typeof model.id === 'string' && model.id.trim()
        ? [model.id.trim()] : []))].sort();
  } catch {
    console.log('Could not list models from this provider. Enter the model ID manually.');
    return setupPrompt('Model ID');
  }
  if (ids.length === 0) {
    return setupPrompt('Model ID');
  }
  return setupChoice('Model', ids.map((id) => ({ value: id, label: id })), true);
}
