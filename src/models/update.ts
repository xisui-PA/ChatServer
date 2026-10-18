import { createCredentialStore } from './credentials';
import { CliError, hasFlag, optionalValue, requireValue, resolveConfigDir } from './cli-support';
import { parseCommandOptions, requireModel, requireProvider } from './command-support';
import { findModel, saveModels } from './model-store';

/**
 * Help text for `chatserver-models update`.
 */
export const UPDATE_HELP = `Usage: chatserver-models update --provider <name> [options]

Updates a provider or one of its models. Only the options you pass are changed.

Options:
  --provider <name>      Provider name (required)
  --base-url <url>       New OpenAI-compatible base URL for the provider
  --api-key <key>        Replace the provider's stored API key
  --name <name>          Model name to update
  --model <id>           New model identifier for --name
  --new-name <name>      Rename the model given by --name
  --config_dir <dir>     Config folder
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
      '--api-key': 'apiKey',
      '--name': 'name',
      '--model': 'model',
      '--new-name': 'newName'
    },
    booleanFlags: {}
  });

  if (hasFlag(cli, 'help')) {
    console.log(UPDATE_HELP);
    return;
  }

  const configDir = resolveConfigDir(optionalValue(cli, 'configDir'));
  const providerName = requireValue(cli, 'provider', '--provider');
  const { file, provider } = await requireProvider(configDir, providerName);

  const newBaseUrl = optionalValue(cli, 'baseUrl');
  const apiKey = optionalValue(cli, 'apiKey');
  const modelName = optionalValue(cli, 'name');
  const newModelId = optionalValue(cli, 'model');
  const newName = optionalValue(cli, 'newName');

  const hasModelChanges = modelName !== undefined ||
    newModelId !== undefined || newName !== undefined;
  const hasChanges = newBaseUrl !== undefined || apiKey !== undefined || hasModelChanges;
  if (!hasChanges) {
    throw new CliError(
      'Nothing to update. Pass --base-url, --api-key, or --name with --model/--new-name.'
    );
  }

  if (newBaseUrl !== undefined) {
    if (newBaseUrl === '') {
      throw new CliError('--base-url must not be empty.');
    }
    provider.baseUrl = newBaseUrl;
  }

  if (apiKey !== undefined) {
    if (apiKey === '') {
      throw new CliError('--api-key must not be empty.');
    }
    const credentials = createCredentialStore();
    await credentials.set(provider.provider, apiKey);
    console.log(`API key updated in the ${credentials.name} (account: "${provider.provider}").`);
  }

  if (hasModelChanges) {
    if (modelName === undefined) {
      throw new CliError('--name is required to update or rename a model.');
    }

    const model = requireModel(provider, modelName);

    if (newModelId !== undefined) {
      if (newModelId === '') {
        throw new CliError('--model must not be empty.');
      }
      model.id = newModelId;
    }

    if (newName !== undefined) {
      if (newName === '') {
        throw new CliError('--new-name must not be empty.');
      }
      if (newName !== modelName && findModel(provider, newName) !== undefined) {
        throw new CliError(`Model "${newName}" already exists for provider "${provider.provider}".`);
      }
      model.name = newName;
    }
  }

  const modelsPath = await saveModels(configDir, file);
  console.log(`Updated provider "${providerName}" in ${modelsPath}.`);
}
