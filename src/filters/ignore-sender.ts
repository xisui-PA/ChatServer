import { ConversationMessage, IncomingMessage } from '../messagers/interface';
import { SenderIdSource } from './ignore-file';
import { FilterAdapter, FilterOutcome } from './interface';

/**
 * Distinguishes a dynamic source from a fixed list of sender IDs.
 */
function isSenderIdSource(value: readonly string[] | SenderIdSource): value is SenderIdSource {
  return typeof (value as SenderIdSource).getSenderIds === 'function';
}

/**
 * Removes listed senders from snapshots and denies only when no incoming sources remain.
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

  public async shouldReply(message: IncomingMessage): Promise<FilterOutcome> {
    const messages = await this.selectMessages(message.messages ?? [message]);
    return messages.some((item) => !item.isSelf) ? FilterOutcome.Optional : FilterOutcome.Denied;
  }

  public async selectMessages(messages: readonly ConversationMessage[]): Promise<readonly ConversationMessage[]> {
    const senderIds = await this.source.getSenderIds();
    return messages.filter((item) => !senderIds.has(item.senderId));
  }
}
