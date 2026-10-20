import { MAX_MODEL_RETRIES, MODEL_RETRY_DELAY_MS } from '../limit';
import { setTimeout as delay } from 'node:timers/promises';
import { ResponsesApiError } from './responses-client';

/** One initial generation and at most three retries, with ten seconds between attempts. */
export async function withModelRetries<T>(generate: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let retries = 0; ; retries += 1) {
    signal?.throwIfAborted();
    try {
      return await generate();
    } catch (error) {
      const transient = error instanceof ResponsesApiError &&
        (error.status === undefined || error.status === 408 || error.status === 429 || error.status >= 500);
      if (signal?.aborted || retries >= MAX_MODEL_RETRIES || !transient) {
        throw error;
      }
      console.warn(`[model] generation failed; retry ${retries + 1}/${MAX_MODEL_RETRIES} in ${MODEL_RETRY_DELAY_MS / 1000} seconds.`);
      await delay(MODEL_RETRY_DELAY_MS, undefined, { signal });
    }
  }
}
