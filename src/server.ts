import { ChatDefinition } from './config';
import { evaluateFilters, FilterAdapter } from './filters/interface';
import { createFilter } from './filters/registry';
import { IncomingMessage, MessagerAdapter } from './messagers/interface';
import { createMessager } from './messagers/registry';

export * from './filters/interface';
export * from './filters/allow-all';
export * from './filters/ignore-file';
export * from './filters/ignore-sender';
export * from './filters/registry';
export * from './messagers/interface';
export * from './messagers/wechat';
export * from './messagers/registry';

/**
 * Optional behaviour for {@link createChatServer}.
 */
export interface ChatServerOptions {
  /**
   * Chat pipelines from the config file. Each entry selects a messager and filters
   * by registered name. When omitted, the supplied messager is used.
   */
  chats?: readonly ChatDefinition[];
  /**
   * Single-chat shortcut: pre-built transport. Used only when `chats` is omitted.
   */
  messager?: MessagerAdapter;
  /** Single-chat shortcut: pre-built filters. Used only when `chats` is omitted. */
  filters?: readonly FilterAdapter[];
  /**
   * Whether to reply when every filter abstains (`'optional'`).
   * Chats may override this individually. Defaults to true.
   */
  replyWhenOptional?: boolean;
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

/** Running chat pipelines and their transport lifecycle. */
export interface ChatServer {
  /** Stops every messager and releases its resources. */
  close(): Promise<void>;
}

/** Creates adapters for every configured chat. */
function buildChats(options: ChatServerOptions, configDir: string): ResolvedChat[] {
  const fallbackReplyWhenOptional = options.replyWhenOptional ?? true;

  if (options.chats !== undefined) {
    return options.chats.map((definition) => ({
      name: definition.name,
      messager: createMessager(definition.messager.type, definition.messager.options, {
        chatName: definition.name,
        configDir
      }),
      filters: definition.filters.map((spec) =>
        createFilter(spec.type, spec.options, {
          chatName: definition.name,
          configDir,
          messagerType: definition.messager.type
        })
      ),
      replyWhenOptional: definition.replyWhenOptional ?? fallbackReplyWhenOptional
    }));
  }

  return options.messager === undefined ? [] : [{
    name: 'main',
    messager: options.messager,
    filters: options.filters ?? [],
    replyWhenOptional: fallbackReplyWhenOptional
  }];
}

/**
 * Starts chat pipelines using the configured messager adapters.
 * @param options Chat pipeline options.
 * @param configDir Resolved folder selected at invocation for configuration and adapter data files.
 */
export async function createChatServer(
  options: ChatServerOptions = {},
  configDir: string
): Promise<ChatServer> {
  const chats = buildChats(options, configDir);
  const started: ResolvedChat[] = [];

  /** Stops all started adapters, including after a partial startup failure. */
  async function close(): Promise<void> {
    const stopping = started.splice(0);
    const results = await Promise.allSettled(stopping.map(async (chat) => {
      await chat.messager.stop?.();
    }));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      throw failure.reason;
    }
  }

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

  try {
    for (const chat of chats) {
      started.push(chat);
      await chat.messager.start((message) => {
        void handleMessage(chat, message).catch((error: unknown) => {
          console.error(`[chat:${chat.name}] failed to process message:`, error);
        });
      });
    }
  } catch (error) {
    await close().catch((cleanupError: unknown) => {
      console.error('[chat] failed to clean up after startup:', cleanupError);
    });
    throw error;
  }

  return { close };
}
