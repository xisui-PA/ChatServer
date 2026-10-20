import { CliError, reportError } from './cli-support';
import { runAdd } from './add';
import { runList } from './list';
import { runRemove } from './remove';
import { runTest } from './test';
import { runUpdate } from './update';

const COMMANDS = ['add', 'test', 'list', 'update', 'remove'];

/**
 * General help text.
 */
const HELP_TEXT = `Usage: chatserver-models <command> [options]

Manage OpenAI-compatible chat and speech-to-text models. Provider details live in
<config_dir>/models.json; each provider's API key lives in the OS credential manager
under the provider name.

Commands:
  add            Add a model (guided setup when options are omitted)
  test           Send a prompt to a configured model
  list           List configured providers and models
  update         Edit provider/model settings (guided editor without edits)
  remove         Remove a model (and its provider once empty)

Common options:
  --config_dir <dir>   Config folder (default: CHATSERVER_CONFIG_DIR or the per-user folder)
  -h, --help           Show help for a command

Run "chatserver-models <command> --help" for command-specific options.
Run "chatserver-models add" or "chatserver-models update" for guided terminal setup.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    console.log(HELP_TEXT);
    return;
  }

  const rest = argv.slice(1);

  switch (command) {
    case 'add':
      await runAdd(rest);
      return;
    case 'test':
      await runTest(rest);
      return;
    case 'list':
      await runList(rest);
      return;
    case 'update':
      await runUpdate(rest);
      return;
    case 'remove':
      await runRemove(rest);
      return;
    default:
      throw new CliError(
        `Unknown command: ${command}. Expected one of: ${COMMANDS.join(', ')}.`
      );
  }
}

main().catch((error) => {
  reportError(error);
});
