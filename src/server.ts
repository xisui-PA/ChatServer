import { ChatServerOptions } from './config';
import { evaluateFilters, FilterAdapter, FilterOutcome } from './filters/interface';
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
 * A chat after its adapters have been instantiated.
 */
interface ResolvedChat {
  name: string;
  messager: MessagerAdapter;
  filters: readonly FilterAdapter[];
}

/** Owns chat pipelines, message handling, and adapter startup/shutdown. */
export class ChatServer {
  private readonly chats: ResolvedChat[];
  private readonly started: ResolvedChat[] = [];
  private startTask?: Promise<void>;
  private closeTask?: Promise<void>;
  private closed = false;

  /** Constructs adapters using the configuration directory selected at invocation. */
  public constructor(options: ChatServerOptions, configDir: string) {
    this.chats = this.buildChats(options, configDir);
  }

  /** Starts the configured adapters once, cleaning up if startup fails. */
  public start(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Cannot start a closed ChatServer.'));
    }
    this.startTask ??= this.startChats();
    return this.startTask;
  }

  /** Stops every started adapter, waiting for any pending startup to settle. */
  public close(): Promise<void> {
    this.closed = true;
    this.closeTask ??= this.closeChats();
    return this.closeTask;
  }

  /** Creates the messager and filter adapters for each configured chat. */
  private buildChats(options: ChatServerOptions, configDir: string): ResolvedChat[] {
    return options.chats.map((definition, index) => {
      const name = `chat-${index + 1}`;
      return {
        name,
        messager: createMessager(definition.messager.type, definition.messager.options ?? {}, {
          chatName: name,
          configDir
        }),
        filters: definition.filters.map((spec) =>
          createFilter(spec.type, spec.options ?? {}, {
            chatName: name,
            configDir,
            messagerType: definition.messager.type
          })
        )
      };
    });
  }

  private async startChats(): Promise<void> {
    try {
      for (const chat of this.chats) {
        if (this.closed) {
          break;
        }
        this.started.push(chat);
        await chat.messager.start((message) => {
          void this.handleMessage(chat, message).catch((error: unknown) => {
            console.error(`[chat:${chat.name}] failed to process message:`, error);
          });
        });
      }
    } catch (error) {
      await this.stopChats().catch((cleanupError: unknown) => {
        console.error('[chat] failed to clean up after startup:', cleanupError);
      });
      throw error;
    }
  }

  private async closeChats(): Promise<void> {
    // Startup already reports its error and cleans up partially started adapters.
    await this.startTask?.catch(() => {});
    await this.stopChats();
  }

  private async stopChats(): Promise<void> {
    const stopping = this.started.splice(0);
    const results = await Promise.allSettled(stopping.map(async (chat) => {
      await chat.messager.stop?.();
    }));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      throw failure.reason;
    }
  }

  /** Runs a message through its chat's filters and reply stage. */
  private async handleMessage(chat: ResolvedChat, message: IncomingMessage): Promise<void> {
    if (this.closed) {
      return;
    }
    console.log(`[chat:${chat.name}] received from ${message.senderId}: ${message.text}`);

    const evaluation = await evaluateFilters(chat.filters, message);

    if (evaluation.outcome === FilterOutcome.Denied) {
      const reason = evaluation.decidedBy ? ` by filter "${evaluation.decidedBy}"` : '';
      console.log(`[chat:${chat.name}] dropped message from ${message.senderId}${reason}`);
      return;
    }
    if (this.closed) {
      return;
    }

    // An optional filter outcome leaves the decision to the reply stage.
    // This stage currently echoes; model-backed reply generation is not wired yet.
    try {
      await chat.messager.reply(message, { text: message.text });
    } catch (error) {
      console.error(
        `[chat:${chat.name}] failed to send reply via "${chat.messager.name}": ` +
          `${(error as Error).message}`
      );
    }
  }
}
