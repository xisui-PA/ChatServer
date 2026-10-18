import path from 'node:path';
import { ChatServer, createChatServer } from './server';
import { CliOptions, ConfigError, LoadedConfig, getDefaultConfigDir, loadConfig, parseArgs } from './config';

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
 * Creates the server, reporting adapter construction errors instead of throwing.
 */
async function tryCreateServer(
  options: Parameters<typeof createChatServer>[0],
  configDir: string
): Promise<ChatServer | undefined> {
  try {
    return await createChatServer(options, configDir);
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

  const { chats } = config.values;

  const server = await tryCreateServer({ chats }, configDir);
  if (server === undefined) {
    return;
  }

  console.log(`ChatServer started with ${chats.length} chat pipeline(s)`);

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
