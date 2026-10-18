import path from 'node:path';
import * as readline from 'node:readline/promises';
import { getDefaultConfigDir } from '../config';

/**
 * Raised for invalid command-line usage.
 */
export class CliError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

/**
 * Describes which command-line options carry a value and which are booleans.
 */
export interface CommandLineSpec {
  /** Map of flag spelling (including dashes) to a stable value key. */
  valueFlags: Record<string, string>;
  /** Map of flag spelling (including dashes) to a stable boolean key. */
  booleanFlags: Record<string, string>;
}

/**
 * Parsed command line.
 */
export interface CommandLine {
  /** Values keyed by the names from {@link CommandLineSpec.valueFlags}. */
  values: Map<string, string>;
  /** Boolean flags keyed by the names from {@link CommandLineSpec.booleanFlags}. */
  flags: Set<string>;
  /** Arguments that were not options. */
  positionals: string[];
}

/**
 * Splits `--flag=value` into its name and inline value.
 */
function splitFlag(arg: string): [string, string | undefined] {
  const index = arg.indexOf('=');
  if (index === -1) {
    return [arg, undefined];
  }
  return [arg.slice(0, index), arg.slice(index + 1)];
}

/**
 * Parses `--flag value`, `--flag=value`, and boolean flags.
 */
export function parseCommandLine(argv: string[], spec: CommandLineSpec): CommandLine {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }

    const [name, inlineValue] = splitFlag(arg);
    const valueKey = spec.valueFlags[name];

    if (valueKey !== undefined) {
      const value = inlineValue ?? argv[i + 1];
      if (value === undefined || (inlineValue === undefined && value.startsWith('-'))) {
        throw new CliError(`${name} requires a value.`);
      }
      values.set(valueKey, value);
      if (inlineValue === undefined) {
        i += 1;
      }
      continue;
    }

    const flagKey = spec.booleanFlags[name];
    if (flagKey !== undefined) {
      if (inlineValue !== undefined) {
        throw new CliError(`${name} does not take a value.`);
      }
      flags.add(flagKey);
      continue;
    }

    throw new CliError(`Unknown option: ${name}. Run with --help for usage.`);
  }

  return { values, flags, positionals };
}

/**
 * Reads an option's value.
 */
export function optionalValue(cli: CommandLine, key: string): string | undefined {
  return cli.values.get(key);
}

/**
 * Reads an option's value, failing when it is missing.
 */
export function requireValue(cli: CommandLine, key: string, label: string): string {
  const value = cli.values.get(key);
  if (value === undefined || value === '') {
    throw new CliError(`${label} is required.`);
  }
  return value;
}

/**
 * Returns true when a boolean flag was supplied.
 */
export function hasFlag(cli: CommandLine, key: string): boolean {
  return cli.flags.has(key);
}

/**
 * Resolves the config folder from an option, the environment, or the per-user default.
 */
export function resolveConfigDir(option?: string): string {
  return path.resolve(option ?? process.env.CHATSERVER_CONFIG_DIR ?? getDefaultConfigDir());
}

/**
 * Prompts for a line of text.
 */
export async function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Prompts for a secret without echoing keystrokes when stdin is a terminal.
 */
export function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    throw new CliError('Cannot prompt for a secret without a terminal. Pass --api-key instead.');
  }

  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';

    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          finish(value);
          return;
        }
        if (char === '\u0003') {
          finish(undefined, new CliError('Cancelled.'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    const finish = (result: string | undefined, error?: Error): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve(result ?? '');
    };

    stdin.on('data', onData);
  });
}

/**
 * Prints an error and marks the process as failed.
 */
export function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[models] ${message}`);
  process.exitCode = 1;
}
