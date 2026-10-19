import { hasFlag, optionalValue, requireValue, resolveConfigDir } from './cli-support';
import {
  DEFAULT_PROMPT,
  DEFAULT_TIMEOUT_MS,
  existingApiKey,
  parseCommandOptions,
  modelTimeoutOption,
  requireModel,
  requireProvider
} from './command-support';
import { createResponse } from './responses-client';

/**
 * Help text for `chatserver-models test`.
 */
export const TEST_HELP = `Usage: chatserver-models test --provider <name> --name <name> [options]

Sends one prompt to a configured model and prints the reply.

Options:
  --provider <name>    Provider name from models.json (required)
  --name <name>        Model name from models.json (required)
  --prompt <text>      Prompt to send (default: "${DEFAULT_PROMPT}")
  --timeout <ms>       Override provider timeout for this request (default: provider setting or ${DEFAULT_TIMEOUT_MS})
  --json               Print the raw API response instead of just the text
  --config_dir <dir>   Config folder
  -h, --help           Show this help

The API key is read from CHATSERVER_MODEL_API_KEY or the OS credential manager
(account: the provider name).
`;

/**
 * Sends one prompt to a configured model.
 */
export async function runTest(argv: string[]): Promise<void> {
  const cli = parseCommandOptions(argv, {
    valueFlags: {
      '--provider': 'provider',
      '--name': 'name',
      '--prompt': 'prompt',
      '--timeout': 'timeout'
    },
    booleanFlags: { '--json': 'json' }
  });

  if (hasFlag(cli, 'help')) {
    console.log(TEST_HELP);
    return;
  }

  const configDir = resolveConfigDir(optionalValue(cli, 'configDir'));
  const providerName = requireValue(cli, 'provider', '--provider');
  const name = requireValue(cli, 'name', '--name');
  const { provider } = await requireProvider(configDir, providerName);
  const model = requireModel(provider, name);
  const apiKey = await existingApiKey(provider);
  const prompt = optionalValue(cli, 'prompt') ?? DEFAULT_PROMPT;
  const timeoutMs = modelTimeoutOption(optionalValue(cli, 'timeout'), provider.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  console.log(`Testing ${name} (${model.id}) via ${provider.provider} at ${provider.baseUrl}...`);

  const result = await createResponse({
    baseUrl: provider.baseUrl,
    model: model.id,
    apiKey,
    input: prompt,
    timeoutMs
  });

  if (hasFlag(cli, 'json')) {
    console.log(JSON.stringify(result.raw, null, 2));
    return;
  }

  console.log('');
  console.log(result.outputText === '' ? '(no output text in response)' : result.outputText);
  if (result.id !== undefined) {
    console.log('');
    console.log(`Response id: ${result.id}`);
  }
}
