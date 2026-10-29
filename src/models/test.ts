import { DEFAULT_MODEL_TIMEOUT_MS } from '../limit';
import { hasFlag, optionalValue } from './cli-support';
import {
  DEFAULT_PROMPT,
  parseCommandOptions,
  loadTestModel
} from './command-support';
import { createResponse } from './responses-client';
import { withModelRetries } from './retry';

/**
 * Help text for `chatserver-models test`.
 */
export const TEST_HELP = `Usage: chatserver-models test --provider <name> --name <name> [options]

Sends one prompt to a configured model and prints the reply.

Options:
  --provider <name>    Provider name from models.json (required)
  --name <name>        Model name from models.json (required)
  --prompt <text>      Prompt to send (default: "${DEFAULT_PROMPT}")
  --timeout <ms>       Override provider timeout for this request (default: provider setting or ${DEFAULT_MODEL_TIMEOUT_MS})
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

  const { provider, model, apiKey, timeoutMs } = await loadTestModel(cli);
  const prompt = optionalValue(cli, 'prompt') ?? DEFAULT_PROMPT;

  console.log(`Testing ${model.name} (${model.id}) via ${provider.provider} at ${provider.baseUrl}...`);

  const result = await withModelRetries(() => createResponse({
    baseUrl: provider.baseUrl,
    model: model.id,
    apiKey,
    input: prompt,
    timeoutMs
  }));

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
