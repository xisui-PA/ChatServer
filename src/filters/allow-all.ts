import { FilterAdapter, FilterResult } from './interface';

/**
 * Reference filter that allows every message.
 */
export class AllowAllFilter implements FilterAdapter {
  public readonly name = 'allow-all';

  public shouldReply(): FilterResult {
    return true;
  }
}
