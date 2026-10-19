import { createCredentialStore } from './credentials';
import { CliError, hasFlag, optionalValue, promptLine, requireValue, resolveConfigDir } from './cli-support';
import { DEFAULT_TIMEOUT_MS, modelTimeoutOption, newApiKey, parseCommandOptions } from './command-support';
import {
  ensureProvider,
  findModel,
  findProvider,
  loadModels,
  saveModels,
  upsertModel
} from './model-store';

/**
 * Help text for `chatserver-models add`.
 */
export const ADD_HELP = `Usage: chatserver-models add --provider <name> --model <id> [options]

Adds a model to a provider in models.json and stores the provider's API key in the OS
credential manager. The provider is created when it does not exist yet.

Options:
  --provider <name>      Provider name, also the credential account (required)
  --model <id>           Model identifier sent to the API (required)
  --name <name>          Name used to refer to the model (default: the model id)
  --base-url <url>       OpenAI-compatible base URL (required for new providers)
  --api-key <key>        API key to store for the provider
  --timeout <ms>         Provider model timeout (default: ${DEFAULT_TIMEOUT_MS} for new providers)
  --config_dir <dir>     Config folder
  --force                Overwrite an existing model without asking
  -h, --help             Show this help

When the provider has no stored key, the API key is read from --api-key,
OPENAI_API_KEY, or an interactive prompt, in that order. It is never written to
models.json.
`;

/**
 * Adds a model to a provider, creating the provider when needed.
 */
export async function runAdd(argv: string[]): Promise<void> {
  const cli = parseCommandOptions(argv, {
    valueFlags: {
      '--provider': 'provider',
      '--name': 'name',
      '--model': 'model',
      '--base-url': 'baseUrl',
      '--api-key': 'apiKey',
      '--timeout': 'timeout'
    },
    booleanFlags: { '--force': 'force' }
  });

  if (hasFlag(cli, 'help')) {
    console.log(ADD_HELP);
    return;
  }

  const configDir = resolveConfigDir(optionalValue(cli, 'configDir'));
  const providerName = requireValue(cli, 'provider', '--provider');
  const modelId = requireValue(cli, 'model', '--model');
  const name = optionalValue(cli, 'name') ?? modelId;
  const baseUrl = optionalValue(cli, 'baseUrl')?.trim();
  if (baseUrl === '') {
    throw new CliError('--base-url must not be empty.');
  }
  const timeoutValue = optionalValue(cli, 'timeout');
  const timeoutMs = timeoutValue === undefined ? undefined : modelTimeoutOption(timeoutValue);
  const file = await loadModels(configDir);

  const existingProvider = findProvider(file, providerName);
  if (existingProvider === undefined && baseUrl === undefined) {
    throw new CliError('--base-url is required when creating a provider.');
  }
  const provider =
    existingProvider ?? ensureProvider(file, providerName, requireValue(cli, 'baseUrl', '--base-url'));

  if (existingProvider !== undefined && baseUrl !== undefined) {
    provider.baseUrl = baseUrl;
  }
  if (timeoutMs !== undefined) {
    provider.timeoutMs = timeoutMs;
  }

  if (findModel(provider, name) !== undefined && !hasFlag(cli, 'force')) {
    if (!process.stdin.isTTY) {
      throw new CliError(`Model "${name}" already exists. Re-run with --force to overwrite it.`);
    }
    const answer = await promptLine(`Model "${name}" already exists. Overwrite? [y/N] `);
    if (!/^y(es)?$/i.test(answer)) {
      console.log('Cancelled.');
      return;
    }
  }

  // The key belongs to the provider, so it is only requested when one is missing
  // or when --api-key / OPENAI_API_KEY was supplied.
  const credentials = createCredentialStore();
  const providedKey = optionalValue(cli, 'apiKey') ?? process.env.OPENAI_API_KEY;
  const storedKey = await credentials.get(providerName);
  const needsKey = providedKey !== undefined && providedKey !== '' ||
    storedKey === undefined || storedKey === '';

  if (needsKey) {
    const apiKey = await newApiKey(cli, providerName);
    await credentials.set(providerName, apiKey);
    console.log(`API key stored in the ${credentials.name} (account: "${providerName}").`);
  }

  upsertModel(provider, { id: modelId, name });
  const modelsPath = await saveModels(configDir, file);

  console.log(`Saved model "${name}" (${modelId}) to ${modelsPath}.`);
  console.log(`Test it with: chatserver-models test --provider "${providerName}" --name "${name}"`);
}
