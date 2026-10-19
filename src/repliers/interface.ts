import { FilterOutcome } from '../filters/interface';
import { IncomingMessage, OutgoingMessage } from '../messagers/interface';
import { MemoryUpdates } from '../conversations/interface';

/** Internal notes remain separate from the optional message sent to the chat app. */
export interface ReplierResult {
  reply?: OutgoingMessage;
  memoryUpdates: MemoryUpdates;
}

/** Generates a reply, or abstains when the filters leave the decision optional. */
export interface Replier {
  replyTo(
    message: IncomingMessage,
    outcome: FilterOutcome,
    signal?: AbortSignal
  ): Promise<ReplierResult>;
}
