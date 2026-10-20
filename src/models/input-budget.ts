import { ResponseItem } from './responses-client';
import { countTokens, limitTextTokens } from './tokens';

/** Application budgets; image estimates are independent of provider billing. */
export const CONVERSATION_TEXT_TOKENS = 8_000;
export const MODEL_INPUT_TOKENS = 64_000;
export const TOOL_RESULT_TOKENS = 8_000;
const IMAGE_TOKEN_RESERVE = 2_048;

/** Truncates text without breaking Unicode and explicitly marks lost context. */
export function boundedText(text: string, tokens: number): string {
  return countTokens(text) <= tokens ? text : `${limitTextTokens(text, Math.max(1, tokens - 8))}\n[truncated]`;
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
