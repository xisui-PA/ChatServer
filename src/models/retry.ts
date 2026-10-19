import { setTimeout as delay } from 'node:timers/promises';
import { ResponsesApiError } from './responses-client';

/** One initial generation and at most three retries, with ten seconds between attempts. */
export async function withModelRetries<T>(generate: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const maxRetries = 3;
  for (let retries = 0; ; retries += 1) {
    signal?.throwIfAborted();
    try {
      return await generate();
    } catch (error) {
      const transient = error instanceof ResponsesApiError &&
        (error.status === undefined || error.status === 408 || error.status === 429 || error.status >= 500);
      if (signal?.aborted || retries >= maxRetries || !transient) {
        throw error;
      }
      console.warn(`[model] generation failed; retry ${retries + 1}/${maxRetries} in 10 seconds.`);
      await delay(10_000, undefined, { signal });
    }
  }
}
