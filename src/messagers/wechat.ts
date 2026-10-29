import {
  MAX_ENCODED_AUDIO_BYTES,
  MAX_ENCODED_IMAGE_BYTES,
  MAX_AUDIO_BYTES,
  MAX_TIMER_MS,
  MEDIA_RESPONSE_OVERHEAD_BYTES,
  WECHAT_BUNDLE_GAP_MS,
  WECHAT_CHAT_PAGE_SIZE,
  WECHAT_MAX_BACKOFF_EXPONENT,
  WECHAT_MESSAGE_PAGE_SIZE,
  WECHAT_POLL_INTERVAL_MS,
  WECHAT_REQUEST_TIMEOUT_MS,
  WECHAT_VOICE_JOB_TIMEOUT_MS,
  WECHAT_VOICE_JOB_POLL_MS,
  WECHAT_VOICE_CANCEL_TIMEOUT_MS
} from '../limit';
import { AudioFile, AudioLoadResult, ImageLoadResult, IncomingMessage, MessageHandler, MessagerAdapter, MessagerStatus, OutgoingMessage } from './interface';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ImageUnavailableError, imageDataUrl } from './images';
import { audioFile } from './audio';
import { MediaUnavailableError } from './media';

/** Options for the outbound-only agent-wechat REST adapter. */
export interface WechatMessagerOptions {
  /** Agent server root URL. Defaults to http://127.0.0.1:6174. */
  baseUrl?: string;
  /** Optional list of chat IDs to monitor. Omit to monitor all chats. */
  chatIds?: readonly string[];
  /** Delay between completed polls. Defaults to 30000 ms. */
  pollIntervalMs?: number;
  /** Timeout for each REST request. Defaults to 30000 ms. */
  timeoutMs?: number;
  /** Maximum timestamp gap for consecutive-message bundles. Defaults to 20000 ms; 0 disables bundling. */
  bundleGapMs?: number;
}

interface Cursor {
  timestamp: number;
  ids: Set<number>;
  signature?: string;
}

interface WechatMessage {
  localId: number;
  timestamp: string;
  content: string;
  type: number;
  sender?: string;
  senderName?: string | null;
  isSelf?: boolean;
  [key: string]: unknown;
}

/** Never pass raw image/voice message XML to models as the message body. */
function messageText(message: WechatMessage): string {
  return message.type === 3 ? '[Image]' : message.type === 34 ? '[Voice]' : message.content;
}

/** The API resolves contact remarks/nicknames separately from the stable sender ID. */
function displayName(message: WechatMessage): string | undefined {
  return typeof message.senderName === 'string' ? message.senderName.trim() || undefined : undefined;
}

/** Retains HTTP status for media retry classification without retaining response bodies. */
class WechatRequestError extends Error {
  public constructor(public readonly status: number, endpoint: string) {
    super(`WeChat ${endpoint.split('?')[0]} returned HTTP ${status}.`);
  }
}

/** Checks REST payloads before using their fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates a positive duration, including values supplied programmatically. */
function duration(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > MAX_TIMER_MS) {
    throw new Error(`WeChat ${label} must be a positive integer up to ${MAX_TIMER_MS}.`);
  }
  return result;
}

/** Receives text and lazy media references by polling agent-wechat; never listens on a port. */
export class WechatMessagerAdapter implements MessagerAdapter {
  public readonly name = 'wechat';
  private readonly baseUrl: string;
  private readonly interval: number;
  private readonly timeout: number;
  private readonly bundleGap: number;
  private readonly cursors = new Map<string, Cursor>();
  private readonly chatFailures = new Map<string, { count: number; retryAt: number }>();
  private readonly operations = new Set<AbortController>();
  private readonly token: string;
  private account?: string;
  private handler?: MessageHandler;
  private startedAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private polling?: Promise<void>;
  private sending: Promise<void> = Promise.resolve();
  private failures = 0;
  private lastSuccessfulPollAt?: string;
  private lastPollError?: string;
  private lastPollErrorAt?: string;

  public constructor(token: string, private readonly options: WechatMessagerOptions = {}) {
    this.token = token.trim();
    if (!this.token) {
      throw new Error('WeChat bearer token must not be empty.');
    }
    const url = new URL(options.baseUrl ?? 'http://127.0.0.1:6174');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash) {
      throw new Error('WeChat baseUrl must be an HTTP(S) URL without credentials, query, or fragment.');
    }
    this.baseUrl = url.toString().replace(/\/+$/, '');
    this.interval = duration(options.pollIntervalMs, WECHAT_POLL_INTERVAL_MS, 'pollIntervalMs');
    this.timeout = duration(options.timeoutMs, WECHAT_REQUEST_TIMEOUT_MS, 'timeoutMs');
    this.bundleGap = options.bundleGapMs === 0 ? 0 : duration(options.bundleGapMs, WECHAT_BUNDLE_GAP_MS, 'bundleGapMs');
  }

  public async start(handler: MessageHandler): Promise<void> {
    if (this.handler !== undefined) {
      throw new Error('WeChat adapter is already started.');
    }
    this.startedAt = Date.now();
    this.cursors.clear();
    this.chatFailures.clear();
    this.failures = 0;
    this.lastSuccessfulPollAt = undefined;
    this.lastPollError = undefined;
    this.lastPollErrorAt = undefined;
    this.handler = handler;
    try {
      this.account = await this.readAccount();
    } catch (error) {
      this.handler = undefined;
      throw error;
    }
    this.schedule(this.interval);
  }

  /** Aborts outstanding requests and waits for polling and queued sends to finish. */
  public async stop(): Promise<void> {
    this.handler = undefined;
    clearTimeout(this.timer);
    for (const controller of this.operations) {
      controller.abort();
    }
    await Promise.allSettled([this.polling, this.sending]);
    this.cursors.clear();
    this.chatFailures.clear();
    this.account = undefined;
  }

  /** Serializes deliveries; the server schedules the delay before building its snapshot. */
  public reply(message: IncomingMessage, reply: OutgoingMessage, signal?: AbortSignal): Promise<void> {
    const send = this.sending.then(async () => {
      this.requireActiveAccount(message);
      signal?.throwIfAborted();
      const chatId = reply.direct ? message.senderId : reply.channel ?? message.channel;
      if (!chatId) {
        throw new Error('WeChat reply requires a destination chat ID.');
      }
      if (reply.voice) {
        if (reply.audio === undefined) {
          throw new Error('Voice reply requires synthesized audio.');
        }
        await this.sendVoice(message, chatId, reply.audio, signal);
        return;
      }
      const result = await this.request('/api/messages/send', { chatId, text: reply.text }, signal);
      if (!isRecord(result) || result.success !== true) {
        throw new Error('WeChat rejected the message send. Check the agent-server logs.');
      }
    });
    // A failed attempt must not poison the queue or cause an automatic retry.
    this.sending = send.catch(() => {});
    return send;
  }

  /** One idempotent upload; success means the agent confirmed the voice job completed. */
  private async sendVoice(message: IncomingMessage, chatId: string, audio: AudioFile, signal?: AbortSignal): Promise<void> {
    if (!audio.data.byteLength || audio.data.byteLength > MAX_AUDIO_BYTES) {
      throw new Error('Voice reply audio is empty or exceeds the audio size limit.');
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) {
      controller.abort();
    }
    this.operations.add(controller);
    const timer = setTimeout(cancel, WECHAT_VOICE_JOB_TIMEOUT_MS);
    let jobId: string | undefined;
    let terminal = false;
    try {
      controller.signal.throwIfAborted();
      const form = new FormData();
      form.set('chatId', chatId);
      form.set('audio', new Blob([new Uint8Array(audio.data)], { type: audio.mimeType }), audio.filename);
      let job = await this.request('/api/messages/voice', form, controller.signal, undefined,
        { 'Idempotency-Key': randomUUID() });
      while (true) {
        if (!isRecord(job) || typeof job.jobId !== 'string' || !job.jobId ||
          typeof job.status !== 'string' || job.chatId !== chatId || job.accountId !== this.account ||
          jobId !== undefined && jobId !== job.jobId) {
          throw new Error('Unexpected WeChat voice job response.');
        }
        jobId = job.jobId;
        this.requireActiveAccount(message);
        controller.signal.throwIfAborted();
        terminal = ['completed', 'failed', 'needs_review', 'cancelled'].includes(job.status);
        if (job.status === 'completed') {
          return;
        }
        if (terminal) {
          throw new Error(`WeChat voice job ${jobId} ${job.status}${typeof job.error === 'string' ? `: ${job.error}` : ''}. Delivery will not be retried.`);
        }
        await delay(WECHAT_VOICE_JOB_POLL_MS, undefined, { signal: controller.signal });
        this.requireActiveAccount(message);
        job = await this.request(`/api/messages/voice/${encodeURIComponent(jobId)}`, undefined, controller.signal);
      }
    } catch (error) {
      if (jobId !== undefined && !terminal) {
        try {
          await this.request(`/api/messages/voice/${encodeURIComponent(jobId)}/cancel`, {},
            AbortSignal.timeout(WECHAT_VOICE_CANCEL_TIMEOUT_MS));
        } catch (cancelError) {
          console.warn(`[wechat] unable to cancel voice job ${jobId}:`, cancelError instanceof Error ? cancelError.message : cancelError);
        }
      }
      if (controller.signal.aborted) {
        throw new Error(`WeChat voice job cancelled or exceeded ${WECHAT_VOICE_JOB_TIMEOUT_MS} ms; delivery may be unconfirmed and will not be retried.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      this.operations.delete(controller);
    }
  }

  private requireActiveAccount(message: IncomingMessage): void {
    this.requireAccount(message.metadata?.wechatAccount);
  }

  private requireAccount(account: unknown): void {
    if (this.handler === undefined || typeof account !== 'string' || account !== this.account) {
      throw new Error('WeChat adapter is stopped or the originating account has changed.');
    }
  }

  /** Requests media only when the server processes its conversation, never during polling. */
  private async loadImage(
    chatId: string,
    localId: number,
    account: string | undefined,
    signal?: AbortSignal
  ): Promise<ImageLoadResult> {
    this.requireAccount(account);
    let result: unknown;
    try {
      result = await this.request(
        `/api/messages/${encodeURIComponent(chatId)}/media/${localId}?quality=best`,
        undefined,
        signal,
        MAX_ENCODED_IMAGE_BYTES + MEDIA_RESPONSE_OVERHEAD_BYTES
      );
    } catch (error) {
      if (error instanceof MediaUnavailableError) {
        throw new ImageUnavailableError(error.message);
      }
      if (error instanceof WechatRequestError && error.status >= 400 && error.status < 500 &&
        error.status !== 408 && error.status !== 429) {
        throw new ImageUnavailableError('WeChat image media is unavailable.');
      }
      throw error;
    }
    this.requireAccount(account);
    if (!isRecord(result) || typeof result.type !== 'string') {
      throw new Error('Unexpected WeChat image media response.');
    }
    if (result.type !== 'image' || result.data === undefined || result.data === null) {
      if (result.retryable === true || (result.type === 'pending' && result.retryable !== false)) {
        return { status: 'pending' };
      }
      return { status: 'unavailable' };
    }
    if (typeof result.data !== 'string') {
      throw new ImageUnavailableError('WeChat image data must be a base64 string.');
    }
    try {
      return { status: 'ready', dataUrl: imageDataUrl(result.data) };
    } catch {
      return { status: 'unavailable' };
    }
  }

  private async loadAudio(chatId: string, localId: number, account: string | undefined, signal?: AbortSignal): Promise<AudioLoadResult> {
    this.requireAccount(account);
    let result: unknown;
    try {
      result = await this.request(`/api/messages/${encodeURIComponent(chatId)}/media/${localId}`,
        undefined, signal, MAX_ENCODED_AUDIO_BYTES + MEDIA_RESPONSE_OVERHEAD_BYTES);
    } catch (error) {
      if (error instanceof MediaUnavailableError || error instanceof WechatRequestError &&
        error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
        return { status: 'unavailable', reason: error.message };
      }
      throw error;
    }
    this.requireAccount(account);
    if (!isRecord(result) || typeof result.type !== 'string') {
      throw new Error('Unexpected WeChat voice media response.');
    }
    if (result.type !== 'voice' || result.data === undefined || result.data === null) {
      if (result.retryable === true || result.type === 'pending' && result.retryable !== false) {
        return { status: 'pending' };
      }
      return { status: 'unavailable' };
    }
    if (typeof result.data !== 'string' || typeof result.format !== 'string') {
      return { status: 'unavailable', reason: 'invalid voice media fields' };
    }
    try {
      return { status: 'ready', audio: audioFile(result.data, result.format, localId) };
    } catch (error) {
      return { status: 'unavailable', reason: error instanceof Error ? error.message : 'invalid voice data' };
    }
  }

  public getStatus(): MessagerStatus {
    return {
      active: this.handler !== undefined,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      consecutivePollFailures: this.failures,
      failedChats: this.chatFailures.size,
      lastPollError: this.lastPollError,
      lastPollErrorAt: this.lastPollErrorAt
    };
  }

  private schedule(delay: number): void {
    if (this.handler === undefined) {
      return;
    }
    this.timer = setTimeout(() => {
      this.polling = this.poll().then(() => {
        this.failures = 0;
        this.lastSuccessfulPollAt = new Date().toISOString();
      }).catch((error: unknown) => {
        if (this.handler !== undefined) {
          this.failures += 1;
          this.recordPollError(error);
          console.error('[wechat] polling failed:', error instanceof Error ? error.message : error);
        }
      }).finally(() => {
        this.schedule(Math.min(MAX_TIMER_MS,
          this.interval * 2 ** Math.min(this.failures, WECHAT_MAX_BACKOFF_EXPONENT)));
      });
    }, delay);
  }

  private async readAccount(): Promise<string> {
    const status = await this.request('/api/status/auth');
    if (!isRecord(status) || status.status !== 'logged_in' ||
      typeof status.loggedInUser !== 'string' || !status.loggedInUser) {
      throw new Error('WeChat is not logged in. Log in using agent-wechat first.');
    }
    return status.loggedInUser;
  }

  private async poll(): Promise<void> {
    const account = await this.readAccount();
    if (account !== this.account) {
      // Never replay another account's history or reuse its cursors.
      this.account = account;
      this.startedAt = Date.now();
      this.cursors.clear();
      this.chatFailures.clear();
    }
    const chats: Record<string, unknown>[] = [];
    const pageSize = WECHAT_CHAT_PAGE_SIZE;
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.request(`/api/chats?limit=${pageSize}&offset=${offset}`);
      if (!Array.isArray(page) || !page.every((chat) => isRecord(chat) && typeof chat.id === 'string')) {
        throw new Error('Unexpected WeChat chats response.');
      }
      chats.push(...page as Record<string, unknown>[]);
      if (page.length < pageSize) {
        break;
      }
    }
    const activeIds = new Set(chats.map((chat) => chat.id as string));
    for (const chatId of this.chatFailures.keys()) {
      if (!activeIds.has(chatId)) {
        this.chatFailures.delete(chatId);
      }
    }
    for (const chat of chats) {
      if (this.handler === undefined) {
        return;
      }
      const chatId = chat.id as string;
      if (this.options.chatIds !== undefined && !this.options.chatIds.includes(chatId)) {
        continue;
      }
      if ((this.chatFailures.get(chatId)?.retryAt ?? 0) > Date.now()) {
        continue;
      }
      const cursor = this.cursors.get(chatId) ?? { timestamp: this.startedAt, ids: new Set<number>() };
      const signature = JSON.stringify([chat.lastMsgLocalId, chat.lastActivityAt, chat.unreadCount]);
      if (cursor.signature === signature) {
        continue;
      }
      try {
        const hadMessages = await this.pollChat(chatId, cursor);
        // An empty result can mean database keys/data aren't ready yet. Retry with
        // backoff rather than caching it as an unchanged, successfully read chat.
        if (!hadMessages && Date.parse(String(chat.lastActivityAt)) >= cursor.timestamp) {
          throw new Error('WeChat returned no messages for an active chat; database data may not be ready.');
        }
        cursor.signature = hadMessages ? signature : undefined;
        this.cursors.set(chatId, cursor);
        this.chatFailures.delete(chatId);
      } catch (error) {
        console.error(`[wechat] failed to read chat ${chatId}:`,
          error instanceof Error ? error.message : error);
        this.recordPollError(error);
        const count = (this.chatFailures.get(chatId)?.count ?? 0) + 1;
        this.chatFailures.set(chatId, {
          count, retryAt: Date.now() + Math.min(MAX_TIMER_MS, this.interval * 2 ** Math.min(count, WECHAT_MAX_BACKOFF_EXPONENT))
        });
      }
    }
  }

  private recordPollError(error: unknown): void {
    this.lastPollError = error instanceof Error ? error.message : 'Unknown polling error';
    this.lastPollErrorAt = new Date().toISOString();
  }

  private async pollChat(chatId: string, cursor: Cursor): Promise<boolean> {
    const messages = new Map<number, WechatMessage>();
    const pageSize = WECHAT_MESSAGE_PAGE_SIZE;
    let hadMessages = false;
    // The upstream API sorts newest first. Page back to the previous timestamp,
    // including its entire second so messages with equal timestamps aren't lost.
    for (let offset = 0; ; offset += pageSize) {
      const page = await this.request(
        `/api/messages/${encodeURIComponent(chatId)}?limit=${pageSize}&offset=${offset}`
      );
      if (!Array.isArray(page)) {
        throw new Error('Unexpected WeChat messages response.');
      }
      hadMessages ||= page.length > 0;
      let reachedHistory = false;
      for (const item of page) {
        if (!isRecord(item) || !Number.isSafeInteger(item.localId) ||
          typeof item.timestamp !== 'string' || !Number.isFinite(Date.parse(item.timestamp)) ||
          typeof item.content !== 'string' || typeof item.type !== 'number' ||
          (item.isSelf !== undefined && typeof item.isSelf !== 'boolean') ||
          (item.sender !== undefined && typeof item.sender !== 'string')) {
          throw new Error('Unexpected WeChat message fields.');
        }
        const message = item as unknown as WechatMessage;
        const timestamp = Date.parse(message.timestamp);
        if (timestamp < cursor.timestamp) {
          reachedHistory = true;
        } else {
          // Keep already-seen rows at the cursor timestamp as boundaries too:
          // newly discovered messages must not merge across a self/other sender.
          messages.set(message.localId, message);
        }
      }
      if (page.length < pageSize || reachedHistory) {
        break;
      }
    }
    let bundle: WechatMessage[] = [];
    const flush = () => {
      if (bundle.length === 0) {
        return;
      }
      this.dispatchBundle(chatId, bundle);
      for (const message of bundle) {
        this.advanceCursor(cursor, message);
      }
      bundle = [];
    };

    for (const message of [...messages.values()].sort((a, b) =>
      Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.localId - b.localId)) {
      if (this.handler === undefined) {
        return hadMessages;
      }
      const timestamp = Date.parse(message.timestamp);
      const alreadySeen = timestamp < cursor.timestamp ||
        (timestamp === cursor.timestamp && cursor.ids.has(message.localId));
      if (!alreadySeen && message.isSelf === true &&
        ((message.type === 1 && message.content) || message.type === 3 || message.type === 34)) {
        flush();
        this.dispatchBundle(chatId, [message]);
        this.advanceCursor(cursor, message);
        continue;
      }
      const eligible = message.isSelf === false && message.sender &&
        ((message.type === 1 && message.content) || message.type === 3 || message.type === 34);
      if (alreadySeen || !eligible) {
        // Even messages we don't deliver interrupt conversational adjacency.
        flush();
        if (!alreadySeen) {
          this.advanceCursor(cursor, message);
        }
        continue;
      }
      const previous = bundle.at(-1);
      if (previous !== undefined && (this.bundleGap === 0 ||
        message.sender !== previous.sender ||
        timestamp - Date.parse(previous.timestamp) > this.bundleGap)) {
        flush();
      }
      bundle.push(message);
    }
    flush();
    return hadMessages;
  }

  /** Delivers one conversational turn, preserving the source messages for metadata consumers. */
  private dispatchBundle(chatId: string, messages: readonly WechatMessage[]): void {
    const first = messages[0];
    const last = messages[messages.length - 1];
    const sender = first.isSelf ? this.account : first.sender;
    if (sender === undefined) {
      return;
    }
    const account = this.account;
    const text = messages.map(messageText).join('\n');
    this.handler?.({
      text,
      senderId: sender,
      senderName: displayName(last),
      isSelf: first.isSelf === true,
      timestamp: last.timestamp,
      channel: chatId,
      messages: messages.map((message) => ({
        id: `message:${message.localId}`,
        text: messageText(message),
        senderId: message.isSelf ? account as string : message.sender as string,
        senderName: displayName(message),
        isSelf: message.isSelf === true,
        timestamp: message.timestamp,
        images: message.type === 3 ? [{
          id: `image:${message.localId}`,
          load: (signal?: AbortSignal) => this.loadImage(chatId, message.localId, account, signal)
        }] : undefined,
        audio: message.type === 34 ? {
          id: `voice:${message.localId}`,
          load: (signal?: AbortSignal) => this.loadAudio(chatId, message.localId, account, signal)
        } : undefined
      })),
      metadata: {
        ...last,
        content: text,
        wechatAccount: this.account,
        localIds: messages.map((message) => message.localId),
        firstTimestamp: first.timestamp,
        lastTimestamp: last.timestamp,
        messages: [...messages]
      }
    });
  }

  private advanceCursor(cursor: Cursor, message: WechatMessage): void {
    const timestamp = Date.parse(message.timestamp);
    if (timestamp > cursor.timestamp) {
      cursor.timestamp = timestamp;
      cursor.ids.clear();
    }
    cursor.ids.add(message.localId);
  }

  private async request(endpoint: string, body?: unknown, signal?: AbortSignal, maxBytes?: number,
    headers: Readonly<Record<string, string>> = {}): Promise<unknown> {
    if (this.handler === undefined) {
      throw new Error('WeChat adapter is stopped.');
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) {
      controller.abort();
    }
    this.operations.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${this.token}`,
          ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...headers },
        body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new WechatRequestError(response.status, endpoint);
      }
      if (maxBytes === undefined) {
        return await response.json() as unknown;
      }
      if (Number(response.headers.get('content-length')) > maxBytes) {
        controller.abort();
        throw new MediaUnavailableError('WeChat media response exceeds the size limit.');
      }
      if (response.body === null) {
        throw new Error('WeChat media response has no body.');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          size += chunk.value.byteLength;
          if (size > maxBytes) {
            controller.abort();
            throw new MediaUnavailableError('WeChat media response exceeds the size limit.');
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      this.operations.delete(controller);
    }
  }
}
