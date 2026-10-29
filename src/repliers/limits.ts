import { HARD_REPLY_TOKEN_LIMIT } from '../limit';
import { countTokens, limitTextTokens } from '../models/tokens';

/** Caps outgoing reply text using one application-level encoding across providers. */
export function limitReplyText(value: string, citationUrls: readonly string[] = []): string {
  const sources = [...new Set(citationUrls)].join(' ');
  if (!sources) {
    return limitTextTokens(value, HARD_REPLY_TOKEN_LIMIT);
  }
  // Reserve space for complete links; never truncate a required citation URL.
  const textBudget = HARD_REPLY_TOKEN_LIMIT - countTokens(sources) - 4;
  if (textBudget < 1) {
    throw new Error('Provider citations exceed the reply token budget.');
  }
  const result = `${limitTextTokens(value, textBudget)} ${sources}`;
  if (countTokens(result) > HARD_REPLY_TOKEN_LIMIT) {
    throw new Error('Provider citations exceed the reply token budget.');
  }
  return result;
}
