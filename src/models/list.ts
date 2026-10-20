import { DEFAULT_MODEL_TIMEOUT_MS } from '../limit';
import { hasFlag, optionalValue, resolveConfigDir } from './cli-support';
import { parseCommandOptions } from './command-support';
import { getModelsPath, loadModels } from './model-store';

/**
 * Column widths used by `list` output.
 */
const PROVIDER_COLUMN_WIDTH = 16;
const NAME_COLUMN_WIDTH = 20;
const MODEL_ID_COLUMN_WIDTH = 24;
const TIMEOUT_COLUMN_WIDTH = 14;

/**
 * Help text for `chatserver-models list`.
 */
export const LIST_HELP = `Usage: chatserver-models list [options]

Lists the providers and models in models.json. API keys are not printed.

Options:
  --json               Print the configuration as JSON
  --config_dir <dir>   Config folder
  -h, --help           Show this help
`;

/**
 * Prints the configured providers and models.
 */
export async function runList(argv: string[]): Promise<void> {
  const cli = parseCommandOptions(argv, { valueFlags: {}, booleanFlags: { '--json': 'json' } });

  if (hasFlag(cli, 'help')) {
    console.log(LIST_HELP);
    return;
  }

  const configDir = resolveConfigDir(optionalValue(cli, 'configDir'));
  const file = await loadModels(configDir);

  if (hasFlag(cli, 'json')) {
    console.log(JSON.stringify(file, null, 2));
    return;
  }

  if (file.providers.length === 0) {
    console.log(`No providers configured in ${getModelsPath(configDir)}.`);
    return;
  }

  console.log(`Providers in ${getModelsPath(configDir)}:`);
  console.log('');
  console.log(
    `${'PROVIDER'.padEnd(PROVIDER_COLUMN_WIDTH)}${'MODEL'.padEnd(NAME_COLUMN_WIDTH)}` +
      `${'MODEL ID'.padEnd(MODEL_ID_COLUMN_WIDTH)}${'TIMEOUT (MS)'.padEnd(TIMEOUT_COLUMN_WIDTH)}BASE URL`
  );

  let modelCount = 0;
  for (const provider of file.providers) {
    if (provider.models.length === 0) {
      console.log(
        `${provider.provider.padEnd(PROVIDER_COLUMN_WIDTH)}${'(no models)'.padEnd(NAME_COLUMN_WIDTH)}` +
          `${''.padEnd(MODEL_ID_COLUMN_WIDTH)}` +
          `${String(provider.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS).padEnd(TIMEOUT_COLUMN_WIDTH)}${provider.baseUrl}`
      );
      continue;
    }

    for (const model of provider.models) {
      modelCount += 1;
      console.log(
        `${provider.provider.padEnd(PROVIDER_COLUMN_WIDTH)}` +
          `${model.name.padEnd(NAME_COLUMN_WIDTH)}` +
          `${model.id.padEnd(MODEL_ID_COLUMN_WIDTH)}` +
          `${String(provider.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS).padEnd(TIMEOUT_COLUMN_WIDTH)}${provider.baseUrl}`
      );
    }
  }

  if (modelCount === 0) {
    console.log('');
    console.log('No models configured yet.');
  }
}
