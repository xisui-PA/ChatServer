import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';

let tokenizer: Tiktoken | undefined;

/** Uses one application-level encoding across providers and internal memory. */
function getTokenizer(): Tiktoken {
  tokenizer ??= new Tiktoken(o200kBase);
  return tokenizer;
}

/** Special-token-looking strings remain ordinary text, not control tokens. */
export function countTokens(text: string): number {
  return getTokenizer().encode(text, [], []).length;
}

/** Truncates at an intact Unicode prefix and verifies its token count. */
export function limitTextTokens(value: string, limit: number): string {
  const text = value.trim();
  const encoding = getTokenizer();
  const tokens = encoding.encode(text, [], []);
  if (tokens.length <= limit) {
    return text;
  }
  for (let count = limit; count > 0; count -= 1) {
    const prefix = encoding.decode(tokens.slice(0, count)).trimEnd();
    if (prefix && text.startsWith(prefix) && countTokens(prefix) <= limit) {
      return prefix;
    }
  }
  throw new Error('Unable to fit text within the token limit.');
}
