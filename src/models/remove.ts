import { createCredentialStore } from './credentials';
import { hasFlag, optionalValue, requireValue, resolveConfigDir } from './cli-support';
import { parseCommandOptions, requireModel, requireProvider } from './command-support';
import { removeModel, removeProvider, saveModels } from './model-store';

/**
 * Help text for `chatserver-models remove`.
 */
export const REMOVE_HELP = `Usage: chatserver-models remove --provider <name> --name <name> [options]

Removes a model. When it was the provider's last model, the provider entry is removed
too and its API key is deleted from the credential manager.

Options:
  --provider <name>    Provider name (required)
  --name <name>        Model name to remove (required)
  --config_dir <dir>   Config folder
  -h, --help           Show this help
`;

/**
 * Removes a model, and its provider once the provider has no models left.
 */
export async function runRemove(argv: string[]): Promise<void> {
  const cli = parseCommandOptions(argv, {
    valueFlags: { '--provider': 'provider', '--name': 'name' },
    booleanFlags: {}
  });

  if (hasFlag(cli, 'help')) {
    console.log(REMOVE_HELP);
    return;
  }

  const configDir = resolveConfigDir(optionalValue(cli, 'configDir'));
  const providerName = requireValue(cli, 'provider', '--provider');
  const name = requireValue(cli, 'name', '--name');
  const { file, provider } = await requireProvider(configDir, providerName);

  requireModel(provider, name);
  removeModel(provider, name);

  const providerRemoved = provider.models.length === 0;
  if (providerRemoved) {
    removeProvider(file, providerName);
  }

  const modelsPath = await saveModels(configDir, file);
  console.log(`Removed model "${name}" from provider "${providerName}" in ${modelsPath}.`);

  if (providerRemoved) {
    console.log(`Provider "${providerName}" had no models left and was removed.`);
    const credentials = createCredentialStore();
    await credentials.delete(providerName);
    console.log(`Removed API key from the ${credentials.name} (account: "${providerName}").`);
  }
}
