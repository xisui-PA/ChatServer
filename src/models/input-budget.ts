import { IMAGE_TOKEN_RESERVE, MODEL_INPUT_TOKENS, TRUNCATION_MARKER_TOKENS } from '../limit';
import { ResponseItem } from './responses-client';
import { countTokens, limitTextTokens } from './tokens';

/** Truncates text without breaking Unicode and explicitly marks lost context. */
export function boundedText(text: string, tokens: number): string {
  return countTokens(text) <= tokens ? text : `${limitTextTokens(text, Math.max(1, tokens - TRUNCATION_MARKER_TOKENS))}\n[truncated]`;
}

/** Counts serialized text and reserves space for native image parts, excluding base64. */
export function modelInputTokens(input: string | readonly ResponseItem[], instructions: string, tools: unknown = []): number {
  let images = 0;
  const json = JSON.stringify({ input, instructions, tools }, (key, value: unknown) => {
    if (key === 'image_url') {
      images += 1;
      return '[image]';
    }
    return value;
  });
  return countTokens(json) + images * IMAGE_TOKEN_RESERVE;
}

/** Fails locally rather than submitting an oversized prompt to a provider. */
export function assertInputBudget(input: string | readonly ResponseItem[], instructions: string, tools?: unknown): void {
  if (modelInputTokens(input, instructions, tools) > MODEL_INPUT_TOKENS) {
    throw new Error(`Model input exceeds the application's ${MODEL_INPUT_TOKENS}-token budget.`);
  }
}
