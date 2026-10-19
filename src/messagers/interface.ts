import { ConversationMemory } from '../conversations/interface';

/** One source message in a conversation, with its original author and time. */
export interface ConversationMessage {
  /** Stable ID used by memory notes to cite this source message. */
  id?: string;
  /** Message text. */
  text: string;
  /** Adapter-specific identifier for the sender (connection, user, etc.). */
  senderId: string;
  /** Original timestamp, when supplied by the adapter. */
  timestamp?: string;
}

/** A message or conversation snapshot normalized for the processing pipeline. */
export interface IncomingMessage extends ConversationMessage {
  /** Individual source messages, in order, for bundles and conversation snapshots. */
  messages?: readonly ConversationMessage[];
  /** Pruned, persistent conversation notes and confirmed sent replies. */
  memory?: ConversationMemory;
  /** Optional channel or room the message belongs to. */
  channel?: string;
  /** Adapter-specific metadata, e.g. the remote IP address. */
  metadata?: Readonly<Record<string, unknown>>;
}

/**
 * A message the server asks the messager adapter to deliver.
 */
export interface OutgoingMessage {
  /** Message text to deliver. */
  text: string;
  /** Optional channel or room to target. */
  channel?: string;
  /**
   * When true, deliver only to the sender of the originating message.
   * Defaults to false, which lets adapters broadcast the reply.
   */
  direct?: boolean;
}

/**
 * Callback the server registers with a {@link MessagerAdapter}.
 */
export type MessageHandler = (message: IncomingMessage) => void;

/**
 * Transport abstraction: receives messages from some source and sends replies back.
 *
 * Implementations are responsible for their own transport (WebSocket, stdin/stdout,
 * HTTP polling, a message queue, ...). The server only depends on this interface.
 */
export interface MessagerAdapter {
  /** Human-readable adapter name, used in logs. */
  readonly name: string;
  /**
   * Starts listening and invokes `handler` for every inbound message.
   * Called once by the server after construction.
   */
  start(handler: MessageHandler): void | Promise<void>;
  /**
   * Delivers a reply that corresponds to an inbound message.
   * Implementations decide how to route it (e.g. broadcast or direct reply).
   */
  reply(
    message: IncomingMessage,
    reply: OutgoingMessage,
    signal?: AbortSignal
  ): void | Promise<void>;
  /** Releases transport resources. Called when the server closes. */
  stop?(): void | Promise<void>;
}
