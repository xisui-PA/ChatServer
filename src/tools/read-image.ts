import { ConversationImageAccess } from '../conversations/image-store';
import { MAX_MEMORY_ID_CHARS } from '../limit';
import { Tool, ToolDefinition, ToolImageResult, stringArgument, toolArguments } from './interface';
import { IncomingMessage } from '../messagers/interface';
import { readConversationImage } from '../models/conversation-input';

/** Resolves only image IDs in the server-bound conversation, never arbitrary URLs. */
export class ReadImageTool implements Tool {
  public readonly definition: ToolDefinition = {
    type: 'function', name: 'read_image',
    description: 'Inspect a cached image from this conversation by image ID. The image is provided on the next model round. Use when visual inspection is needed and the image is not already attached, including new images supplied only by ID and visual follow-up questions. Expired or unknown images cannot be retrieved.',
    parameters: {
      type: 'object', properties: { imageId: { type: 'string', description: 'Image ID from cachedImages, message images, or visual memory notes.' } },
      required: ['imageId'], additionalProperties: false
    },
    strict: true
  };

  public constructor(private readonly access?: ConversationImageAccess, private readonly message?: IncomingMessage) {}

  public async execute(args: unknown, signal?: AbortSignal): Promise<ToolImageResult> {
    const imageId = stringArgument(toolArguments(args, ['imageId']), 'imageId', MAX_MEMORY_ID_CHARS);
    signal?.throwIfAborted();
    if (!this.access) {
      throw new Error('Image lookup is unavailable for this request.');
    }
    const image = this.message
      ? await readConversationImage(this.message, imageId, signal)
      : await this.access.get(imageId);
    signal?.throwIfAborted();
    if (!image) {
      throw new Error('Image is unavailable or expired. Ask for it again if visual inspection is needed.');
    }
    return new ToolImageResult([image]);
  }
}
