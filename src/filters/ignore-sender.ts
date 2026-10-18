import { IncomingMessage } from '../messagers/interface';
import { SenderIdSource } from './ignore-file';
import { FilterAdapter, FilterResult } from './interface';

/**
 * Distinguishes a dynamic source from a fixed list of sender IDs.
 */
function isSenderIdSource(value: readonly string[] | SenderIdSource): value is SenderIdSource {
  return typeof (value as SenderIdSource).getSenderIds === 'function';
}

/**
 * Reference filter that never replies to the listed senders and abstains for everyone else.
 *
 * The list may be fixed or come from a {@link SenderIdSource} such as `IgnoreFile`, which
 * lets the list change while the server is running.
 */
export class IgnoreSenderFilter implements FilterAdapter {
  public readonly name = 'ignore-sender';

  private readonly source: SenderIdSource;

  public constructor(senderIds: readonly string[] | SenderIdSource) {
    this.source = isSenderIdSource(senderIds)
      ? senderIds
      : { getSenderIds: () => new Set(senderIds) };
  }

  public async shouldReply(message: IncomingMessage): Promise<FilterResult> {
    const senderIds = await this.source.getSenderIds();
    return senderIds.has(message.senderId) ? false : 'optional';
  }
}
