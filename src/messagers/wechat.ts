import {
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_SSE_ERROR_BYTES,
  MAX_SSE_FRAME_CHARS,
  MAX_SSE_LINE_CHARS,
  MAX_TIMER_MS,
  WECHAT_MAX_BACKOFF_EXPONENT,
  WECHAT_MAX_EVENT_CURSOR,
  WECHAT_NAME_CACHE_SIZE,
  WECHAT_NAME_MISS_TTL_MS,
  WECHAT_NAME_TTL_MS,
  WECHAT_READER_CANCEL_TIMEOUT_MS,
  WECHAT_RECENT_MESSAGE_LIMIT,
  WECHAT_RECONNECT_INTERVAL_MS,
  WECHAT_REQUEST_TIMEOUT_MS,
  WECHAT_SEND_CANCEL_TIMEOUT_MS,
  WECHAT_SEND_TIMEOUT_MS
} from '../limit';
import { AudioFile, AudioLoadResult, ImageLoadResult, IncomingMessage, MessageHandler, MessagerAdapter, MessagerStatus, OutgoingMessage } from './interface';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ImageUnavailableError, imageDataUrl } from './images';
import { audioExtension, audioFile } from './audio';
import { MediaUnavailableError } from './media';
import { isBoolean, isNumber, isRecord, isString } from '../type-guards';

/** Options for the agent-wechat v2.1 event-stream adapter. */
export interface WechatMessagerOptions {
  /**
   * agent-wechat server root, normally http://127.0.0.1:6174 without `/v1`; routes add the
   * `/v1` API prefix themselves. A trailing `/v1` is stripped rather than doubled.
   */
  baseUrl?: string;
  /** Optional daemon account ID. Omit to use the only authenticated account. */
  accountId?: string;
  /** Optional list of thread IDs to monitor. Omit to monitor all threads. */
  chatIds?: readonly string[];
  /** Base delay before reconnecting an interrupted event stream. Defaults to 1000 ms; doubles per failure. */
  reconnectIntervalMs?: number;
  /** Timeout for REST requests and for SSE connect/idle waits. Defaults to 30000 ms. */
  timeoutMs?: number;
}

/** A daemon account and the WeChat identity signed in to it. */
interface AccountSummary {
  id: string;
  ownUsername?: string;
  authenticated: boolean;
}

/** The daemon account and signed-in username that produced one read. */
interface Identity {
  account: string | undefined;
  username: string | undefined;
}

/** The two outbound ID spaces whose updates can confirm a send: text sends and media jobs. */
type SendFamily = 'send' | 'job';

/** A terminal confirmation: `accepted` succeeds and every TERMINAL_STATES value fails. */
interface SendOutcome {
  state: string;
  detail?: string;
}

/** One submitted, nonterminal outbound operation waiting for its SSE update. */
interface PendingSend {
  key: string;
  id: string;
  family: SendFamily;
  label: string;
  account: string;
  username: string | undefined;
  threadId: string;
  state: string;
  detail?: string;
  settled: boolean;
  read(signal: AbortSignal): Promise<{ id: string; state: string; detail?: string }>;
  resolve: (outcome: SendOutcome) => void;
  reject: (error: Error) => void;
  cleanup?: () => void;
  reconcile?: AbortController;
}

/** One validated server-sent event. */
interface StreamEvent {
  cursor: string;
  kind: string;
  data: Record<string, unknown>;
}

/** One complete SSE frame; comments and partial lines never dispatch. */
interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

/** NativeMessage fields used by this adapter; other fields are ignored. */
interface NativeMessage {
  id: string;
  accountId: string;
  threadId: string;
  senderId: string | null;
  type: number;
  direction: 'incoming' | 'outgoing' | null;
  body: string | null;
  createdAt: string | null;
}

/** One attachment copy and whether its bytes are cached. */
interface MediaAssetInfo {
  id: string;
  kind: string;
  variant: string;
  actualVariant: string | null;
  state: string;
  contentType: string | null;
  retryable: boolean;
}

/** A submitted send whose state can be read and cancelled. */
interface SendHandle {
  id: string;
  /** State the daemon reported when the send was submitted. */
  state: string;
  detail?: string;
  read(signal: AbortSignal): Promise<{ id: string; state: string; detail?: string }>;
  cancel(): Promise<void>;
}

/** Page shape shared by the daemon's list routes. */
interface NativePage {
  items: unknown[];
  nextCursor: string | null;
  asOfEventCursor?: string;
}

const DIRECTIONS = new Set(['incoming', 'outgoing']);
const SEND_STATES = new Set(['queued', 'submitting', 'accepted', 'failed', 'needs_review', 'cancelled']);
const JOB_STATES = new Set([
  'queued', 'running', 'accepted', 'failed', 'needs_review', 'cancelled', 'expired', 'unsupported'
]);
const TERMINAL_STATES = new Set(['failed', 'needs_review', 'cancelled', 'expired', 'unsupported']);
const IMAGE_VARIANTS = ['original', 'standard', 'thumbnail'];
const VOICE_VARIANTS = ['normal', 'encoded'];
const EVENT_CURSOR_PATTERN = /^(0|[1-9][0-9]{0,18})$/;

/** Trims one optional name field; blank values never win. */
function trimmedName(value: unknown): string | undefined {
  return isString(value) ? value.trim() || undefined : undefined;
}

/** Never pass raw image/voice message content to models as the message body. */
function messageText(message: NativeMessage): string {
  return message.type === 3 ? '[Image]' : message.type === 34 ? '[Voice]' : message.body ?? '';
}

/** Resolves a message time; a null or unparsable value cannot be ordered against the cutoff. */
function messageTime(message: NativeMessage): number | undefined {
  if (message.createdAt === null) {
    return undefined;
  }
  const time = Date.parse(message.createdAt);
  return Number.isFinite(time) ? time : undefined;
}

/** List routes may include tombstones for rows removed since the first page. */
function isTombstone(value: unknown): boolean {
  return isRecord(value) && value.deleted === true && isString(value.id);
}

/** Validates a positive duration, including values supplied programmatically. */
function duration(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > MAX_TIMER_MS) {
    throw new Error(`WeChat ${label} must be a positive integer up to ${MAX_TIMER_MS}.`);
  }
  return result;
}

/** Parses one account entry from the list or single-account route. */
function parseAccount(value: unknown): AccountSummary {
  if (!isRecord(value) || !isString(value.id) || !value.id ||
    !isBoolean(value.authenticated)) {
    throw new Error('Unexpected WeChat account entry.');
  }
  const username = isString(value.ownUsername) ? value.ownUsername.trim() : '';
  return { id: value.id, authenticated: value.authenticated,
    ...(username ? { ownUsername: username } : {}) };
}

/** Event cursors are decimal i64 strings and may exceed Number.MAX_SAFE_INTEGER. */
function parseEventCursor(value: unknown, label: string): string {
  if (!isString(value) || !EVENT_CURSOR_PATTERN.test(value) ||
    BigInt(value) > WECHAT_MAX_EVENT_CURSOR) {
    throw new Error(`Unexpected WeChat ${label}.`);
  }
  return value;
}

/** True when `cursor` is already covered by the checkpoint, so a replay must be skipped. */
function cursorCovered(cursor: string, checkpoint: string | undefined): boolean {
  return checkpoint !== undefined && BigInt(cursor) <= BigInt(checkpoint);
}

/** Parses the daemon's `{ items, nextCursor }` page shape and optional event high-water. */
function parsePage(value: unknown, label: string): NativePage {
  if (!isRecord(value) || !Array.isArray(value.items) ||
    !(value.nextCursor === null || isString(value.nextCursor)) ||
    !(value.asOfEventCursor === undefined || isString(value.asOfEventCursor))) {
    throw new Error(`Unexpected WeChat ${label} response.`);
  }
  return {
    items: value.items,
    nextCursor: value.nextCursor,
    ...(value.asOfEventCursor === undefined
      ? {}
      : { asOfEventCursor: parseEventCursor(value.asOfEventCursor, `${label} event cursor`) })
  };
}

/** Parses the readable fields of one saved message. */
function parseMessage(value: unknown, account: string, threadId: string): NativeMessage {
  if (!isRecord(value) || !isString(value.id) || !value.id ||
    value.accountId !== account || value.threadId !== threadId ||
    !(value.senderId === null || isString(value.senderId)) ||
    !isNumber(value.type) || !Number.isSafeInteger(value.type) ||
    !(value.direction === null || (isString(value.direction) && DIRECTIONS.has(value.direction))) ||
    !(value.body === null || isString(value.body)) ||
    !(value.createdAt === null || isString(value.createdAt))) {
    throw new Error('Unexpected WeChat message fields.');
  }
  if (value.createdAt !== null && !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error('Unexpected WeChat message time.');
  }
  return {
    id: value.id,
    accountId: value.accountId,
    threadId: value.threadId,
    senderId: value.senderId,
    type: value.type,
    direction: value.direction as 'incoming' | 'outgoing' | null,
    body: value.body,
    createdAt: value.createdAt
  };
}

/** Parses one attachment copy; tombstones are ignored. */
function parseMediaAsset(value: unknown, account: string, messageId: string): MediaAssetInfo | undefined {
  if (isTombstone(value)) {
    return undefined;
  }
  // Another account's or another message's attachment is never ours to fetch.
  if (isRecord(value) && (value.accountId !== account || value.messageId !== messageId)) {
    return undefined;
  }
  if (!isRecord(value) || !isString(value.id) || !value.id ||
    !isString(value.kind) || !isString(value.variant) ||
    !isString(value.state) || !isBoolean(value.retryable) ||
    !(value.actualVariant === null || value.actualVariant === undefined || isString(value.actualVariant)) ||
    !(value.contentType === null || value.contentType === undefined || isString(value.contentType))) {
    throw new Error('Unexpected WeChat media asset fields.');
  }
  return {
    id: value.id,
    kind: value.kind,
    variant: value.variant,
    actualVariant: value.actualVariant ?? null,
    state: value.state,
    contentType: value.contentType ?? null,
    retryable: value.retryable
  };
}

/** Media copy preference for the best available quality of each supported kind. */
function variantRank(kind: 'image' | 'voice', asset: MediaAssetInfo): number {
  const order = kind === 'image' ? IMAGE_VARIANTS : VOICE_VARIANTS;
  const variant = asset.actualVariant ?? asset.variant;
  const index = order.indexOf(variant);
  return index === -1 ? order.length : index;
}

/** Client media errors are terminal; timeouts and rate limits remain retryable. */
function isTerminalMediaStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Cancels one reader without letting an unresponsive source block shutdown, then
 * releases the lock when the pending read has settled.
 */
async function cancelBounded(reader: ReadableStreamDefaultReader<Uint8Array>, wait: number):
Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), wait);
  });
  try {
    await Promise.race([reader.cancel().catch(() => 'cancelled'), deadline]);
  } finally {
    clearTimeout(timer);
  }
  try {
    reader.releaseLock();
  } catch {
    // A still-pending read holds the lock; the response is discarded either way.
  }
}

/** Reads at most `maxBytes` of a response body, bounded by a deadline and optional abort. */
async function readBoundedText(
  response: Response,
  maxBytes: number,
  timeout: number,
  signal?: AbortSignal
): Promise<string | undefined> {
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  if (signal?.aborted === true) {
    await cancelBounded(reader, WECHAT_READER_CANCEL_TIMEOUT_MS);
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveDeadline = () => {};
  const deadline = new Promise<'timeout' | 'aborted'>((resolve) => {
    resolveDeadline = () => resolve('aborted');
    timer = setTimeout(() => resolve('timeout'), timeout);
    signal?.addEventListener('abort', resolveDeadline, { once: true });
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === 'timeout' || next === 'aborted') {
        return undefined;
      }
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > maxBytes) {
        return undefined;
      }
      chunks.push(next.value);
    }
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', resolveDeadline);
    await cancelBounded(reader, WECHAT_READER_CANCEL_TIMEOUT_MS);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Retains HTTP status for media retry classification without retaining response bodies. */
class WechatRequestError extends Error {
  public constructor(public readonly status: number, endpoint: string) {
    super(`WeChat ${endpoint.split('?')[0]} returned HTTP ${status}.`);
  }
}

/** The daemon no longer retains events after the supplied cursor. */
class EventCursorExpiredError extends Error {
  public constructor() {
    super('WeChat event cursor expired.');
  }
}

/** The daemon account or signed-in username changed while an event was in flight. */
class AccountChangedError extends Error {}

/**
 * Incremental SSE parser. UTF-8 decoding happens before this class, so chunks may
 * split lines but never characters; only complete frames are returned.
 */
class SseParser {
  private buffer = '';
  private data: string[] = [];
  private dataChars = 0;
  private id?: string;
  private event?: string;
  /** The previous chunk ended with CR, so a leading LF completes that CRLF. */
  private pendingCr = false;

  /** Appends decoded text and returns every frame completed by it. */
  public push(value: string): SseFrame[] {
    let chunk = value;
    if (this.pendingCr) {
      this.pendingCr = false;
      if (chunk.startsWith('\n')) {
        chunk = chunk.slice(1);
      }
    }
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    let start = 0;
    let index = 0;
    while (index < this.buffer.length) {
      const character = this.buffer[index];
      if (character !== '\n' && character !== '\r') {
        index += 1;
        continue;
      }
      if (index - start > MAX_SSE_LINE_CHARS) {
        throw new Error('WeChat event stream line exceeded its size limit.');
      }
      const line = this.buffer.slice(start, index);
      if (character === '\r' && index === this.buffer.length - 1) {
        // A CRLF may be split across chunks; the terminator already applied.
        this.pendingCr = true;
        index += 1;
      } else {
        index += character === '\r' && this.buffer[index + 1] === '\n' ? 2 : 1;
      }
      const frame = this.line(line);
      if (frame !== undefined) {
        frames.push(frame);
      }
      start = index;
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length > MAX_SSE_LINE_CHARS) {
      throw new Error('WeChat event stream line exceeded its size limit.');
    }
    return frames;
  }

  /** Consumes one line without dispatching anything until a blank line arrives. */
  private line(line: string): SseFrame | undefined {
    if (line === '') {
      return this.dispatch();
    }
    if (line.startsWith(':')) {
      // A comment is also the daemon's 15-second keepalive.
      return undefined;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'data') {
      this.dataChars += value.length + (this.data.length === 0 ? 0 : 1);
      if (this.dataChars > MAX_SSE_FRAME_CHARS) {
        throw new Error('WeChat event frame exceeded its size limit.');
      }
      this.data.push(value);
    } else if (field === 'id') {
      if (!value.includes('\u0000')) {
        this.id = value;
      }
    } else if (field === 'event') {
      this.event = value;
    }
    return undefined;
  }

  private dispatch(): SseFrame | undefined {
    if (this.data.length === 0 && this.event === undefined) {
      this.id = undefined;
      return undefined;
    }
    const frame: SseFrame = {
      data: this.data.join('\n'),
      ...(this.id === undefined ? {} : { id: this.id }),
      ...(this.event === undefined ? {} : { event: this.event })
    };
    this.data = [];
    this.dataChars = 0;
    this.id = undefined;
    this.event = undefined;
    return frame;
  }
}

/** Receives text and lazy media references from agent-wechat's event stream; never listens on a port. */
export class WechatMessagerAdapter implements MessagerAdapter {
  public readonly name = 'wechat';
  private readonly baseUrl: string;
  private readonly reconnect: number;
  private readonly timeout: number;
  private readonly operations = new Set<AbortController>();
  private readonly names = new Map<string, { name?: string; expires: number }>();
  /** Recent live message IDs, bounded; the SSE cursor checkpoint is the primary dedupe. */
  private readonly seen = new Set<string>();
  /** Nonterminal outbound operations waiting for a matching event-stream update. */
  private readonly pending = new Map<string, PendingSend>();
  private readonly token: string;
  private account?: string;
  private selfUsername?: string;
  private handler?: MessageHandler;
  private startedAt = 0;
  private streamAbort = new AbortController();
  private streaming?: Promise<void>;
  private sending: Promise<void> = Promise.resolve();
  private after?: string;
  private attempted = false;
  private failures = 0;
  private lastEventAt?: string;
  private lastStreamConnectedAt?: string;
  private lastStreamActivityAt?: string;
  private lastError?: string;
  private lastErrorAt?: string;

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
    const root = url.toString().replace(/\/+$/, '');
    // The convention is the server root; strip a supplied `/v1` so no route becomes `/v1/v1`.
    this.baseUrl = root.endsWith('/v1') ? root.slice(0, -3) : root;
    this.reconnect = duration(options.reconnectIntervalMs, WECHAT_RECONNECT_INTERVAL_MS, 'reconnectIntervalMs');
    this.timeout = duration(options.timeoutMs, WECHAT_REQUEST_TIMEOUT_MS, 'timeoutMs');
    if (options.accountId !== undefined && !options.accountId.trim()) {
      throw new Error('WeChat accountId must be a non-empty daemon account ID.');
    }
  }

  /** Resolves the configured account, then starts authenticated event streaming. */
  public async start(handler: MessageHandler): Promise<void> {
    if (this.handler !== undefined) {
      throw new Error('WeChat adapter is already started.');
    }
    this.resetState();
    this.streamAbort = new AbortController();
    this.startedAt = Date.now();
    this.handler = handler;
    try {
      this.adoptAccount(await this.readAccount(), true);
    } catch (error) {
      this.handler = undefined;
      throw error;
    }
    // The long-lived stream stays in the background so a transient daemon failure
    // cannot prevent the server from starting.
    this.streaming = this.streamLoop().catch((error: unknown) => {
      if (this.handler !== undefined) {
        console.error('[wechat] event stream stopped unexpectedly:', error);
      }
    });
  }

  /** Aborts stream reads and backoff sleeps, then waits for processing and sends to finish. */
  public async stop(): Promise<void> {
    this.handler = undefined;
    this.streamAbort.abort();
    for (const controller of this.operations) {
      controller.abort();
    }
    await Promise.allSettled([this.streaming, this.sending]);
    this.streaming = undefined;
    this.rejectPending('WeChat adapter stopped before delivery was confirmed.');
    this.names.clear();
    this.seen.clear();
    this.after = undefined;
    this.account = undefined;
    this.selfUsername = undefined;
  }

  /** Serializes deliveries; the server schedules the delay before building its snapshot. */
  public reply(message: IncomingMessage, reply: OutgoingMessage, signal?: AbortSignal): Promise<void> {
    const send = this.sending.then(async () => {
      this.requireActiveAccount(message);
      signal?.throwIfAborted();
      // Fix the originating origin so a later switch cannot retarget this delivery.
      const account = this.accountId;
      const accountPath = this.accountPath;
      const destination = reply.direct ? message.senderId : reply.channel ?? message.channel;
      if (!destination) {
        throw new Error('WeChat reply requires a destination thread ID.');
      }
      // Validate every attachment before uploading or sending any part of the reply.
      const images = (reply.images ?? []).map((image) => this.validateImage(image));
      if (images.length > 0 && (reply.voice || reply.audio !== undefined)) {
        throw new Error('WeChat image replies cannot also contain voice audio.');
      }
      const voice = reply.voice ? this.validateVoice(reply.audio) : undefined;
      if (images.length > 0) {
        // The v2 API has no combined image/text send; a caption is a separate text send.
        for (const image of images) {
          this.requireActiveAccount(message);
          signal?.throwIfAborted();
          await this.sendMedia(message, account, accountPath, destination, 'image', image, signal);
        }
        if (reply.text.trim()) {
          await this.sendText(message, account, accountPath, destination, reply.text, signal);
        }
        return;
      }
      if (voice !== undefined) {
        await this.sendMedia(message, account, accountPath, destination, 'voice', voice, signal);
        return;
      }
      await this.sendText(message, account, accountPath, destination, reply.text, signal);
    });
    // A failed attempt must not poison the queue or cause an automatic retry.
    this.sending = send.catch(() => {});
    return send;
  }

  public getStatus(): MessagerStatus {
    return {
      active: this.handler !== undefined,
      lastEventAt: this.lastEventAt,
      lastStreamConnectedAt: this.lastStreamConnectedAt,
      lastStreamActivityAt: this.lastStreamActivityAt,
      consecutiveFailures: this.failures,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt
    };
  }

  /** Daemon account ID, never the signed-in contact username. */
  private get accountId(): string {
    if (this.account === undefined) {
      throw new Error('WeChat adapter is not started.');
    }
    return this.account;
  }

  private get accountPath(): string {
    return `/v1/accounts/${encodeURIComponent(this.accountId)}`;
  }

  private resetState(): void {
    this.rejectPending('WeChat adapter restarted before delivery was confirmed.');
    this.names.clear();
    this.seen.clear();
    this.after = undefined;
    this.attempted = false;
    this.failures = 0;
    this.lastEventAt = undefined;
    this.lastStreamConnectedAt = undefined;
    this.lastStreamActivityAt = undefined;
    this.lastError = undefined;
    this.lastErrorAt = undefined;
  }

  /** Applies a resolved account, clearing session state when the daemon ID or identity changes. */
  private adoptAccount(account: AccountSummary, initial = false): void {
    if (account.id === this.account && account.ownUsername === this.selfUsername) {
      return;
    }
    // Pending sends belong to the old identity; settle them instead of resolving a
    // different account's event or leaving their callers until the full deadline.
    this.rejectPending('WeChat account changed before delivery was confirmed.');
    this.account = account.id;
    this.selfUsername = account.ownUsername;
    if (!initial) {
      // A switch or re-login resets the startup cutoff so the new identity does not
      // inherit another account's event cursor or message window.
      this.startedAt = Date.now();
    }
    this.names.clear();
    this.seen.clear();
    this.after = undefined;
  }

  private requireActiveAccount(message: IncomingMessage): void {
    this.requireAccount(message.metadata?.wechatAccount, message.metadata?.wechatUsername);
  }

  /**
   * Both the daemon account and the signed-in identity must match the active session.
   * There is no bypass for a missing username: an origin without a recorded WeChat
   * username cannot be proven to belong to the current login.
   */
  private requireAccount(account: unknown, username: unknown): void {
    if (this.handler === undefined || this.selfUsername === undefined ||
      !isString(account) || account !== this.account ||
      !isString(username) || username !== this.selfUsername) {
      throw new Error('WeChat adapter is stopped or the originating account has changed.');
    }
  }

  /** The daemon account and signed-in username currently backing this adapter. */
  private get identity(): Identity {
    return { account: this.account, username: this.selfUsername };
  }

  /**
   * Rejects work whose captured login is no longer active. The same daemon account can be
   * re-logged into a different WeChat identity, so the signed-in username is compared too.
   */
  private requireIdentity(origin: Identity): void {
    if (this.handler === undefined || this.account !== origin.account ||
      this.selfUsername !== origin.username) {
      throw new AccountChangedError();
    }
  }

  /** Reads the configured account or requires exactly one authenticated account. */
  private async readAccount(): Promise<AccountSummary> {
    const configured = this.options.accountId?.trim();
    if (configured !== undefined) {
      let entry: unknown;
      try {
        entry = await this.request(`/v1/accounts/${encodeURIComponent(configured)}`);
      } catch (error) {
        if (error instanceof WechatRequestError && error.status === 404) {
          throw new Error(`WeChat account "${configured}" is not visible to this token.`);
        }
        throw error;
      }
      const account = parseAccount(entry);
      this.requireUsable(account, configured);
      return account;
    }
    const body = await this.request('/v1/accounts');
    if (!isRecord(body) || !Array.isArray(body.items)) {
      throw new Error('Unexpected WeChat accounts response.');
    }
    const authenticated = body.items.map(parseAccount).filter((item) => item.authenticated);
    if (authenticated.length === 0) {
      throw new Error('WeChat has no authenticated account. Log in using agent-wechat first.');
    }
    if (authenticated.length > 1) {
      throw new Error(`WeChat has ${authenticated.length} authenticated accounts ` +
        `(${authenticated.map((item) => item.id).join(', ')}); set messager.options.accountId.`);
    }
    this.requireUsable(authenticated[0], 'selected');
    return authenticated[0];
  }

  private requireUsable(account: AccountSummary, requested: string): void {
    if (!account.authenticated) {
      throw new Error(`WeChat account "${requested}" is not authenticated. Log in using agent-wechat first.`);
    }
    if (account.ownUsername === undefined) {
      throw new Error(`WeChat account "${requested}" does not report a signed-in username.`);
    }
  }

  /**
   * Keeps one authenticated event stream open. Startup and an expired cursor both rebase
   * on one current-tail lookup; events missed after expiry are intentionally skipped.
   * Reconnects resume from the last checkpoint, and every failed attempt backs off.
   */
  private async streamLoop(): Promise<void> {
    while (this.handler !== undefined) {
      try {
        if (this.attempted) {
          this.adoptAccount(await this.readAccount());
        }
        this.attempted = true;
        if (this.after === undefined) {
          // Capture the login first: a switch or shutdown during the lookup means the
          // tail it returns belongs to a session this loop must not use.
          this.after = await this.readCurrentCursor(this.identity);
        }
        if (this.handler === undefined) {
          return;
        }
        await this.streamOnce();
        if (this.handler === undefined) {
          return;
        }
        throw new Error('WeChat event stream closed.');
      } catch (error) {
        if (this.handler === undefined) {
          return;
        }
        if (error instanceof AccountChangedError) {
          // A switch restarts the stream promptly, still under the capped backoff so a
          // login that keeps failing revalidation cannot spin.
          await this.backoff();
          continue;
        }
        this.recordFailure(error);
        if (error instanceof EventCursorExpiredError) {
          // The daemon no longer retains events after this cursor. Rebase at the current
          // tail and intentionally skip the missed window instead of replaying history.
          // Repeated expiry still backs off because every expiry records a failure.
          this.after = undefined;
          console.warn('[wechat] event cursor expired; resuming at the current tail.');
        }
        if (this.handler !== undefined) {
          await this.backoff();
        }
      }
    }
  }

  /** Reads one page only for its `asOfEventCursor`, seeding or rebasing the checkpoint. */
  private async readCurrentCursor(origin: Identity): Promise<string> {
    const page = parsePage(await this.request(`${this.accountPath}/threads?limit=1`), 'threads');
    // A switch or shutdown during the lookup invalidates this tail and this attempt.
    this.requireIdentity(origin);
    if (page.asOfEventCursor === undefined) {
      throw new Error('WeChat thread listing did not report an event cursor.');
    }
    return page.asOfEventCursor;
  }

  /** Opens the event stream and dispatches complete frames sequentially. */
  private async streamOnce(): Promise<void> {
    if (this.handler === undefined) {
      return;
    }
    if (this.after === undefined) {
      throw new Error('WeChat event stream has no checkpoint.');
    }
    const checkpoint = parseEventCursor(this.after, 'event cursor');
    const controller = new AbortController();
    this.operations.add(controller);
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let reason: string | undefined;
    const expire = (label: string) => {
      reason = label;
      controller.abort();
    };
    connectTimer = setTimeout(() => expire('connect timed out'), this.timeout);
    try {
      const response = await fetch(
        `${this.baseUrl}${this.accountPath}/events/stream?after=${encodeURIComponent(checkpoint)}`,
        {
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' },
          signal: controller.signal
        }
      );
      clearTimeout(connectTimer);
      connectTimer = undefined;
      if (!response.ok) {
        const detail = await this.streamError(response, controller.signal);
        if (detail.code === 'event_cursor_expired') {
          throw new EventCursorExpiredError();
        }
        throw new Error(`WeChat event stream returned HTTP ${response.status}` +
          `${detail.message === undefined ? '.' : `: ${detail.message}`}`);
      }
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (response.body === null || !contentType.includes('text/event-stream')) {
        throw new Error('Unexpected WeChat event stream response.');
      }
      this.lastStreamConnectedAt = new Date().toISOString();
      this.lastStreamActivityAt = this.lastStreamConnectedAt;
      // A reconnect can miss updates while detached. Read each pending operation once;
      // this is fire-and-forget so frame dispatch never waits on a status read.
      this.reconcilePending();
      const reader = response.body.getReader();
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const resetIdle = () => {
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
        }
        idleTimer = setTimeout(() => expire('idle wait timed out'), this.timeout);
      };
      resetIdle();
      try {
        while (this.handler !== undefined) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          resetIdle();
          this.noteStreamActivity();
          for (const frame of parser.push(decoder.decode(chunk.value, { stream: true }))) {
            // Reading and dispatching may outlast the idle deadline; heartbeat comments
            // stay queued in the socket and the next read refreshes the deadline.
            if (idleTimer !== undefined) {
              clearTimeout(idleTimer);
              idleTimer = undefined;
            }
            await this.commitFrame(frame);
            if (this.handler === undefined) {
              return;
            }
            resetIdle();
          }
        }
        if (this.handler === undefined) {
          return;
        }
        for (const frame of parser.push(decoder.decode())) {
          await this.commitFrame(frame);
        }
      } finally {
        // Close the connection when dispatch or protocol handling fails so the
        // reconnect can replay the uncheckpointed event from the prior cursor.
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (reason !== undefined) {
        throw new Error(`WeChat event stream ${reason}.`);
      }
    } catch (error) {
      if (reason !== undefined && this.handler !== undefined) {
        throw new Error(`WeChat event stream ${reason}.`);
      }
      throw error;
    } finally {
      clearTimeout(connectTimer);
      clearTimeout(idleTimer);
      this.operations.delete(controller);
    }
  }

  /** Handles one complete SSE frame, then checkpoints its cursor. */
  private async commitFrame(frame: SseFrame): Promise<void> {
    if (frame.event !== undefined && frame.event !== 'message') {
      if (frame.event !== 'error') {
        // Named events other than errors carry no messages and are not checkpoints.
        return;
      }
      let code: string | undefined;
      try {
        const value = JSON.parse(frame.data) as unknown;
        if (isRecord(value) && isRecord(value.error) && isString(value.error.code)) {
          code = value.error.code;
        }
      } catch {
        // An unreadable error frame is still a failed stream.
      }
      if (code === 'event_cursor_expired') {
        throw new EventCursorExpiredError();
      }
      throw new Error(`WeChat event stream error${code === undefined ? '' : `: ${code}`}.`);
    }
    const cursor = parseEventCursor(frame.id, 'event cursor');
    let value: unknown;
    try {
      value = JSON.parse(frame.data) as unknown;
    } catch {
      throw new Error('Unexpected WeChat event payload.');
    }
    if (!isRecord(value) || !isString(value.kind) || !value.kind ||
      !isRecord(value.data) || parseEventCursor(value.cursor, 'event cursor') !== cursor) {
      throw new Error('Unexpected WeChat event payload.');
    }
    // A reconnect replays from the prior checkpoint; already-covered cursors are
    // skipped and the checkpoint never moves backwards.
    if (cursorCovered(cursor, this.after)) {
      return;
    }
    const origin = this.identity;
    await this.handleEvent({ cursor, kind: value.kind, data: value.data });
    // A switch, re-login, or shutdown while the event was handled invalidates this
    // reader: its cursor belongs to the previous login, and any frame still queued
    // behind it may describe the previous account's conversation. Drop the connection
    // so the loop tail-bootstraps the new login instead of checkpointing stale state.
    this.requireIdentity(origin);
    if (this.after === undefined) {
      throw new AccountChangedError();
    }
    this.after = cursor;
    // Only a successfully handled event proves the receive path is healthy.
    this.failures = 0;
  }

  /** Applies one validated event. Unknown or unrelated kinds are checkpointed and ignored. */
  private async handleEvent(event: StreamEvent): Promise<void> {
    if (event.kind === 'message.committed') {
      await this.handleCommittedMessage(event);
    } else if (event.kind === 'account.updated') {
      this.adoptAccount(await this.readAccount());
    } else if (event.kind === 'send.updated') {
      this.handleSendUpdated(event.data);
    } else if (event.kind === 'job.updated') {
      this.handleJobUpdated(event.data);
    }
  }

  /**
   * Confirms a text waiter from `send.updated`. Media jobs also publish this kind with a
   * MediaJob payload, which carries `kind`/job fields and no text `destination`, so it can
   * never settle a text waiter even if an ID collides.
   */
  private handleSendUpdated(data: Record<string, unknown>): void {
    const id = data.id;
    if (!isString(id) || !id || data.kind !== undefined) {
      return;
    }
    const pending = this.pending.get(`send\u0000${id}`);
    if (pending === undefined || pending.family !== 'send' ||
      data.accountId !== pending.account || data.destination !== pending.threadId ||
      this.account !== pending.account || this.selfUsername !== pending.username ||
      !isString(data.state) || !SEND_STATES.has(data.state)) {
      return;
    }
    this.applyOutcome(pending, data.state, isString(data.errorCode) ? data.errorCode : undefined);
  }

  /** Confirms a media waiter from `job.updated`; other job kinds, threads, and IDs are ignored. */
  private handleJobUpdated(data: Record<string, unknown>): void {
    const id = data.id;
    if (!isString(id) || !id) {
      return;
    }
    const pending = this.pending.get(`job\u0000${id}`);
    if (pending === undefined || pending.family !== 'job' ||
      data.accountId !== pending.account || data.kind !== 'send' ||
      data.threadId !== pending.threadId ||
      this.account !== pending.account || this.selfUsername !== pending.username ||
      !isString(data.state) || !JOB_STATES.has(data.state)) {
      return;
    }
    this.applyOutcome(pending, data.state, isString(data.reason) ? data.reason : undefined);
  }

  /** Reads one committed message, filters it, and delivers it as its own live turn. */
  private async handleCommittedMessage(event: StreamEvent): Promise<void> {
    const messageId = event.data.messageId;
    const threadId = event.data.threadId;
    if (!isString(messageId) || !messageId ||
      !isString(threadId) || !threadId) {
      throw new Error('Unexpected WeChat message event.');
    }
    // Filter before any message read so ignored threads cost no requests.
    if (this.options.chatIds !== undefined && !this.options.chatIds.includes(threadId)) {
      return;
    }
    if (this.seenMessage(threadId, messageId)) {
      return;
    }
    const account = this.accountId;
    let value: unknown;
    try {
      value = await this.request(`${this.accountPath}/messages/${encodeURIComponent(messageId)}`);
    } catch (error) {
      if (error instanceof WechatRequestError && (error.status === 404 || error.status === 410)) {
        // The row was deleted before this event could be read. That is terminal for this
        // event only: remember its ID so the checkpoint advances and later events are not
        // stalled behind it until the daemon's retention window closes.
        this.rememberId(threadId, messageId);
        this.lastEventAt = new Date().toISOString();
        console.warn(`[wechat] skipping message ${messageId} in ${threadId}: ` +
          `the daemon no longer has the row (HTTP ${error.status}).`);
        return;
      }
      // Transient and authorization failures stay replayable from the same checkpoint.
      throw error;
    }
    if (this.handler === undefined) {
      return;
    }
    if (account !== this.account) {
      throw new AccountChangedError();
    }
    const message = parseMessage(value, account, threadId);
    if (message.id !== messageId) {
      throw new Error('Unexpected WeChat message event identity.');
    }
    const time = messageTime(message);
    // A live event never consults a per-thread watermark, so distinct IDs with equal or
    // out-of-order source times are not dropped. The startup cutoff still applies, and an
    // undated row cannot be ordered against it, so it is skipped.
    if (time !== undefined && time >= this.startedAt && this.eligible(message)) {
      await this.deliverMessage(threadId, message);
    }
    // Ineligible or pre-startup source messages are intentional skips, but remembering
    // their IDs prevents a replay from reading or delivering them again.
    this.rememberId(threadId, messageId);
    this.lastEventAt = new Date().toISOString();
  }

  /** Only text, image, and voice messages from a known direction are deliverable. */
  private eligible(message: NativeMessage): boolean {
    const supported = (message.type === 1 && (message.body ?? '') !== '') ||
      message.type === 3 || message.type === 34;
    if (!supported) {
      return false;
    }
    return message.direction === 'outgoing'
      ? this.selfUsername !== undefined
      : message.direction === 'incoming' && message.senderId !== null;
  }

  /** Reads a small error body under its own deadline, bounded by `maxBytes`. */
  private async streamError(
    response: Response,
    signal: AbortSignal
  ): Promise<{ code?: string; message?: string }> {
    const text = await readBoundedText(response, MAX_SSE_ERROR_BYTES, this.timeout, signal);
    if (text === undefined) {
      return {};
    }
    try {
      const value = JSON.parse(text) as unknown;
      if (!isRecord(value) || !isRecord(value.error)) {
        return {};
      }
      return {
        ...(isString(value.error.code) ? { code: value.error.code } : {}),
        ...(isString(value.error.message) ? { message: value.error.message } : {})
      };
    } catch {
      return {};
    }
  }

  /**
   * Marks transport activity. Backoff is not reset here: a stream that connects and
   * receives keepalives but keeps failing to handle an event must back off further.
   */
  private noteStreamActivity(): void {
    this.lastStreamActivityAt = new Date().toISOString();
  }

  private recordFailure(error: unknown): void {
    this.failures += 1;
    this.lastError = error instanceof Error ? error.message : 'Unknown WeChat stream error';
    this.lastErrorAt = new Date().toISOString();
    console.error('[wechat] event stream failed:', this.lastError);
  }

  /** Sleeps with capped exponential backoff; only stop() may interrupt the wait. */
  private async backoff(): Promise<void> {
    const exponent = Math.min(Math.max(0, this.failures - 1), WECHAT_MAX_BACKOFF_EXPONENT);
    const wait = Math.min(MAX_TIMER_MS, this.reconnect * 2 ** exponent);
    try {
      await delay(wait, undefined, { signal: this.streamAbort.signal });
    } catch (error) {
      if (this.streamAbort.signal.aborted) {
        return;
      }
      // An unexpected timer failure must end the loop rather than spin reconnecting.
      throw error;
    }
  }

  /** Delivers one live message as its own turn, preserving the source for metadata consumers. */
  private async deliverMessage(threadId: string, message: NativeMessage): Promise<boolean> {
    const self = message.direction === 'outgoing';
    const sender = self ? this.selfUsername : message.senderId;
    if (sender === undefined || sender === null) {
      return false;
    }
    const account = this.accountId;
    const username = this.selfUsername;
    // Display names are context only: a failed lookup must not drop the message, and a
    // name never replaces a sender ID. In a chatroom the account's own nickname is useful
    // context too, so self messages resolve under the same precedence.
    const senderName = self && !threadId.endsWith('@chatroom')
      ? undefined
      : await this.displayName(threadId, sender);
    if (this.handler === undefined) {
      return false;
    }
    const text = messageText(message);
    this.handler({
      text,
      senderId: sender,
      senderName,
      isSelf: self,
      timestamp: message.createdAt ?? undefined,
      channel: threadId,
      messages: [{
        id: `message:${message.id}`,
        text,
        senderId: sender,
        senderName,
        isSelf: self,
        timestamp: message.createdAt ?? undefined,
        images: message.type === 3 ? [{
          id: `image:${message.id}`,
          load: (signal?: AbortSignal) => this.loadImage(message.id, account, username, signal)
        }] : undefined,
        audio: message.type === 34 ? {
          id: `voice:${message.id}`,
          load: (signal?: AbortSignal) => this.loadAudio(message.id, account, username, signal)
        } : undefined
      }],
      metadata: {
        ...message,
        content: text,
        wechatAccount: account,
        wechatUsername: this.selfUsername,
        messageIds: [message.id],
        firstTimestamp: message.createdAt,
        lastTimestamp: message.createdAt,
        messages: [message]
      }
    });
    return true;
  }

  /** Remembers one recent message ID; the SSE cursor checkpoint is the primary dedupe. */
  private rememberId(threadId: string, messageId: string): void {
    const key = `${threadId}\u0000${messageId}`;
    if (this.seen.has(key)) {
      return;
    }
    this.seen.add(key);
    while (this.seen.size > WECHAT_RECENT_MESSAGE_LIMIT) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) {
        break;
      }
      this.seen.delete(oldest);
    }
  }

  /** Whether a recent live message was already delivered or intentionally skipped. */
  private seenMessage(threadId: string, messageId: string): boolean {
    return this.seen.has(`${threadId}\u0000${messageId}`);
  }

  /**
   * Cached sender name: the sender's own chatroom nickname, else the contact label.
   *
   * A native member label already resolves friend remark over WeChat nickname, so a
   * chatroom nickname is the only extra level. Absent, unconfirmed, blank, or failed
   * member reads fall through to the contact route; no name ever drops a message.
   */
  private async displayName(threadId: string, senderId: string): Promise<string | undefined> {
    const key = `${threadId}\u0000${senderId}`;
    const cached = this.names.get(key);
    if (cached !== undefined && cached.expires > Date.now()) {
      return cached.name;
    }
    let name = threadId.endsWith('@chatroom')
      ? await this.lookupName('group member name', () => this.groupMemberName(threadId, senderId), senderId)
      : undefined;
    // The chatroom nickname outranks every other name, so the contact is a fallback.
    name ??= await this.lookupName('contact name', () => this.contactName(senderId), senderId);
    if (this.names.size >= WECHAT_NAME_CACHE_SIZE && !this.names.has(key)) {
      const oldest = this.names.keys().next().value;
      if (oldest !== undefined) {
        this.names.delete(oldest);
      }
    }
    this.names.set(key, { ...(name === undefined ? {} : { name }),
      expires: Date.now() + (name === undefined ? WECHAT_NAME_MISS_TTL_MS : WECHAT_NAME_TTL_MS) });
    return name;
  }

  /** Runs one cached name read; a failure is logged and yields no name. */
  private async lookupName(
    label: string,
    read: () => Promise<string | undefined>,
    senderId: string
  ): Promise<string | undefined> {
    try {
      return await read();
    } catch (error) {
      console.warn(`[wechat] ${label} lookup failed for ${senderId}:`,
        error instanceof Error ? error.message : error);
      return undefined;
    }
  }

  /** Reads a chatroom member's own nickname and its upstream-resolved label. */
  private async groupMemberName(groupId: string, username: string): Promise<string | undefined> {
    let result: unknown;
    try {
      result = await this.request(`${this.accountPath}/groups/${encodeURIComponent(groupId)}` +
        `/members/${encodeURIComponent(username)}`);
    } catch (error) {
      if (error instanceof WechatRequestError && isTerminalMediaStatus(error.status)) {
        return undefined;
      }
      throw error;
    }
    if (!isRecord(result) || !isString(result.state) ||
      !(result.member === null || isRecord(result.member))) {
      throw new Error('Unexpected WeChat group member response.');
    }
    const member = result.member;
    if (result.state !== 'present' || !isRecord(member)) {
      return undefined;
    }
    // `roomDisplayName` is this chatroom's nickname for the member. `displayName` is the
    // label upstream already resolved from the friend remark, then the WeChat nickname.
    if (![member.roomDisplayName, member.displayName].every((value) =>
      value === undefined || value === null || isString(value))) {
      throw new Error('Unexpected WeChat group member fields.');
    }
    return trimmedName(member.roomDisplayName) ?? trimmedName(member.displayName);
  }

  /** Reads a contact's friend remark and label, falling back to the raw WeChat nickname. */
  private async contactName(username: string): Promise<string | undefined> {
    let result: unknown;
    try {
      result = await this.request(`${this.accountPath}/contacts/${encodeURIComponent(username)}`);
    } catch (error) {
      if (error instanceof WechatRequestError && isTerminalMediaStatus(error.status)) {
        return undefined;
      }
      throw error;
    }
    if (!isRecord(result) || ![result.remark, result.displayName, result.nickname].every((value) =>
      value === undefined || value === null || isString(value))) {
      throw new Error('Unexpected WeChat contact response.');
    }
    // The label is usually the friend remark, but upstream tests its fields for emptiness
    // without trimming, so a whitespace-only remark can mask a real nickname. Falling back
    // to the raw nickname keeps the WeChat-wide name available for those contacts.
    return trimmedName(result.remark) ?? trimmedName(result.displayName) ??
      trimmedName(result.nickname);
  }

  /** Account-scoped route built from a captured account ID, never a mutable current one. */
  private pathFor(account: string): string {
    return `/v1/accounts/${encodeURIComponent(account)}`;
  }

  /** Requests image bytes only when the server processes its conversation. */
  private async loadImage(
    messageId: string,
    account: string | undefined,
    username: string | undefined,
    signal?: AbortSignal
  ): Promise<ImageLoadResult> {
    this.requireAccount(account, username);
    const origin = { account: account as string, path: this.pathFor(account as string) };
    const selection = await this.selectMedia(origin, messageId, 'image', signal);
    if (selection.status !== 'ready') {
      return selection;
    }
    this.requireAccount(account, username);
    try {
      const content = await this.mediaContent(origin.path, selection.asset.id, MAX_IMAGE_BYTES, signal);
      this.requireAccount(account, username);
      try {
        return { status: 'ready', dataUrl: imageDataUrl(content.bytes.toString('base64')) };
      } catch (error) {
        throw new ImageUnavailableError(error instanceof Error ? error.message : 'Invalid WeChat image data.');
      }
    } catch (error) {
      if (error instanceof MediaUnavailableError) {
        throw error instanceof ImageUnavailableError ? error : new ImageUnavailableError(error.message);
      }
      if (error instanceof WechatRequestError && isTerminalMediaStatus(error.status)) {
        throw new ImageUnavailableError('WeChat image media is unavailable.');
      }
      throw error;
    }
  }

  /** Requests voice bytes lazily and converts the daemon's WAV copy for STT. */
  private async loadAudio(
    messageId: string,
    account: string | undefined,
    username: string | undefined,
    signal?: AbortSignal
  ): Promise<AudioLoadResult> {
    this.requireAccount(account, username);
    const origin = { account: account as string, path: this.pathFor(account as string) };
    try {
      const selection = await this.selectMedia(origin, messageId, 'voice', signal);
      if (selection.status !== 'ready') {
        return selection;
      }
      this.requireAccount(account, username);
      const content = await this.mediaContent(origin.path, selection.asset.id, MAX_AUDIO_BYTES, signal);
      this.requireAccount(account, username);
      const mimeType = (content.contentType ?? selection.asset.contentType ?? '').toLowerCase();
      const format = audioExtension(mimeType);
      return { status: 'ready', audio: audioFile(content.bytes.toString('base64'), format, messageId) };
    } catch (error) {
      if (error instanceof MediaUnavailableError) {
        return { status: 'unavailable', reason: error.message };
      }
      if (error instanceof WechatRequestError && isTerminalMediaStatus(error.status)) {
        return { status: 'unavailable', reason: error.message };
      }
      throw error;
    }
  }

  /** Lists attachment copies, fetching the best cached one or starting one download. */
  private async selectMedia(
    origin: { account: string; path: string },
    messageId: string,
    kind: 'image' | 'voice',
    signal?: AbortSignal
  ): Promise<{ status: 'ready'; asset: MediaAssetInfo } | { status: 'pending' } | { status: 'unavailable' }> {
    let assets: MediaAssetInfo[];
    try {
      const page = await this.request(`${origin.path}/messages/${encodeURIComponent(messageId)}/media`,
        undefined, signal);
      if (!isRecord(page) || !Array.isArray(page.items)) {
        throw new Error('Unexpected WeChat message media response.');
      }
      // Ownership is checked against the captured account and this exact message.
      assets = page.items.map((item) => parseMediaAsset(item, origin.account, messageId))
        .filter((asset): asset is MediaAssetInfo => asset !== undefined);
    } catch (error) {
      if (error instanceof WechatRequestError && isTerminalMediaStatus(error.status)) {
        return { status: 'unavailable' };
      }
      throw error;
    }
    // Voice exposes `normal` (decoded WAV) and `encoded` (raw SILK) copies. Only the decoded
    // copy can feed STT here, so a raw copy is never selected even when it is already cached.
    const matching = assets.filter((asset) => asset.kind === kind &&
      (kind !== 'voice' || (asset.actualVariant ?? asset.variant) !== 'encoded'));
    const available = matching.filter((asset) => asset.state === 'available')
      .sort((left, right) => variantRank(kind, left) - variantRank(kind, right));
    if (available.length > 0) {
      return { status: 'ready', asset: available[0] };
    }
    const pending = matching.filter((asset) => asset.state === 'pending' && asset.retryable)
      .sort((left, right) => variantRank(kind, left) - variantRank(kind, right));
    if (pending.length === 0) {
      return { status: 'unavailable' };
    }
    // MediaTransferRequest accepts only messageId, assetId, and quality; use the exact copy.
    try {
      await this.request(`${origin.path}/messages/${encodeURIComponent(messageId)}/media-transfers`,
        { messageId, assetId: pending[0].id }, signal);
    } catch (error) {
      if (error instanceof WechatRequestError && isTerminalMediaStatus(error.status)) {
        return { status: 'unavailable' };
      }
      throw error;
    }
    return { status: 'pending' };
  }

  /** Streams cached bytes from the account-scoped route, never an advertised URL. */
  private async mediaContent(accountPath: string, assetId: string, maxBytes: number, signal?: AbortSignal):
  Promise<{ bytes: Buffer; contentType?: string }> {
    return this.requestBytes(`${accountPath}/media/${encodeURIComponent(assetId)}/content`, signal, maxBytes);
  }

  private validateImage(image: { data: Uint8Array; filename: string; mimeType: string }):
  { data: Uint8Array; filename: string; mimeType: string } {
    const data = Buffer.from(image.data);
    if (data.byteLength === 0) {
      throw new Error('WeChat image attachments must not be empty.');
    }
    const dataUrl = imageDataUrl(data.toString('base64'));
    const mimeType = dataUrl.slice(5, dataUrl.indexOf(';'));
    if (mimeType !== image.mimeType) {
      throw new Error('WeChat image MIME type does not match its bytes.');
    }
    return { data, filename: image.filename.trim() || 'image.png', mimeType };
  }

  private validateVoice(audio: AudioFile | undefined): AudioFile {
    if (audio === undefined) {
      throw new Error('Voice reply requires synthesized audio.');
    }
    if (!audio.data.byteLength || audio.data.byteLength > MAX_AUDIO_BYTES) {
      throw new Error('Voice reply audio is empty or exceeds the audio size limit.');
    }
    audioExtension(audio.mimeType);
    return audio;
  }

  /** Stages one file and waits for the daemon to accept the media message. */
  private async sendMedia(
    message: IncomingMessage,
    account: string,
    accountPath: string,
    destination: string,
    kind: 'image' | 'voice',
    media: { data: Uint8Array; filename: string; mimeType: string },
    signal?: AbortSignal
  ): Promise<void> {
    await this.runSend(message, `${kind} job`, 'job', destination, async (operationSignal) => {
      const sourceId = await this.upload(accountPath, media, operationSignal);
      this.requireActiveAccount(message);
      operationSignal.throwIfAborted();
      const result = await this.request(`${accountPath}/sends`,
        { kind, threadId: destination, sourceId }, operationSignal, { 'Idempotency-Key': randomUUID() });
      const job = this.parseMediaJob(result, account, destination);
      return {
        id: job.id,
        state: job.state,
        ...(job.reason === undefined ? {} : { detail: job.reason }),
        read: async (readSignal) => {
          this.requireActiveAccount(message);
          const next = this.parseMediaJob(await this.request(
            `${accountPath}/jobs/${encodeURIComponent(job.id)}`, undefined, readSignal
          ), account, destination);
          this.requireActiveAccount(message);
          return { id: next.id, state: next.state, ...(next.reason === undefined ? {} : { detail: next.reason }) };
        },
        cancel: async () => {
          await this.request(`${accountPath}/jobs/${encodeURIComponent(job.id)}/cancel`, {},
            AbortSignal.timeout(WECHAT_SEND_CANCEL_TIMEOUT_MS));
        }
      };
    }, signal);
  }

  /** Sends text and waits for the daemon to accept it; uncertain sends are never repeated. */
  private async sendText(message: IncomingMessage, account: string, accountPath: string, destination: string,
    text: string, signal?: AbortSignal): Promise<void> {
    await this.runSend(message, 'send', 'send', destination, async (operationSignal) => {
      const result = await this.request(`${accountPath}/sends`,
        { threadId: destination, text }, operationSignal, { 'Idempotency-Key': randomUUID() });
      const intent = this.parseSendIntent(result, account, destination);
      return {
        id: intent.id,
        state: intent.state,
        ...(intent.errorCode === undefined ? {} : { detail: intent.errorCode }),
        read: async (readSignal) => {
          this.requireActiveAccount(message);
          const next = this.parseSendIntent(await this.request(
            `${accountPath}/sends/${encodeURIComponent(intent.id)}`, undefined, readSignal
          ), account, destination);
          this.requireActiveAccount(message);
          return { id: next.id, state: next.state, ...(next.errorCode === undefined ? {} : { detail: next.errorCode }) };
        },
        cancel: async () => {
          await this.request(`${accountPath}/sends/${encodeURIComponent(intent.id)}/cancel`, {},
            AbortSignal.timeout(WECHAT_SEND_CANCEL_TIMEOUT_MS));
        }
      };
    }, signal);
  }

  /** Uploads bytes with the multipart field name `file` and returns the source ID. */
  private async upload(
    accountPath: string,
    media: { data: Uint8Array; filename: string; mimeType: string },
    signal: AbortSignal
  ): Promise<string> {
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(media.data)], { type: media.mimeType }), media.filename);
    const result = await this.request(`${accountPath}/uploads`, form, signal);
    if (!isRecord(result) || !isString(result.id) || !result.id ||
      !isString(result.mediaType) || !isString(result.name)) {
      throw new Error('Unexpected WeChat upload response.');
    }
    return result.id;
  }

  /** Validates a response against the account that originated the send, not the current one. */
  private parseSendIntent(value: unknown, account: string, destination: string): {
    id: string; state: string; errorCode?: string;
  } {
    if (!isRecord(value) || !isString(value.id) || !value.id ||
      value.accountId !== account || value.destination !== destination ||
      !isString(value.state) || !SEND_STATES.has(value.state) ||
      !(value.errorCode === null || value.errorCode === undefined || isString(value.errorCode))) {
      throw new Error('Unexpected WeChat send response.');
    }
    return {
      id: value.id,
      state: value.state,
      ...(isString(value.errorCode) ? { errorCode: value.errorCode } : {})
    };
  }

  private parseMediaJob(value: unknown, account: string, destination: string): {
    id: string; state: string; reason?: string;
  } {
    if (!isRecord(value) || !isString(value.id) || !value.id ||
      value.accountId !== account || value.kind !== 'send' || value.threadId !== destination ||
      !isString(value.state) || !JOB_STATES.has(value.state) ||
      !(value.reason === null || value.reason === undefined || isString(value.reason))) {
      throw new Error('Unexpected WeChat media job response.');
    }
    return {
      id: value.id,
      state: value.state,
      ...(isString(value.reason) ? { reason: value.reason } : {})
    };
  }

  /**
   * Submits one outbound operation and waits for its terminal event-stream update. One
   * status read after registration reconciles an update that raced the POST response;
   * there is no interval polling. Failure or uncertainty cancels once and never resends.
   */
  private async runSend(
    message: IncomingMessage,
    label: string,
    family: SendFamily,
    threadId: string,
    submit: (signal: AbortSignal) => Promise<SendHandle>,
    signal?: AbortSignal
  ): Promise<void> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) {
      controller.abort();
    }
    this.operations.add(controller);
    const timer = setTimeout(cancel, WECHAT_SEND_TIMEOUT_MS);
    let handle: SendHandle | undefined;
    let pending: PendingSend | undefined;
    let terminal = false;
    try {
      controller.signal.throwIfAborted();
      handle = await submit(controller.signal);
      // A submission response may already be terminal; fence it like any stream update.
      this.requireActiveAccount(message);
      controller.signal.throwIfAborted();
      if (handle.state === 'accepted') {
        return;
      }
      if (TERMINAL_STATES.has(handle.state)) {
        terminal = true;
        throw this.sendFailure(label, handle.id, handle.state, handle.detail);
      }
      pending = this.registerPending(message, label, family, threadId, handle);
      const outcome = this.waitForOutcome(pending, controller.signal);
      // Reconcile the submission race once; the event stream remains the primary path.
      if (!controller.signal.aborted) {
        this.reconcileOne(pending);
      }
      const result = await outcome;
      // A switch or deadline during the wait must not turn a stale result into confirmation.
      this.requireActiveAccount(message);
      controller.signal.throwIfAborted();
      if (result.state === 'accepted') {
        return;
      }
      terminal = true;
      throw this.sendFailure(label, pending.id, result.state, result.detail);
    } catch (error) {
      if (handle !== undefined && !terminal) {
        try {
          await handle.cancel();
        } catch (cancelError) {
          console.warn(`[wechat] unable to cancel ${label} ${handle.id}:`,
            cancelError instanceof Error ? cancelError.message : cancelError);
        }
      }
      if (controller.signal.aborted) {
        throw new Error(`WeChat ${label} ${handle?.id ?? ''} cancelled or exceeded ` +
          `${WECHAT_SEND_TIMEOUT_MS} ms; delivery may be unconfirmed and will not be retried.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (pending !== undefined) {
        this.removePending(pending);
      }
      this.operations.delete(controller);
    }
  }

  /** One terminal delivery failure; uncertainty is never retried or resent. */
  private sendFailure(label: string, id: string, state: string, detail?: string): Error {
    return new Error(`WeChat ${label} ${id} ${state}` +
      `${detail === undefined ? '' : `: ${detail}`}. Delivery will not be retried.`);
  }

  /** Registers one nonterminal submission for SSE confirmation under its origin fence. */
  private registerPending(
    message: IncomingMessage,
    label: string,
    family: SendFamily,
    threadId: string,
    handle: SendHandle
  ): PendingSend {
    this.requireActiveAccount(message);
    const pending: PendingSend = {
      key: `${family}\u0000${handle.id}`,
      id: handle.id,
      family,
      label,
      account: this.accountId,
      username: this.selfUsername,
      threadId,
      state: handle.state,
      ...(handle.detail === undefined ? {} : { detail: handle.detail }),
      settled: false,
      read: handle.read,
      resolve: () => {},
      reject: () => {}
    };
    this.pending.set(pending.key, pending);
    return pending;
  }

  /** Resolves when the waiter's terminal outcome arrives or its deadline/caller aborts. */
  private waitForOutcome(pending: PendingSend, signal: AbortSignal): Promise<SendOutcome> {
    return new Promise<SendOutcome>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
      const onAbort = () => {
        reject(new Error(`WeChat ${pending.label} ${pending.id} cancelled.`));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      pending.cleanup = () => signal.removeEventListener('abort', onAbort);
    });
  }

  /**
   * Applies one status read or event. Accepted and terminal states latch, so a stale
   * status read that finishes after a newer SSE update can never override it.
   */
  private applyOutcome(pending: PendingSend, state: string, detail?: string): void {
    if (pending.settled) {
      return;
    }
    if (state === 'accepted' || TERMINAL_STATES.has(state)) {
      this.settlePending(pending, { state, ...(detail === undefined ? {} : { detail }) });
      return;
    }
    pending.state = state;
    if (detail !== undefined) {
      pending.detail = detail;
    }
  }

  private settlePending(pending: PendingSend, outcome: SendOutcome): void {
    if (pending.settled) {
      return;
    }
    pending.settled = true;
    this.pending.delete(pending.key);
    pending.reconcile?.abort();
    pending.cleanup?.();
    pending.cleanup = undefined;
    pending.resolve(outcome);
  }

  /** Rejects every outstanding waiter, e.g. on stop or an identity change. */
  private rejectPending(reason: string): void {
    for (const pending of [...this.pending.values()]) {
      if (pending.settled) {
        continue;
      }
      pending.settled = true;
      this.pending.delete(pending.key);
      pending.reconcile?.abort();
      pending.cleanup?.();
      pending.cleanup = undefined;
      pending.reject(new Error(`${reason} (${pending.label} ${pending.id})`));
    }
  }

  /** Releases one waiter after its send settles, aborting any status read still in flight. */
  private removePending(pending: PendingSend): void {
    if (this.pending.get(pending.key) === pending) {
      this.pending.delete(pending.key);
    }
    pending.reconcile?.abort();
    pending.cleanup?.();
    pending.cleanup = undefined;
  }

  /** Starts one status read per pending operation after a (re)connect. */
  private reconcilePending(): void {
    for (const pending of [...this.pending.values()]) {
      this.reconcileOne(pending);
    }
  }

  /**
   * Reads one pending operation's status once. The read never blocks the event stream,
   * never resends, and stops when the waiter settles or a terminal update latches. A
   * transient failure leaves the waiter to the stream and its existing deadline.
   *
   * A reconnect supersedes rather than queues behind a read still in flight from before
   * the disconnect: that read may predate a confirmation lost with the old connection,
   * and waiting for it could strand the send until its full deadline.
   */
  private reconcileOne(pending: PendingSend): void {
    if (pending.settled) {
      return;
    }
    pending.reconcile?.abort();
    const controller = new AbortController();
    pending.reconcile = controller;
    void (async () => {
      try {
        const next = await pending.read(controller.signal);
        if (pending.settled || pending.reconcile !== controller ||
          controller.signal.aborted || next.id !== pending.id) {
          return;
        }
        this.applyOutcome(pending, next.state, next.detail);
      } catch (error) {
        if (!pending.settled && pending.reconcile === controller &&
          !controller.signal.aborted) {
          console.warn(`[wechat] unable to reconcile ${pending.label} ${pending.id}:`,
            error instanceof Error ? error.message : error);
        }
      } finally {
        if (pending.reconcile === controller) {
          pending.reconcile = undefined;
        }
      }
    })();
  }

  private async request(endpoint: string, body?: unknown, signal?: AbortSignal,
    headers: Readonly<Record<string, string>> = {}): Promise<unknown> {
    return this.perform(endpoint, body, signal, headers, async (response) => await response.json() as unknown);
  }

  /** Reads bounded raw bytes for media content routes. */
  private async requestBytes(endpoint: string, signal: AbortSignal | undefined,
    maxBytes: number): Promise<{ bytes: Buffer; contentType?: string }> {
    return this.perform(endpoint, undefined, signal, {}, async (response, abort) => {
      const contentType = response.headers.get('content-type') ?? undefined;
      if (Number(response.headers.get('content-length')) > maxBytes) {
        abort();
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
            abort();
            throw new MediaUnavailableError('WeChat media response exceeds the size limit.');
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      return { bytes: Buffer.concat(chunks), ...(contentType === undefined ? {} : { contentType }) };
    });
  }

  /** Issues one authenticated request with caller, deadline, and shutdown cancellation. */
  private async perform<T>(
    endpoint: string,
    body: unknown,
    signal: AbortSignal | undefined,
    headers: Readonly<Record<string, string>>,
    consume: (response: Response, abort: () => void) => Promise<T>
  ): Promise<T> {
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
      return await consume(response, cancel);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      this.operations.delete(controller);
    }
  }
}
