import { Server } from 'node:http';
import { MessagerAdapter } from './interface';
import { WebSocketHub, WebSocketMessagerAdapter } from './websocket';

/**
 * Context passed to messager factories when a chat is created.
 */
export interface MessagerFactoryContext {
  /** HTTP server the messager may attach to. */
  server: Server;
  /** Name of the chat the messager belongs to, used in error messages. */
  chatName: string;
  /** Fallback welcome message from the top-level config. */
  welcomeMessage?: string;
  /**
   * Path to use when the chat does not set one explicitly.
   * Assigned when multiple chats share the same HTTP server.
   */
  defaultPath?: string;
  /** Shared WebSocket router, required when several chats share one HTTP server. */
  hub?: WebSocketHub;
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

/**
 * Reads an optional string option.
 */
function stringOption(
  options: Readonly<Record<string, unknown>>,
  key: string,
  label: string
): string | undefined {
  const value = options[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label}: option "${key}" must be a string.`);
  }
  return value;
}

registerMessager('websocket', (options, context) => {
  const label = `messager "websocket" (chat "${context.chatName}")`;
  const path = stringOption(options, 'path', label);
  const welcomeMessage =
    stringOption(options, 'welcomeMessage', label) ?? context.welcomeMessage;

  if (path !== undefined && !path.startsWith('/')) {
    throw new Error(`${label}: option "path" must start with "/".`);
  }

  return new WebSocketMessagerAdapter({
    server: context.server,
    hub: context.hub,
    path: path ?? context.defaultPath ?? '/',
    welcomeMessage
  });
});
