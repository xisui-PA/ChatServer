import { createCredentialStore } from './credentials';
import { CliError, hasFlag, optionalValue, promptHidden, resolveConfigDir } from './cli-support';
import { DEFAULT_TIMEOUT_MS, modelTimeoutOption, parseCommandOptions, requireModel, requireProvider } from './command-support';
import { findModel, loadModels, saveModels } from './model-store';
import { setupBaseUrl, setupChoice, setupInteractive, setupPrompt, setupProvider, setupValue } from './setup';

/**
 * Help text for `chatserver-models update`.
 */
export const UPDATE_HELP = `Usage: chatserver-models update [options]

Updates a provider or one of its models. Only the options you pass are changed.
Run without edits for a guided editor. Press Enter to keep current values.

Options:
  --provider <name>      Provider name (prompted in a terminal if omitted)
  --base-url <url>       New OpenAI-compatible base URL for the provider
  --timeout <ms>         New model timeout for all models from the provider
  --api-key <key>        Replace the provider's stored API key
  --name <name>          Model name to update
  --model <id>           New model identifier for --name
  --new-name <name>      Rename the model given by --name
  --config_dir <dir>     Config folder
  -i, --interactive      Open the guided editor even when edits are supplied
  -h, --help             Show this help
`;

/**
 * Updates provider or model details, and optionally the provider's API key.
 */
export async function runUpdate(argv: string[]): Promise<void> {
  const cli = parseCommandOptions(argv, {
    valueFlags: {
      '--provider': 'provider',
      '--base-url': 'baseUrl',
      '--timeout': 'timeout',
      '--api-key': 'apiKey',
      '--name': 'name',
      '--model': 'model',
      '--new-name': 'newName'
    },
    booleanFlags: { '--interactive': 'interactive', '-i': 'interactive' }
  });

  if (hasFlag(cli, 'help')) {
    console.log(UPDATE_HELP);
    return;
  }

  const configDir = resolveConfigDir(optionalValue(cli, 'configDir'));
  let newBaseUrl = setupValue(cli, 'baseUrl', '--base-url');
  if (newBaseUrl !== undefined) {
    newBaseUrl = setupBaseUrl(newBaseUrl);
  }
  const timeoutValue = optionalValue(cli, 'timeout');
  let timeoutMs = timeoutValue === undefined ? undefined : modelTimeoutOption(timeoutValue);
  let apiKey = setupValue(cli, 'apiKey', '--api-key');
  let modelName = setupValue(cli, 'name', '--name');
  let newModelId = setupValue(cli, 'model', '--model');
  let newName = setupValue(cli, 'newName', '--new-name');
  const hasEdits = newBaseUrl !== undefined || timeoutMs !== undefined || apiKey !== undefined ||
    newModelId !== undefined || newName !== undefined;
  const guided = setupInteractive(cli, !hasEdits);
  const providerName = await setupProvider(await loadModels(configDir), cli, false);
  const { file, provider } = await requireProvider(configDir, providerName);

  if (!guided && !hasEdits) {
    throw new CliError(
      'Nothing to update. Pass --base-url, --timeout, --api-key, or --name with --model/--new-name.'
    );
  }

  let editProvider = false;
  if (guided && modelName === undefined && newModelId === undefined && newName === undefined) {
    const target = await setupChoice('Update', [
      { value: 'provider', label: 'Provider settings (URL, timeout, API key)' },
      ...provider.models.map((model) => ({ value: `model:${model.name}`, name: model.name, label: `${model.name} (${model.id})` }))
    ]);
    editProvider = target === 'provider';
    if (!editProvider) {
      modelName = target.slice('model:'.length);
    }
  }
  if (modelName === undefined && (newModelId !== undefined || newName !== undefined)) {
    if (!process.stdin.isTTY) {
      throw new CliError('--name is required to update or rename a model.');
    }
    if (provider.models.length === 0) {
      throw new CliError('This provider has no models. Run chatserver-models add first.');
    }
    modelName = await setupChoice('Model', provider.models.map((model) => ({ value: model.name, label: `${model.name} (${model.id})` })));
  }

  const model = modelName === undefined ? undefined : requireModel(provider, modelName);
  if (guided && model !== undefined) {
    newModelId ??= await setupPrompt('Model ID', model.id);
    newName ??= await setupPrompt('Model name', model.name);
  }
  if (editProvider) {
    newBaseUrl ??= await setupPrompt('API base URL', provider.baseUrl, setupBaseUrl);
    const currentTimeout = provider.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    timeoutMs ??= Number(await setupPrompt('Timeout (ms)', String(currentTimeout), (value) => String(modelTimeoutOption(value))));
    if (apiKey === undefined) {
      apiKey = (await promptHidden('New API key (Enter to keep current): ')).trim() || undefined;
    }
  }

  // Validate every edit before changing either the credential manager or models.json.
  if (newName !== undefined && newName !== model?.name && findModel(provider, newName) !== undefined) {
    throw new CliError(`Model "${newName}" already exists for provider "${provider.provider}".`);
  }
  const changed = newBaseUrl !== undefined && newBaseUrl !== provider.baseUrl ||
    timeoutMs !== undefined && timeoutMs !== provider.timeoutMs || apiKey !== undefined ||
    model !== undefined && (newModelId !== undefined && newModelId !== model.id || newName !== undefined && newName !== model.name);
  if (!changed) {
    console.log('No changes.');
    return;
  }

  if (newBaseUrl !== undefined) {
    provider.baseUrl = newBaseUrl;
  }
  if (timeoutMs !== undefined) {
    provider.timeoutMs = timeoutMs;
  }

  if (apiKey !== undefined) {
    const credentials = createCredentialStore();
    await credentials.set(provider.provider, apiKey);
    console.log(`API key updated in the ${credentials.name} (account: "${provider.provider}").`);
  }

  const previousId = model?.id;
  if (model !== undefined) {
    if (newModelId !== undefined) {
      model.id = newModelId;
    }

    if (newName !== undefined) {
      model.name = newName;
    }
  }

  const modelsPath = await saveModels(configDir, file);
  console.log(`Updated provider "${providerName}" in ${modelsPath}.`);
  if (model !== undefined) {
    console.log(`Config reference: ${providerName}/${model.id}`);
    if (previousId !== model.id) {
      console.log(`Update config.json references from ${providerName}/${previousId} to ${providerName}/${model.id}.`);
    }
  }
}
