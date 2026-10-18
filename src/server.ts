import { ChatServerOptions } from './config';
import { evaluateFilters, FilterAdapter, FilterOutcome } from './filters/interface';
import { createFilter } from './filters/registry';
import { IncomingMessage, MessagerAdapter } from './messagers/interface';
import { createMessager } from './messagers/registry';
import { Replier } from './repliers/interface';
import { ModelReplier } from './repliers/model';
import { ModelRegistry } from './models/runtime';
import { createTools } from './tools/registry';

export * from './filters/interface';
export * from './filters/allow-all';
export * from './filters/ignore-file';
export * from './filters/ignore-sender';
export * from './filters/registry';
export * from './filters/model';
export * from './messagers/interface';
export * from './messagers/wechat';
export * from './messagers/registry';
export * from './repliers/interface';
export * from './repliers/model';
export * from './tools/interface';
export * from './tools/registry';

/**
 * A chat after its adapters have been instantiated.
 */
interface ResolvedChat {
  name: string;
  messager: MessagerAdapter;
  filters: readonly FilterAdapter[];
  replier: Replier;
}

/** Owns chat pipelines, message handling, and adapter startup/shutdown. */
export class ChatServer {
  private readonly pendingMessages = new Set<Promise<void>>();
  private readonly shutdown = new AbortController();
  private readonly started: ResolvedChat[] = [];
  private startTask?: Promise<void>;
  private closeTask?: Promise<void>;
  private closed = false;

  /** Binds pipeline configuration to the directory selected at invocation. */
  public constructor(
    private readonly options: ChatServerOptions,
    private readonly configDir: string
  ) {}

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
    this.shutdown.abort();
    this.closeTask ??= this.closeChats();
    return this.closeTask;
  }

  /** Creates the messager and filter adapters for each configured chat. */
  private buildChats(models: ModelRegistry): ResolvedChat[] {
    return this.options.chats.map((definition, index) => {
      const name = `chat-${index + 1}`;
      return {
        name,
        replier: new ModelReplier(models.get(definition.messager.replyer), createTools(definition.messager.tools)),
        messager: createMessager(definition.messager.name, definition.messager.options ?? {}, {
          chatName: name,
          configDir: this.configDir
        }),
        filters: definition.filters.map((spec) =>
          createFilter(spec.type, spec.options ?? {}, {
            chatName: name,
            configDir: this.configDir,
            messagerType: definition.messager.name,
            model: spec.model === undefined ? undefined : models.get(spec.model),
            signal: this.shutdown.signal
          })
        )
      };
    });
  }

  private async startChats(): Promise<void> {
    try {
      const references = this.options.chats.flatMap((chat) => [
        chat.messager.replyer,
        ...chat.filters.flatMap((filter) => filter.model === undefined ? [] : [filter.model])
      ]);
      const models = await ModelRegistry.load(this.configDir, references);
      if (this.closed) {
        return;
      }
      const chats = this.buildChats(models);
      for (const chat of chats) {
        if (this.closed) {
          break;
        }
        this.started.push(chat);
        await chat.messager.start((message) => {
          const task = this.handleMessage(chat, message).catch((error: unknown) => {
            if (!this.closed) {
              console.error(`[chat:${chat.name}] failed to process message:`, error);
            }
          });
          this.pendingMessages.add(task);
          void task.finally(() => this.pendingMessages.delete(task));
        });
      }
    } catch (error) {
      this.closed = true;
      this.shutdown.abort();
      await Promise.allSettled([...this.pendingMessages]);
      await this.stopChats().catch((cleanupError: unknown) => {
        console.error('[chat] failed to clean up after startup:', cleanupError);
      });
      throw error;
    }
  }

  private async closeChats(): Promise<void> {
    // Startup already reports its error and cleans up partially started adapters.
    await this.startTask?.catch(() => {});
    await Promise.allSettled([...this.pendingMessages]);
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

    const reply = await chat.replier.replyTo(message, evaluation.outcome, this.shutdown.signal);
    if (this.closed || reply === undefined) {
      return;
    }
    try {
      await chat.messager.reply(message, reply);
    } catch (error) {
      console.error(
        `[chat:${chat.name}] failed to send reply via "${chat.messager.name}": ` +
          `${(error as Error).message}`
      );
    }
  }
}
