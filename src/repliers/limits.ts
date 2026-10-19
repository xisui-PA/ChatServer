import { limitTextTokens } from '../models/tokens';

export const SOFT_REPLY_TOKEN_LIMIT = 150;
export const HARD_REPLY_TOKEN_LIMIT = 200;

/** Caps outgoing reply text using one application-level encoding across providers. */
export function limitReplyText(value: string): string {
  return limitTextTokens(value, HARD_REPLY_TOKEN_LIMIT);
}
