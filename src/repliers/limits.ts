import { HARD_REPLY_TOKEN_LIMIT } from '../limit';
import { countTokens, limitTextTokens } from '../models/tokens';

/** Root URLs with and without a trailing slash identify the same source. */
function citationUrlPattern(url: string): string {
  const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    const parsed = new URL(url);
    if (parsed.pathname === '/' && !parsed.search && !parsed.hash) {
      return `${escaped.replace(/\/$/, '')}/?`;
    }
  } catch { /* Preserve literal matching for non-URL callers. */ }
  return escaped;
}

/** Matches complete citation URLs without treating a longer URL as the same source. */
function citationPattern(url: string): RegExp {
  const escaped = citationUrlPattern(url);
  return new RegExp(`(^|[\\s(<\\["':])${escaped}(?=$|[\\s)>\\]"']|[.,;:!?](?=\\s|$))`, 'g');
}

/** Caps outgoing reply text using one application-level encoding across providers. */
export function limitReplyText(value: string, citationUrls: readonly string[] = []): string {
  const urls = [...new Set(citationUrls)];
  const sources = urls.join(' ');
  if (!sources) {
    return limitTextTokens(value, HARD_REPLY_TOKEN_LIMIT);
  }
  let text = value.trim();
  const missing = urls.filter((url) => !citationPattern(url).test(text));
  const complete = [text, ...missing].filter(Boolean).join(' ');
  if (countTokens(complete) <= HARD_REPLY_TOKEN_LIMIT) {
    return complete;
  }
  // Move existing citations to the suffix before truncating, preserving their labels.
  for (const url of urls) {
    const escaped = citationUrlPattern(url);
    text = text.replace(new RegExp(`\\[([^\\]]*)\\]\\(${escaped}(?:\\s+(?:"[^"]*"|'[^']*'))?\\)`, 'g'), '$1');
    text = text.replace(new RegExp(`<${escaped}>`, 'g'), '').replace(citationPattern(url), '$1');
  }
  text = text.replace(/[ \t]+/g, ' ').trim();
  // Reserve space for complete links; never truncate a required citation URL.
  const textBudget = HARD_REPLY_TOKEN_LIMIT - countTokens(sources) - 4;
  if (textBudget < 1) {
    throw new Error('Provider citations exceed the reply token budget.');
  }
  const result = [limitTextTokens(text, textBudget), sources].filter(Boolean).join(' ');
  if (countTokens(result) > HARD_REPLY_TOKEN_LIMIT) {
    throw new Error('Provider citations exceed the reply token budget.');
  }
  return result;
}
