import { IncomingMessage } from '../messagers/interface';

/**
 * Decision returned by a {@link FilterAdapter}:
 *
 * - `true` — the message should be replied to.
 * - `false` — the message should not be replied to.
 * - `'optional'` — no opinion; let the next filter decide. If no filter decides,
 *   the server applies its configured fallback (reply by default).
 *
 * Adapters may return the value directly or asynchronously (e.g. after an API call).
 */
export type FilterResult = boolean | 'optional';

/**
 * Decides whether an inbound message should be replied to.
 *
 * Filters are evaluated in order and the first decisive result wins.
 */
export interface FilterAdapter {
  /** Human-readable adapter name, used in logs. */
  readonly name: string;
  /** Decides whether `message` should be replied to. */
  shouldReply(message: IncomingMessage): FilterResult | Promise<FilterResult>;
}

/**
 * Aggregate outcome of running a filter chain.
 */
export type FilterOutcome = 'allowed' | 'denied' | 'optional';

/**
 * Result of evaluating a chain of filters.
 */
export interface FilterEvaluation {
  outcome: FilterOutcome;
  /** Name of the filter that produced the decision, when there was one. */
  decidedBy?: string;
}

/**
 * Runs filters in order and returns the first decisive outcome.
 *
 * A filter that throws is treated as `false` (fail closed) so a broken filter
 * cannot accidentally allow messages through.
 */
export async function evaluateFilters(
  filters: readonly FilterAdapter[],
  message: IncomingMessage
): Promise<FilterEvaluation> {
  for (const filter of filters) {
    let result: FilterResult;

    try {
      result = await filter.shouldReply(message);
    } catch (error) {
      console.error(
        `[chat] filter "${filter.name}" failed: ${(error as Error).message}; dropping message`
      );
      return { outcome: 'denied', decidedBy: filter.name };
    }

    if (result === true) {
      return { outcome: 'allowed', decidedBy: filter.name };
    }

    if (result === false) {
      return { outcome: 'denied', decidedBy: filter.name };
    }

    // result === 'optional': abstain and let the next filter decide.
  }

  return { outcome: 'optional' };
}
