import { createServer, Server } from 'node:http';
import { ChatDefinition, getDefaultConfigDir } from './config';
import { evaluateFilters, FilterAdapter } from './filters/interface';
import { createFilter } from './filters/registry';
import { IncomingMessage, MessagerAdapter } from './messagers/interface';
import { createMessager } from './messagers/registry';
import { WebSocketHub, WebSocketMessagerAdapter } from './messagers/websocket';

export * from './filters/interface';
export * from './filters/allow-all';
export * from './filters/ignore-file';
export * from './filters/ignore-sender';
export * from './filters/registry';
export * from './messagers/interface';
export * from './messagers/websocket';
export * from './messagers/registry';

/**
 * Optional behaviour for {@link createChatServer}.
 */
export interface ChatServerOptions {
  /**
   * Chat pipelines from the config file. Each entry selects a messager and filters
   * by registered name. When omitted, a single default chat is served.
   */
  chats?: readonly ChatDefinition[];
  /** Fallback message sent to a client right after it connects (WebSocket only). */
  welcomeMessage?: string;
  /**
   * Single-chat shortcut: pre-built transport. Used only when `chats` is omitted.
   * Defaults to {@link WebSocketMessagerAdapter}.
   */
  messager?: MessagerAdapter;
  /** Single-chat shortcut: pre-built filters. Used only when `chats` is omitted. */
  filters?: readonly FilterAdapter[];
  /**
   * Whether to reply when every filter abstains (`'optional'`).
   * Chats may override this individually. Defaults to true.
   */
  replyWhenOptional?: boolean;
  /**
   * Folder holding the config file and its data files, such as `<messager>_ignore`.
   * Defaults to the per-user config folder.
   */
  configDir?: string;
}

/**
 * A chat after its adapters have been instantiated.
 */
interface ResolvedChat {
  name: string;
  messager: MessagerAdapter;
  filters: readonly FilterAdapter[];
  replyWhenOptional: boolean;
}

/**
 * Adapters for every configured chat, plus the shared WebSocket router if used.
 */
interface BuiltChats {
  chats: ResolvedChat[];
  webSocketHub?: WebSocketHub;
}

/**
 * Creates adapters for every configured chat.
 */
function buildChats(
  httpServer: Server,
  options: ChatServerOptions,
  fallbackReplyWhenOptional: boolean
): BuiltChats {
  const definitions = options.chats ?? [];
  const configDir = options.configDir ?? getDefaultConfigDir();

  if (definitions.length > 0) {
    const sharedServer = definitions.length > 1;
    // One hub owns upgrade routing so several chats can share the HTTP server.
    const webSocketHub = new WebSocketHub(httpServer);

    const chats = definitions.map((definition) => {
      const messager = createMessager(definition.messager.type, definition.messager.options, {
        server: httpServer,
        chatName: definition.name,
        welcomeMessage: options.welcomeMessage,
        defaultPath: sharedServer ? `/ws/${encodeURIComponent(definition.name)}` : '/',
        hub: webSocketHub
      });

      const filters = definition.filters.map((spec) =>
        createFilter(spec.type, spec.options, {
          chatName: definition.name,
          configDir,
          messagerType: definition.messager.type
        })
      );

      return {
        name: definition.name,
        messager,
        filters,
        replyWhenOptional: definition.replyWhenOptional ?? fallbackReplyWhenOptional
      };
    });

    return { chats, webSocketHub };
  }

  // Single-chat shortcut: use supplied instances, or the default WebSocket transport.
  const messager =
    options.messager ??
    new WebSocketMessagerAdapter({
      server: httpServer,
      welcomeMessage: options.welcomeMessage
    });

  return {
    chats: [
      {
        name: 'main',
        messager,
        filters: options.filters ?? [],
        replyWhenOptional: fallbackReplyWhenOptional
      }
    ]
  };
}

/**
 * Builds an HTTP server that hosts one or more chat pipelines.
 * - Plain HTTP requests (e.g. `GET /`) return a small JSON health payload.
 * - Inbound messages run through their chat's filter chain, then replies are sent
 *   through that chat's messager adapter.
 */
export function createChatServer(options: ChatServerOptions = {}): Server {
  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'ChatServer' }));
  });

  const { chats, webSocketHub } = buildChats(
    httpServer,
    options,
    options.replyWhenOptional ?? true
  );

  /**
   * Runs a message through a chat's filters and replies through its messager.
   */
  async function handleMessage(chat: ResolvedChat, message: IncomingMessage): Promise<void> {
    console.log(`[chat:${chat.name}] received from ${message.senderId}: ${message.text}`);

    const evaluation = await evaluateFilters(chat.filters, message);
    const shouldReply =
      evaluation.outcome === 'allowed' ||
      (evaluation.outcome === 'optional' && chat.replyWhenOptional);

    if (!shouldReply) {
      const reason = evaluation.decidedBy ? ` by filter "${evaluation.decidedBy}"` : '';
      console.log(`[chat:${chat.name}] dropped message from ${message.senderId}${reason}`);
      return;
    }

    try {
      await chat.messager.reply(message, { text: message.text });
    } catch (error) {
      console.error(
        `[chat:${chat.name}] failed to send reply via "${chat.messager.name}": ` +
          `${(error as Error).message}`
      );
    }
  }

  for (const chat of chats) {
    void chat.messager.start((message) => {
      void handleMessage(chat, message);
    });
  }

  httpServer.on('close', () => {
    for (const chat of chats) {
      void chat.messager.stop?.();
    }
    webSocketHub?.close();
  });

  return httpServer;
}
