import { Server } from 'node:http';
import { createChatServer } from './server';
import { CliOptions, ConfigError, HELP_TEXT, LoadedConfig, loadConfig, parseArgs } from './config';

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
async function tryLoadConfig(cli: CliOptions): Promise<LoadedConfig | undefined> {
  try {
    return await loadConfig({ configDir: cli.configDir });
  } catch (error) {
    reportError(error);
    return undefined;
  }
}

/**
 * Creates the server, reporting adapter construction errors instead of throwing.
 */
function tryCreateServer(options: Parameters<typeof createChatServer>[0]): Server | undefined {
  try {
    return createChatServer(options);
  } catch (error) {
    reportError(error);
    return undefined;
  }
}

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

  const config = await tryLoadConfig(cli);
  if (config === undefined) {
    return;
  }

  if (cli.printConfig) {
    console.log(
      JSON.stringify(
        {
          configPath: config.configPath,
          configDir: config.configDir,
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
  console.log(`[config] using ${config.configPath} (folder: ${config.configDir})`);

  const { host, port, welcomeMessage, chats } = config.values;

  const server = tryCreateServer({
    chats,
    welcomeMessage,
    configDir: config.configDir
  });
  if (server === undefined) {
    return;
  }

  server.on('error', (error) => {
    reportError(error);
  });

  server.listen(port, host, () => {
    console.log(`ChatServer listening on http://${host}:${port}`);
  });

  /**
   * Gracefully stop the server on Ctrl+C / SIGTERM.
   */
  const shutdown = () => {
    console.log('\nShutting down ChatServer...');
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  reportError(error);
});
