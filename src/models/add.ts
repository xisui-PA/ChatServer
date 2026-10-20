import { DEFAULT_MODEL_TIMEOUT_MS } from '../limit';
import { createCredentialStore } from './credentials';
import { CliError, hasFlag, optionalValue, promptLine, resolveConfigDir } from './cli-support';
import { modelTimeoutOption, newApiKey, parseCommandOptions } from './command-support';
import { setupBaseUrl, setupInteractive, setupModelId, setupPrompt, setupProvider, setupValue } from './setup';
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
export const ADD_HELP = `Usage: chatserver-models add [options]

Adds a model to a provider in models.json and stores the provider's API key in the OS
credential manager. The provider is created when it does not exist yet.
Run without options for guided setup. Missing provider/model details are prompted
in a terminal; available model IDs are fetched from the provider when possible.

Options:
  --provider <name>      Provider name, also the credential account
  --model <id>           Model identifier sent to the API
  --name <name>          Name used to refer to the model (default: the model id)
  --base-url <url>       OpenAI-compatible base URL (required for new providers)
  --api-key <key>        API key to store for the provider
  --timeout <ms>         Provider model timeout (default: ${DEFAULT_MODEL_TIMEOUT_MS} for new providers)
  --config_dir <dir>     Config folder
  --force                Overwrite an existing model without asking
  -i, --interactive      Prompt for the optional model name too
  -h, --help             Show this help

When the provider has no stored key, the API key is read from --api-key,
OPENAI_API_KEY, or an interactive prompt, in that order. It is never written to
models.json.
Without a terminal, pass --provider and --model, plus --base-url for new providers.
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
    booleanFlags: { '--force': 'force', '--interactive': 'interactive', '-i': 'interactive' }
  });

  if (hasFlag(cli, 'help')) {
    console.log(ADD_HELP);
    return;
  }

  const configDir = resolveConfigDir(optionalValue(cli, 'configDir'));
  const guided = setupInteractive(cli, optionalValue(cli, 'provider') === undefined || optionalValue(cli, 'model') === undefined);
  const suppliedId = setupValue(cli, 'model', '--model');
  const suppliedName = setupValue(cli, 'name', '--name');
  const suppliedKey = setupValue(cli, 'apiKey', '--api-key');
  const urlValue = setupValue(cli, 'baseUrl', '--base-url');
  let baseUrl = urlValue === undefined ? undefined : setupBaseUrl(urlValue);
  const timeoutValue = optionalValue(cli, 'timeout');
  const timeoutMs = timeoutValue === undefined ? undefined : modelTimeoutOption(timeoutValue);
  const file = await loadModels(configDir);
  const providerName = await setupProvider(file, cli, true);
  if (providerName.includes('/')) {
    throw new CliError('Provider names cannot contain / because config references use provider/model-id.');
  }
  if (suppliedId === undefined && !process.stdin.isTTY) {
    throw new CliError('--model is required without a terminal.');
  }

  const existingProvider = findProvider(file, providerName);
  if (existingProvider === undefined && baseUrl === undefined) {
    if (!process.stdin.isTTY) {
      throw new CliError('--base-url is required when creating a provider.');
    }
    baseUrl = await setupPrompt('API base URL (for example http://host.local:1234/v1)', undefined, setupBaseUrl);
  }
  const provider = existingProvider ?? ensureProvider(file, providerName, baseUrl ?? '');

  if (existingProvider !== undefined && baseUrl !== undefined) {
    provider.baseUrl = baseUrl;
  }
  if (timeoutMs !== undefined) {
    provider.timeoutMs = timeoutMs;
  }

  // Reuse the provider's saved key. An unrelated OPENAI_API_KEY must not rotate it.
  const credentials = createCredentialStore();
  const storedKey = suppliedKey === undefined ? await credentials.get(providerName) : undefined;
  const needsKey = suppliedKey !== undefined || !storedKey;
  const apiKey = suppliedKey ?? (storedKey || await newApiKey(cli, providerName));
  const modelId = suppliedId ?? await setupModelId(provider, apiKey);
  const name = suppliedName ?? (guided ? await setupPrompt('Model name', modelId) : modelId);

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

  if (needsKey) {
    await credentials.set(providerName, apiKey);
    console.log(`API key stored in the ${credentials.name} (account: "${providerName}").`);
  }

  upsertModel(provider, { id: modelId, name });
  const modelsPath = await saveModels(configDir, file);

  console.log(`Saved model "${name}" (${modelId}) to ${modelsPath}.`);
  console.log(`Config reference: ${providerName}/${modelId}`);
  console.log(`Test it with: chatserver-models test --provider "${providerName}" --name "${name}" --config_dir "${configDir}"`);
}
