import { IncomingMessage } from '../messagers/interface';
import { ResponseItem } from './responses-client';

export const MAX_IMAGES_PER_SNAPSHOT = 4;

/** A turn's model filters and replier share one download of each selected image. */
const inputs = new WeakMap<IncomingMessage, Promise<string | readonly ResponseItem[]>>();

/** Keeps image bytes out of JSON text while retaining source IDs and message order. */
async function buildInput(message: IncomingMessage, signal?: AbortSignal): Promise<string | readonly ResponseItem[]> {
  const sources = message.messages ?? [message];
  const images = sources.flatMap((source) => source.images ?? []);
  const selected = new Set(images.slice(-MAX_IMAGES_PER_SNAPSHOT));
  const parts: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  for (const source of sources) {
    const attachments: { id: string; status: string }[] = [];
    for (const image of source.images ?? []) {
      let status = 'omitted: snapshot image limit';
      if (selected.has(image)) {
        signal?.throwIfAborted();
        try {
          const dataUrl = await image.load(signal);
          if (dataUrl !== undefined) {
            parts.push({ type: 'input_text', text: JSON.stringify({
              imageId: image.id, messageId: source.id, senderId: source.senderId, timestamp: source.timestamp
            }) });
            parts.push({ type: 'input_image', image_url: dataUrl, detail: 'auto' });
            status = 'attached';
          } else {
            status = 'unavailable';
          }
        } catch (error) {
          signal?.throwIfAborted();
          console.warn(`[image] unable to load ${image.id}:`, error instanceof Error ? error.message : error);
          status = 'unavailable';
        }
      }
      attachments.push({ id: image.id, status });
    }
    messages.push({
      id: source.id,
      senderId: source.senderId,
      timestamp: source.timestamp,
      text: source.text,
      images: attachments.length > 0 ? attachments : undefined
    });
  }
  const text = JSON.stringify({
    senderId: message.senderId,
    channel: message.channel,
    text: message.messages === undefined ? message.text : undefined,
    messages: message.messages !== undefined || images.length > 0 ? messages : undefined,
    memory: message.memory,
    currentTimestamp: new Date().toISOString()
  });
  if (parts.length === 0) {
    return text;
  }
  return [{ role: 'user', content: [{ type: 'input_text', text }, ...parts] }];
}

/** Uses native Responses API image parts, including during tool round trips. */
export function createConversationInput(
  message: IncomingMessage,
  signal?: AbortSignal
): Promise<string | readonly ResponseItem[]> {
  let input = inputs.get(message);
  if (input === undefined) {
    input = buildInput(message, signal);
    inputs.set(message, input);
  }
  return input;
}
