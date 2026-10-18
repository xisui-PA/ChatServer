import { readFileSync } from 'node:fs';
import path from 'node:path';
import { MessagerAdapter } from './interface';
import { WechatMessagerAdapter } from './wechat';

/**
 * Context passed to messager factories when a chat is created.
 */
export interface MessagerFactoryContext {
  /** Name of the chat the messager belongs to, used in error messages. */
  chatName: string;
  /** Folder containing configuration and adapter data files. */
  configDir: string;
}

/**
 * Builds a messager from config-file options.
 */
export type MessagerFactory = (
  options: Readonly<Record<string, unknown>>,
  context: MessagerFactoryContext
) => MessagerAdapter;

const factories = new Map<string, MessagerFactory>();

/**
 * Registers a messager implementation under a config-file name.
 */
export function registerMessager(name: string, factory: MessagerFactory): void {
  factories.set(name, factory);
}

/**
 * Returns true when a messager with this name is registered.
 */
export function hasMessager(name: string): boolean {
  return factories.has(name);
}

/**
 * Lists the names of all registered messagers, sorted for stable messages.
 */
export function listMessagers(): string[] {
  return [...factories.keys()].sort();
}

/**
 * Creates a messager by name, applying its config-file options.
 */
export function createMessager(
  name: string,
  options: Readonly<Record<string, unknown>>,
  context: MessagerFactoryContext
): MessagerAdapter {
  const factory = factories.get(name);
  if (factory === undefined) {
    throw new Error(`Unknown messager "${name}". Available messagers: ${listMessagers().join(', ')}.`);
  }
  return factory(options, context);
}

registerMessager('wechat', (options, context) => {
  const label = `messager "wechat" (chat "${context.chatName}")`;
  const known = ['baseUrl', 'tokenEnv', 'tokenFile', 'chatIds', 'pollIntervalMs', 'timeoutMs'];
  for (const key of Object.keys(options)) {
    if (!known.includes(key)) {
      throw new Error(`${label}: unknown option "${key}".`);
    }
  }
  for (const key of ['baseUrl', 'tokenEnv', 'tokenFile']) {
    if (options[key] !== undefined &&
      (typeof options[key] !== 'string' || options[key].trim() === '')) {
      throw new Error(`${label}: option "${key}" must be a non-empty string.`);
    }
  }
  for (const key of ['pollIntervalMs', 'timeoutMs']) {
    if (options[key] !== undefined && typeof options[key] !== 'number') {
      throw new Error(`${label}: option "${key}" must be a number.`);
    }
  }
  if (options.chatIds !== undefined && (!Array.isArray(options.chatIds) ||
    !options.chatIds.every((id) => typeof id === 'string' && id.trim() !== ''))) {
    throw new Error(`${label}: option "chatIds" must be an array of non-empty strings.`);
  }
  const tokenEnv = options.tokenEnv as string | undefined ?? 'AGENT_WECHAT_TOKEN';
  let token = process.env[tokenEnv]?.trim() ?? '';
  if (!token && options.tokenFile !== undefined) {
    token = readFileSync(path.resolve(context.configDir, options.tokenFile as string), 'utf8').trim();
  }
  if (!token) {
    throw new Error(`${label}: bearer token is missing. Set ${tokenEnv} or tokenFile.`);
  }
  return new WechatMessagerAdapter(token, {
    baseUrl: options.baseUrl as string | undefined,
    chatIds: options.chatIds as string[] | undefined,
    pollIntervalMs: options.pollIntervalMs as number | undefined,
    timeoutMs: options.timeoutMs as number | undefined
  });
});
