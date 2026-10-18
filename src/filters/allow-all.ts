import { FilterAdapter, FilterOutcome } from './interface';

/**
 * Reference filter that allows every message.
 */
export class AllowAllFilter implements FilterAdapter {
  public readonly name = 'allow-all';

  public shouldReply(): FilterOutcome {
    return FilterOutcome.Allowed;
  }
}
