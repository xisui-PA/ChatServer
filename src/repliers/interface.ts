import { FilterOutcome } from '../filters/interface';
import { IncomingMessage, OutgoingMessage } from '../messagers/interface';

/** Generates a reply, or abstains when the filters leave the decision optional. */
export interface Replier {
  replyTo(
    message: IncomingMessage,
    outcome: FilterOutcome,
    signal?: AbortSignal
  ): Promise<OutgoingMessage | undefined>;
}
