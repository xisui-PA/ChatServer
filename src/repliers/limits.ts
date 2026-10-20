import { HARD_REPLY_TOKEN_LIMIT } from '../limit';
import { limitTextTokens } from '../models/tokens';

/** Caps outgoing reply text using one application-level encoding across providers. */
export function limitReplyText(value: string): string {
  return limitTextTokens(value, HARD_REPLY_TOKEN_LIMIT);
}
