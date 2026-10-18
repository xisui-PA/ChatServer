import { IncomingMessage, MessageHandler, MessagerAdapter, OutgoingMessage } from './interface';

/** Options for the outbound-only agent-wechat REST adapter. */
export interface WechatMessagerOptions {
  /** Agent server root URL. Defaults to http://127.0.0.1:6174. */
  baseUrl?: string;
  /** Optional list of chat IDs to monitor. Omit to monitor all chats. */
  chatIds?: readonly string[];
  /** Delay between completed polls. Defaults to 5000 ms. */
  pollIntervalMs?: number;
  /** Timeout for each REST request. Defaults to 30000 ms. */
  timeoutMs?: number;
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
  isSelf?: boolean;
  [key: string]: unknown;
}

/** Checks REST payloads before using their fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates a positive duration, including values supplied programmatically. */
function duration(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > 2_147_483_647) {
    throw new Error(`WeChat ${label} must be a positive integer up to 2147483647.`);
  }
  return result;
}

/** Receives text by polling agent-wechat; never opens a listening port. */
export class WechatMessagerAdapter implements MessagerAdapter {
  public readonly name = 'wechat';
  private readonly baseUrl: string;
  private readonly interval: number;
  private readonly timeout: number;
  private readonly cursors = new Map<string, Cursor>();
  private readonly requests = new Set<AbortController>();
  private readonly token: string;
  private account?: string;
  private handler?: MessageHandler;
  private startedAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private polling?: Promise<void>;
  private sending: Promise<void> = Promise.resolve();
  private failures = 0;

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
    this.interval = duration(options.pollIntervalMs, 5000, 'pollIntervalMs');
    this.timeout = duration(options.timeoutMs, 30000, 'timeoutMs');
  }

  public async start(handler: MessageHandler): Promise<void> {
    if (this.handler !== undefined) {
      throw new Error('WeChat adapter is already started.');
    }
    this.startedAt = Date.now();
    this.cursors.clear();
    this.failures = 0;
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
    for (const controller of this.requests) {
      controller.abort();
    }
    await Promise.allSettled([this.polling, this.sending]);
    this.cursors.clear();
    this.account = undefined;
  }

  /** Serializes sends because the upstream server drives a shared WeChat UI. */
  public reply(message: IncomingMessage, reply: OutgoingMessage): Promise<void> {
    const send = this.sending.then(async () => {
      if (this.handler === undefined || message.metadata?.wechatAccount !== this.account) {
        throw new Error('WeChat adapter is stopped or the originating account has changed.');
      }
      const chatId = reply.direct ? message.senderId : reply.channel ?? message.channel;
      if (!chatId) {
        throw new Error('WeChat reply requires a destination chat ID.');
      }
      const result = await this.request('/api/messages/send', { chatId, text: reply.text });
      if (!isRecord(result) || result.success !== true) {
        throw new Error('WeChat rejected the message send. Check the agent-server logs.');
      }
    });
    // Keep later sends usable after a rejection. Never retry a send automatically.
    this.sending = send.catch(() => {});
    return send;
  }

  private schedule(delay: number): void {
    if (this.handler === undefined) {
      return;
    }
    this.timer = setTimeout(() => {
      this.polling = this.poll().then(() => {
        this.failures = 0;
      }).catch((error: unknown) => {
        if (this.handler !== undefined) {
          this.failures += 1;
          console.error('[wechat] polling failed:', error instanceof Error ? error.message : error);
        }
      }).finally(() => {
        this.schedule(Math.min(2_147_483_647,
          this.interval * 2 ** Math.min(this.failures, 6)));
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
    }
    const chats: Record<string, unknown>[] = [];
    const pageSize = 100;
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
    const failures: unknown[] = [];
    for (const chat of chats) {
      if (this.handler === undefined) {
        return;
      }
      const chatId = chat.id as string;
      if (this.options.chatIds !== undefined && !this.options.chatIds.includes(chatId)) {
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
      } catch (error) {
        console.error(`[wechat] failed to read chat ${chatId}:`,
          error instanceof Error ? error.message : error);
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to read ${failures.length} WeChat chat(s).`);
    }
  }

  private async pollChat(chatId: string, cursor: Cursor): Promise<boolean> {
    const messages = new Map<number, WechatMessage>();
    const pageSize = 100;
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
        } else if (timestamp > cursor.timestamp || !cursor.ids.has(message.localId)) {
          messages.set(message.localId, message);
        }
      }
      if (page.length < pageSize || reachedHistory) {
        break;
      }
    }
    for (const message of [...messages.values()].sort((a, b) =>
      Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.localId - b.localId)) {
      if (this.handler === undefined) {
        return hadMessages;
      }
      if (message.isSelf === false && message.type === 1 && message.content && message.sender) {
        this.handler({
          text: message.content,
          senderId: message.sender,
          channel: chatId,
          metadata: { ...message, wechatAccount: this.account }
        });
      }
      const timestamp = Date.parse(message.timestamp);
      if (timestamp > cursor.timestamp) {
        cursor.timestamp = timestamp;
        cursor.ids.clear();
      }
      cursor.ids.add(message.localId);
    }
    return hadMessages;
  }

  private async request(endpoint: string, body?: unknown): Promise<unknown> {
    if (this.handler === undefined) {
      throw new Error('WeChat adapter is stopped.');
    }
    const controller = new AbortController();
    this.requests.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`WeChat ${endpoint.split('?')[0]} returned HTTP ${response.status}.`);
      }
      return await response.json() as unknown;
    } finally {
      clearTimeout(timer);
      this.requests.delete(controller);
    }
  }
}
