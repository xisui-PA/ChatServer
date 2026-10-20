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
import { ResponsesApiError } from './models/responses-client';
import { PendingMediaError } from './models/pending-media';
import { VoiceTranscriber } from './models/voice-transcriber';

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
  replierModel: string;
  stt?: VoiceTranscriber;
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
  selfRevision: number;
  retryAttempts: number;
  retryTimer?: ReturnType<typeof setTimeout>;
}

/** A manual/self reply arrived after the snapshot was taken. */
class SupersededTurnError extends Error {}

/** Owns chat pipelines, message handling, and adapter startup/shutdown. */
export class ChatServer {
  private processing?: Promise<void>;
  private ingestion: Promise<void> = Promise.resolve();
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
  private processingFailures = 0;
  private filterFailures = 0;
  private lastProcessingError?: string;
  private lastProcessingErrorAt?: string;
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
    for (const conversation of this.conversations.values()) {
      clearTimeout(conversation.retryTimer);
    }
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
        replierModel: definition.messager.replyer,
        stt: definition.stt === undefined ? undefined : new VoiceTranscriber(
          models.getTranscriber(definition.stt.model),
          definition.stt.model,
          definition.stt.audioConversionCmd
        ),
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
            modelReference: spec.model,
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
        ...(chat.stt === undefined ? [] : [chat.stt.model]),
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
          // Keep asynchronous source selection in transport order, before the 30-row cap.
          this.ingestion = this.ingestion.then(() => this.receiveMessage(chat, message)).catch((error: unknown) => {
            console.error(`[chat:${chat.name}] failed to receive message:`, error);
          });
        });
      }
    } catch (error) {
      this.closed = true;
      this.shutdown.abort();
      await this.ingestion;
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
    await this.ingestion;
    await this.processing;
    await this.stopChats();
  }

  private async stopChats(): Promise<void> {
    for (const conversation of this.conversations.values()) {
      clearTimeout(conversation.retryTimer);
    }
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

  /** Discard ignored traffic before it can evict useful messages from the buffer. */
  private async receiveMessage(chat: ResolvedChat, message: IncomingMessage): Promise<void> {
    if (this.closed) {
      return;
    }
    const sources = message.messages?.length ? message.messages : [message];
    let selected = sources.filter((source) => source.text.trim() !== '/status');
    try {
      selected = await this.selectMessages(chat, selected, message.channel ?? message.senderId);
    } catch {
      // Let the normal worker fail closed, report the error, and decide about retries.
      this.enqueueMessage(chat, message);
      return;
    }
    if (chat.stt === undefined) {
      const count = selected.filter((source) => source.audio !== undefined).length;
      if (count > 0) {
        console.log(`[chat:${chat.name}] skipped ${count} voice message(s) in ${message.channel ?? message.senderId}: no STT model configured`);
        selected = selected.filter((source) => source.audio === undefined);
      }
    }
    const retained = new Set(selected);
    const messages = sources.filter((source) => source.text.trim() === '/status' || retained.has(source));
    if (messages.length > 0) {
      this.enqueueMessage(chat, { ...message, messages });
    }
  }

  /** Logs exclusions at ingestion and when a changed ignore list prunes queued context. */
  private async selectMessages(
    chat: ResolvedChat,
    messages: readonly ConversationMessage[],
    conversationId: string
  ): Promise<ConversationMessage[]> {
    let selected = [...messages];
    for (const filter of chat.filters) {
      if (filter.selectMessages === undefined) {
        continue;
      }
      const next = [...await filter.selectMessages(selected)];
      const retained = new Set(next);
      const excluded = selected.filter((source) => !retained.has(source));
      if (excluded.length > 0) {
        const senders = [...new Set(excluded.map((source) => source.senderId))].join(', ');
        console.log(`[chat:${chat.name}] dropped ${excluded.length} message(s) in ${conversationId} from ${senders} by filter "${filter.name}"`);
      }
      selected = next;
    }
    return selected;
  }

  /** Updates bounded context without adding duplicate conversation entries. */
  private enqueueMessage(chat: ResolvedChat, message: IncomingMessage): void {
    if (this.closed) {
      return;
    }
    const sources = message.messages?.length ? message.messages : [message];
    const statusRequest = sources.find((source) => !source.isSelf && source.text.trim() === '/status' &&
      chat.mainAccount !== undefined && source.senderId === chat.mainAccount);
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
        processing: false, hasPendingMessages: false, selfRevision: 0, retryAttempts: 0
      };
      this.conversations.set(key, conversation);
    }
    conversation.latest = message;
    if (statusRequest !== undefined) {
      conversation.statusRequest = {
        ...message, ...statusRequest, text: '/status', messages: undefined
      };
    }
    if (regularMessages.some((source) => !source.isSelf)) {
      conversation.hasPendingMessages = true;
      conversation.retryAttempts = 0;
      clearTimeout(conversation.retryTimer);
      conversation.retryTimer = undefined;
    }
    for (const source of regularMessages) {
      conversation.messages.push({
        revision: ++conversation.revision,
        message: {
          id: source.id ?? `message:${randomUUID()}`,
          text: source.text,
          senderId: source.senderId,
          isSelf: source.isSelf === true,
          images: source.images,
          audio: source.audio,
          timestamp: source.timestamp && Number.isFinite(Date.parse(source.timestamp))
            ? new Date(Math.min(Date.now(), Date.parse(source.timestamp))).toISOString()
            : new Date().toISOString()
        }
      });
      if (source.isSelf) {
        conversation.selfRevision = conversation.revision;
        // Invalidate a response being generated from context preceding a manual reply.
        if (conversation.processing && conversation.messages.some((entry) => !entry.message.isSelf)) {
          conversation.hasPendingMessages = true;
        }
      }
    }
    conversation.messages = conversation.messages.slice(-30);
    if (!conversation.processing && (conversation.hasPendingMessages || conversation.statusRequest !== undefined)) {
      // Updating an existing Map entry preserves its FIFO position.
      this.pending.set(key, conversation);
    }
    if (this.pending.size > 0) {
      this.startProcessing();
    }
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
        await delay(randomInt(60_000, 180_001), undefined, { signal: this.shutdown.signal });
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
          const selfRevision = conversation.selfRevision;
          let messages = conversation.messages.map((entry) => entry.message);
          // Exclusions apply before all decision filters, regardless of their order.
          try {
            messages = await this.selectMessages(conversation.chat, messages,
              conversation.latest.channel ?? conversation.latest.senderId);
          } catch (error) {
            this.filterFailures += 1;
            throw error;
          }
          const retained = new Set(messages);
          conversation.messages = conversation.messages.filter((entry) => entry.revision > revision || retained.has(entry.message));
          if (conversation.chat.stt !== undefined) {
            messages = await conversation.chat.stt.transcribe(messages, this.shutdown.signal);
          } else {
            messages = messages.filter((source) => source.audio === undefined);
          }
          const latestIncoming = [...messages].reverse().find((source) => !source.isSelf);
          if (latestIncoming === undefined) {
            continue;
          }
          const snapshot: IncomingMessage = {
            ...conversation.latest,
            ...latestIncoming,
            text: messages.map((message) =>
              `${message.timestamp ?? ''} ${message.senderId}: ${message.text}`.trim()).join('\n'),
            messages
          };
          if (await this.handleMessage(conversation, snapshot, selfRevision)) {
            // Preserve arrivals during generation/delivery for the next turn.
            conversation.messages = conversation.messages.filter((entry) => entry.revision > revision);
          }
          conversation.retryAttempts = 0;
        }
      } catch (error) {
        if (!this.closed && !(error instanceof SupersededTurnError)) {
          this.processingFailures += 1;
          this.lastProcessingError = error instanceof PendingMediaError ? 'media pending' :
            error instanceof ResponsesApiError ? `model request failed${error.status === undefined ? '' : ` (HTTP ${error.status})`}` :
              'processing/filter error (see server log)';
          this.lastProcessingErrorAt = new Date().toISOString();
          console.error(`[chat:${conversation.chat.name}] failed to process conversation:`, error);
          if (error instanceof PendingMediaError && !conversation.hasPendingMessages) {
            this.scheduleRetry(key, conversation);
          }
        }
      } finally {
        conversation.processing = false;
        if (!conversation.messages.some((entry) => !entry.message.isSelf)) {
          conversation.hasPendingMessages = false;
          clearTimeout(conversation.retryTimer);
          conversation.retryTimer = undefined;
        }
        if (conversation.messages.length === 0 && conversation.statusRequest === undefined) {
          this.conversations.delete(key);
        } else if (!this.closed && (conversation.hasPendingMessages || conversation.statusRequest !== undefined)) {
          // New arrivals and bounded pre-delivery retries return at the FIFO tail.
          this.pending.set(key, conversation);
        }
      }
    }
    this.replySlotReady = false;
  }

  /** Retries pending media; model generations manage their own retry policy. */
  private scheduleRetry(key: string, conversation: ConversationState): void {
    if (conversation.retryAttempts >= 2 || this.closed) {
      return;
    }
    conversation.retryAttempts += 1;
    const wait = 30_000 * 2 ** (conversation.retryAttempts - 1);
    conversation.retryTimer = setTimeout(() => {
      conversation.retryTimer = undefined;
      if (!this.closed && this.conversations.get(key) === conversation) {
        conversation.hasPendingMessages = true;
        if (!conversation.processing) {
          this.pending.set(key, conversation);
        }
        this.startProcessing();
      }
    }, wait);
  }

  /** Returns true only after a snapshot's reply is successfully delivered. */
  private async handleMessage(conversation: ConversationState, message: IncomingMessage, selfRevision: number): Promise<boolean> {
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
      if ('error' in evaluation) {
        if (!(evaluation.error instanceof PendingMediaError)) {
          this.filterFailures += 1;
        }
        throw evaluation.error;
      }
      if (evaluation.outcome === FilterOutcome.Denied) {
        const reason = evaluation.decidedBy ? ` by filter "${evaluation.decidedBy}"` : '';
        console.log(`[chat:${chat.name}] dropped ${message.messages?.length ?? 1} message(s) in ${message.channel ?? message.senderId}${reason}`);
        return false;
      }
      outcome = evaluation.outcome;
    }
    if (this.closed) {
      return false;
    }

    if (conversation.selfRevision !== selfRevision) {
      throw new SupersededTurnError();
    }
    const result = await chat.replier.replyTo(message, outcome, this.shutdown.signal);
    if (conversation.selfRevision !== selfRevision) {
      throw new SupersededTurnError();
    }
    if (this.closed) {
      return false;
    }
    try {
      await this.memory.update(memoryKey, result.memoryUpdates, message.messages ?? [message]);
    } catch (error) {
      console.error(`[chat:${chat.name}] failed to save conversation notes:`, error);
    }
    const reply = result.reply;
    if (conversation.selfRevision !== selfRevision) {
      throw new SupersededTurnError();
    }
    if (this.closed) {
      return false;
    }
    if (reply === undefined) {
      console.log(`[chat:${chat.name}] skipped reply to ${message.messages?.length ?? 1} message(s) in ${message.channel ?? message.senderId}: replier "${chat.replierModel}" chose not to reply`);
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
    const age = (value: string | undefined) => value === undefined ? 'none' :
      `${Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000))}m ago`;
    const text = [
      `ChatServer running; uptime ${Math.floor(minutes / 60)}h ${minutes % 60}m; pipelines ${this.started.length}/${this.options.chats.length}`,
      `Queue: ${queued.length} conversations, ${buffered} messages; status ${[...this.conversations.values()].filter((item) => item.statusRequest !== undefined).length}; retries ${[...this.conversations.values()].filter((item) => item.retryTimer !== undefined).length}`,
      `Processing errors: ${this.processingFailures} (filters ${this.filterFailures})`,
      `Last processing error: ${this.lastProcessingError ?? 'none'} (${age(this.lastProcessingErrorAt)})`,
      `Deliveries: ${this.deliveries}; failures ${this.deliveryFailures}; last ${age(this.lastDeliveryAt)}`,
      `Adapter: ${chat.messager.name}${health === undefined ? '' : health.active ? ' active' : ' stopped'}; poll failures ${health?.consecutivePollFailures ?? 0}; failed chats ${health?.failedChats ?? 0}`,
      `Last poll: ${age(health?.lastSuccessfulPollAt)}; last poll error: ${age(health?.lastPollErrorAt)}`,
      `Delay: 1–3m; memory: ${MEMORY_RETENTION_MS / (24 * 60 * 60 * 1000)} days/${MEMORY_TOKEN_LIMIT} tokens`
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
