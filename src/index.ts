import path from 'node:path';
import { ChatServer } from './server';
import { ChatServerOptions, ConfigError, LoadedConfig, loadConfig } from './config';
import { getDefaultConfigDir } from './config-dir';

/**
 * Options accepted by the `chatserver` executable.
 */
interface CliOptions {
  configDir?: string;
  printConfig: boolean;
  help: boolean;
}

/**
 * Parses the CLI arguments accepted by the executable.
 */
function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { printConfig: false, help: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--config_dir' || arg === '-c') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`${arg} requires a directory.`);
      }
      options.configDir = value;
      i += 1;
    } else if (arg.startsWith('--config_dir=')) {
      const value = arg.slice('--config_dir='.length);
      if (value === '') {
        throw new Error('--config_dir requires a directory.');
      }
      options.configDir = value;
    } else if (arg === '--print-config') {
      options.printConfig = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}. Run "chatserver --help" for usage.`);
    }
  }

  return options;
}

/**
 * Reports an error to stderr and marks the process as failed.
 */
function reportError(error: unknown): void {
  if (error instanceof ConfigError) {
    console.error(`[config] ${error.message}`);
  } else if (error instanceof Error) {
    console.error(`[error] ${error.message}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
}

/**
 * Loads the effective configuration or returns undefined after reporting an error.
 */
async function tryLoadConfig(
  configDir: string,
  createIfMissing: boolean
): Promise<LoadedConfig | undefined> {
  try {
    return await loadConfig(configDir, { createIfMissing });
  } catch (error) {
    reportError(error);
    return undefined;
  }
}

/**
 * Constructs and starts the server, reporting adapter errors instead of throwing.
 */
async function tryCreateServer(
  options: ChatServerOptions,
  configDir: string
): Promise<ChatServer | undefined> {
  try {
    const server = new ChatServer(options, configDir);
    await server.start();
    return server;
  } catch (error) {
    reportError(error);
    return undefined;
  }
}

const HELP_TEXT = `Usage: chatserver [options]

Options:
  -c, --config_dir <dir>  Config folder containing config.json and optional
                          <messager>_ignore files.
                          Defaults to the per-user config folder.
      --print-config      Print the resolved configuration and exit
  -h, --help              Show this help and exit

Environment variables:
  CHATSERVER_CONFIG_DIR    Config folder

Default config folder:
  macOS    ~/Library/Application Support/chatserver
  Linux    $XDG_CONFIG_HOME/chatserver (~/.config by default)
  Windows  %APPDATA%\\chatserver

The folder contains config.json and may contain <messager>_ignore files, which the
ignore-sender filter reads to decide which senders to ignore.
`;

async function main(): Promise<void> {
  let cli: CliOptions;
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (error) {
    reportError(error);
    return;
  }

  if (cli.help) {
    console.log(HELP_TEXT);
    return;
  }

  const explicitConfigDir = cli.configDir ?? process.env.CHATSERVER_CONFIG_DIR;
  const configDir = path.resolve(explicitConfigDir ?? getDefaultConfigDir());
  const config = await tryLoadConfig(configDir, explicitConfigDir === undefined);
  if (config === undefined) {
    return;
  }

  if (cli.printConfig) {
    console.log(
      JSON.stringify(
        {
          configPath: config.configPath,
          configDir,
          config: config.values
        },
        null,
        2
      )
    );
    return;
  }

  if (config.created) {
    console.log(`[config] created ${config.configPath} with default values`);
  }
  console.log(`[config] using ${config.configPath} (folder: ${configDir})`);

  const server = await tryCreateServer(config.values, configDir);
  if (server === undefined) {
    return;
  }

  console.log(`ChatServer started with ${config.values.chats.length} chat pipeline(s)`);

  /** Gracefully stop adapters on Ctrl+C / SIGTERM. */
  const shutdown = () => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    console.log('\nShutting down ChatServer...');
    void server.close().catch(reportError);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  reportError(error);
});
