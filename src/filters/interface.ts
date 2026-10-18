import { IncomingMessage } from '../messagers/interface';

/**
 * Decision from an individual filter or a chain of filters.
 * Optional delegates to the next filter, or to the reply model if all abstain.
 */
export enum FilterOutcome {
  Allowed = 'allowed',
  Denied = 'denied',
  Optional = 'optional'
}

/**
 * Decides whether an inbound message should be replied to.
 *
 * Filters are evaluated in order and the first decisive result wins.
 */
export interface FilterAdapter {
  /** Human-readable adapter name, used in logs. */
  readonly name: string;
  /** Decides whether `message` should be replied to. */
  shouldReply(message: IncomingMessage): FilterOutcome | Promise<FilterOutcome>;
}

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
 * A filter that throws is treated as `FilterOutcome.Denied` (fail closed) so a broken filter
 * cannot accidentally allow messages through.
 */
export async function evaluateFilters(
  filters: readonly FilterAdapter[],
  message: IncomingMessage
): Promise<FilterEvaluation> {
  for (const filter of filters) {
    let result: FilterOutcome;

    try {
      result = await filter.shouldReply(message);
    } catch (error) {
      console.error(
        `[chat] filter "${filter.name}" failed: ${(error as Error).message}; dropping message`
      );
      return { outcome: FilterOutcome.Denied, decidedBy: filter.name };
    }

    if (result !== FilterOutcome.Optional) {
      return { outcome: result, decidedBy: filter.name };
    }

    // Optional: abstain and let the next filter decide.
  }

  return { outcome: FilterOutcome.Optional };
}
