import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ChatServerOptions } from './config';
import { evaluateFilters, FilterAdapter, FilterOutcome } from './filters/interface';
import { createFilter } from './filters/registry';
import { ConversationMessage, IncomingMessage, MessagerAdapter, OutgoingMessage } from './messagers/interface';
import { createMessager } from './messagers/registry';
import { Replier } from './repliers/interface';
import { ModelReplier } from './repliers/model';
import { ModelRegistry } from './models/runtime';
import { createTools } from './tools/registry';
import { ConversationMemoryStore, MEMORY_RETENTION_MS, MEMORY_TOKEN_LIMIT } from './conversations/memory-store';
import { limitReplyText } from './repliers/limits';

export * from './filters/interface';
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
export * from './conversations/interface';

/**
 * A chat after its adapters have been instantiated.
 */
interface ResolvedChat {
  name: string;
  mainAccount?: string;
  messager: MessagerAdapter;
  filters: readonly FilterAdapter[];
  replier: Replier;
}

/** Bounded context since the last successful reply, plus scheduling state. */
interface ConversationState {
  chat: ResolvedChat;
  memoryKey: string;
  latest: IncomingMessage;
  messages: { revision: number; message: ConversationMessage }[];
  revision: number;
  processing: boolean;
  hasPendingMessages: boolean;
  statusRequest?: IncomingMessage;
}

/** Owns chat pipelines, message handling, and adapter startup/shutdown. */
export class ChatServer {
  private processing?: Promise<void>;
  private readonly conversations = new Map<string, ConversationState>();
  private readonly pending = new Map<string, ConversationState>();
  private readonly memory: ConversationMemoryStore;
  private replySlotReady = false;
  private readonly shutdown = new AbortController();
  private readonly started: ResolvedChat[] = [];
  private startTask?: Promise<void>;
  private closeTask?: Promise<void>;
  private closed = false;
  private startedAt = 0;
  private deliveries = 0;
  private deliveryFailures = 0;
  private lastDeliveryAt?: string;

  /** Binds pipeline configuration to the directory selected at invocation. */
  public constructor(
    private readonly options: ChatServerOptions,
    private readonly configDir: string
  ) {
    this.memory = new ConversationMemoryStore(configDir);
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
        mainAccount: definition.messager.mainAccount,
        replier: new ModelReplier(models.get(definition.messager.replyer), createTools(definition.messager.tools)),
        messager: createMessager(definition.messager.name, definition.messager.options ?? {}, {
          chatName: name,
          configDir: this.configDir,
          mainAccount: definition.messager.mainAccount
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
      this.startedAt = Date.now();
      await this.memory.start();
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
          this.enqueueMessage(chat, message);
        });
      }
    } catch (error) {
      this.closed = true;
      this.shutdown.abort();
      await this.processing;
      await this.stopChats().catch((cleanupError: unknown) => {
        console.error('[chat] failed to clean up after startup:', cleanupError);
      });
      throw error;
    }
  }

  private async closeChats(): Promise<void> {
    // Startup already reports its error and cleans up partially started adapters.
    await this.startTask?.catch(() => {});
    await this.processing;
    await this.stopChats();
  }

  private async stopChats(): Promise<void> {
    this.pending.clear();
    this.conversations.clear();
    const stopping = this.started.splice(0);
    const results = await Promise.allSettled([this.memory.close(), ...stopping.map(async (chat) => {
      await chat.messager.stop?.();
    })]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      throw failure.reason;
    }
  }

  /** Updates bounded context without adding duplicate conversation entries. */
  private enqueueMessage(chat: ResolvedChat, message: IncomingMessage): void {
    if (this.closed) {
      return;
    }
    const sources = message.messages?.length ? message.messages : [message];
    const statusRequest = sources.find((source) => source.text.trim() === '/status' &&
      chat.mainAccount !== undefined && source.senderId === chat.mainAccount &&
      message.channel === chat.mainAccount);
    // Reserved commands cannot be interpreted by the LLM or disclose status in groups.
    const regularMessages = sources.filter((source) => source.text.trim() !== '/status');
    if (statusRequest === undefined && regularMessages.length === 0) {
      return;
    }
    const key = JSON.stringify([
      chat.name,
      message.metadata?.wechatAccount ?? null,
      message.channel ?? message.senderId
    ]);
    let conversation = this.conversations.get(key);
    if (conversation === undefined) {
      const memoryKey = JSON.stringify([
        chat.messager.name,
        message.metadata?.wechatAccount ?? chat.name,
        message.channel ?? message.senderId
      ]);
      conversation = {
        chat, memoryKey, latest: message, messages: [], revision: 0,
        processing: false, hasPendingMessages: false
      };
      this.conversations.set(key, conversation);
    }
    conversation.latest = message;
    if (statusRequest !== undefined) {
      conversation.statusRequest = {
        ...message, ...statusRequest, text: '/status', messages: undefined
      };
    }
    if (regularMessages.length > 0) {
      conversation.hasPendingMessages = true;
    }
    for (const source of regularMessages) {
      conversation.messages.push({
        revision: ++conversation.revision,
        message: {
          id: source.id ?? `message:${randomUUID()}`,
          text: source.text,
          senderId: source.senderId,
          images: source.images,
          timestamp: source.timestamp && Number.isFinite(Date.parse(source.timestamp))
            ? new Date(Math.min(Date.now(), Date.parse(source.timestamp))).toISOString()
            : new Date().toISOString()
        }
      });
    }
    conversation.messages = conversation.messages.slice(-30);
    if (!conversation.processing) {
      // Updating an existing Map entry preserves its FIFO position.
      this.pending.set(key, conversation);
    }
    this.startProcessing();
  }

  /** Runs a single worker; polling can keep updating context while it waits. */
  private startProcessing(): void {
    if (this.closed || this.processing !== undefined) {
      return;
    }
    this.processing = Promise.resolve().then(() => this.processConversations()).catch((error: unknown) => {
      if (!this.closed) {
        console.error('[chat] conversation queue failed:', error);
      }
    }).finally(() => {
      this.processing = undefined;
      if (!this.closed && this.pending.size > 0) {
        this.startProcessing();
      }
    });
  }

  /** Takes the oldest pending conversation after the send slot becomes ready. */
  private async processConversations(): Promise<void> {
    while (!this.closed && this.pending.size > 0) {
      if (!this.replySlotReady) {
        await delay(randomInt(120_000, 300_001), undefined, { signal: this.shutdown.signal });
        this.replySlotReady = true;
      }
      if (this.closed) {
        return;
      }
      const next = this.pending.entries().next();
      if (next.done) {
        break;
      }
      const [key, conversation] = next.value;
      this.pending.delete(key);
      conversation.processing = true;
      const revision = conversation.revision;
      try {
        if (conversation.statusRequest !== undefined) {
          const request = conversation.statusRequest;
          conversation.statusRequest = undefined;
          await this.handleStatus(conversation.chat, request);
        } else {
          conversation.hasPendingMessages = false;
          const messages = conversation.messages.map((entry) => entry.message);
          const snapshot: IncomingMessage = {
            ...conversation.latest,
            text: messages.map((message) =>
              `${message.timestamp ?? ''} ${message.senderId}: ${message.text}`.trim()).join('\n'),
            messages
          };
          if (await this.handleMessage(conversation, snapshot)) {
            // Preserve arrivals during generation/delivery for the next turn.
            conversation.messages = conversation.messages.filter((entry) => entry.revision > revision);
          }
        }
      } catch (error) {
        if (!this.closed) {
          console.error(`[chat:${conversation.chat.name}] failed to process conversation:`, error);
        }
      } finally {
        conversation.processing = false;
        if (conversation.messages.length === 0 && conversation.statusRequest === undefined) {
          this.conversations.delete(key);
        } else if (!this.closed && (conversation.hasPendingMessages || conversation.statusRequest !== undefined)) {
          // Only new arrivals schedule another turn; silence/failures do not spin.
          this.pending.set(key, conversation);
        }
      }
    }
    this.replySlotReady = false;
  }

  /** Returns true only after a snapshot's reply is successfully delivered. */
  private async handleMessage(conversation: ConversationState, message: IncomingMessage): Promise<boolean> {
    const { chat, memoryKey } = conversation;
    if (this.closed) {
      return false;
    }
    console.log(`[chat:${chat.name}] processing ${message.messages?.length ?? 1} message(s) in ${message.channel ?? message.senderId}`);
    try {
      message = { ...message, memory: await this.memory.load(memoryKey) };
    } catch (error) {
      console.error(`[chat:${chat.name}] failed to load conversation memory:`, error);
      message = { ...message, memory: { notes: [], replies: [] } };
    }
    if (this.closed) {
      return false;
    }

    let outcome = FilterOutcome.Optional;
    if (chat.filters.length > 0) {
      const evaluation = await evaluateFilters(chat.filters, message);
      if (evaluation.outcome === FilterOutcome.Denied) {
        const reason = evaluation.decidedBy ? ` by filter "${evaluation.decidedBy}"` : '';
        console.log(`[chat:${chat.name}] dropped message from ${message.senderId}${reason}`);
        return false;
      }
      outcome = evaluation.outcome;
    }
    if (this.closed) {
      return false;
    }

    const result = await chat.replier.replyTo(message, outcome, this.shutdown.signal);
    if (this.closed) {
      return false;
    }
    try {
      await this.memory.update(memoryKey, result.memoryUpdates, message.messages ?? [message]);
    } catch (error) {
      console.error(`[chat:${chat.name}] failed to save conversation notes:`, error);
    }
    const reply = result.reply;
    if (this.closed || reply === undefined) {
      return false;
    }
    if (await this.deliverReply(chat, message, reply)) {
      // A persistence failure must not turn confirmed delivery into a retry.
      try {
        await this.memory.recordReply(memoryKey, reply);
      } catch (error) {
        console.error(`[chat:${chat.name}] failed to record delivered reply:`, error);
      }
      return true;
    }
    return false;
  }

  /** Uses only local observations and always replies directly to the controller. */
  private async handleStatus(chat: ResolvedChat, message: IncomingMessage): Promise<void> {
    if (chat.mainAccount === undefined || message.senderId !== chat.mainAccount ||
      message.channel !== chat.mainAccount || this.closed) {
      return;
    }
    const health = chat.messager.getStatus?.();
    const minutes = Math.floor((Date.now() - this.startedAt) / 60000);
    const queued = [...this.conversations.values()].filter((item) => item.hasPendingMessages);
    const buffered = queued.reduce((total, item) => total + item.messages.length, 0);
    const text = [
      'ChatServer: running',
      `Uptime: ${Math.floor(minutes / 60)}h ${minutes % 60}m`,
      `Pipelines: ${this.started.length}/${this.options.chats.length}`,
      `Pending conversations: ${queued.length} (${buffered} messages)`,
      `Pending status queries: ${[...this.conversations.values()].filter((item) => item.statusRequest !== undefined).length}`,
      `Deliveries: ${this.deliveries}; failures: ${this.deliveryFailures}`,
      `Last delivery: ${this.lastDeliveryAt ?? 'none'}`,
      `Adapter: ${chat.messager.name}${health === undefined ? '' : health.active ? ' (active)' : ' (stopped)'}`,
      `Last successful poll: ${health?.lastSuccessfulPollAt ?? 'none reported'}`,
      `Consecutive poll failures: ${health?.consecutivePollFailures ?? 'not reported'}`,
      'Reply delay: random 2–5 minutes',
      `Memory: ${MEMORY_RETENTION_MS / (24 * 60 * 60 * 1000)} days, up to ${MEMORY_TOKEN_LIMIT} tokens per conversation`
    ].join('\n');
    await this.deliverReply(chat, message, { text: limitReplyText(text), direct: true });
  }

  /** Normal replies and status reports share one paced delivery path. */
  private async deliverReply(chat: ResolvedChat, message: IncomingMessage, reply: OutgoingMessage): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    // Only delivery attempts consume the slot; declined snapshots share it.
    this.replySlotReady = false;
    try {
      await chat.messager.reply(message, reply, this.shutdown.signal);
      this.deliveries += 1;
      this.lastDeliveryAt = new Date().toISOString();
      return true;
    } catch (error) {
      this.deliveryFailures += 1;
      console.error(
        `[chat:${chat.name}] failed to send reply via "${chat.messager.name}": ` +
          `${(error as Error).message}`
      );
      return false;
    }
  }
}
