import { IncomingImage, IncomingMessage } from '../messagers/interface';
import { ImageUnavailableError } from '../messagers/images';
import { ResponseItem } from './responses-client';
import { boundedText, CONVERSATION_TEXT_TOKENS } from './input-budget';
import { countTokens } from './tokens';

export const MAX_IMAGES_PER_SNAPSHOT = 4;
const MAX_MEDIA_ATTEMPTS = 3;

/** Defers this snapshot before any model request or delivery. */
export class PendingImagesError extends Error {
  public constructor() {
    super('Image media is pending; waiting for a later turn.');
  }
}

const attempts = new WeakMap<IncomingImage, number>();
/** A turn's model filters and replier share one download of each selected image. */
const inputs = new WeakMap<IncomingMessage, Promise<string | readonly ResponseItem[]>>();

/** Bounds serialized JSON, preserving recent messages and valid structure. */
function boundedSnapshot(message: IncomingMessage): Record<string, unknown>[] {
  const sources = (message.messages ?? [message]).slice(-30);
  const messages = sources.map((source) => ({
    id: source.id ?? '', senderId: boundedText(source.senderId, 100),
    timestamp: source.timestamp, isSelf: source.isSelf === true,
    text: boundedText(source.text, 2_000),
    images: source.images?.slice(-MAX_IMAGES_PER_SNAPSHOT).map((image) => ({ id: image.id }))
  }));
  while (countTokens(JSON.stringify(messages)) > CONVERSATION_TEXT_TOKENS - 1_500) {
    if (messages.length > 1) {
      messages.shift();
    } else {
      messages[0].text = boundedText(messages[0].text, 500);
      break;
    }
  }
  return messages;
}

/** Resolves transient media at most three times; terminal failures never spin. */
async function loadImage(image: IncomingImage, signal?: AbortSignal): Promise<string | undefined> {
  const attempt = (attempts.get(image) ?? 0) + 1;
  if (attempt > MAX_MEDIA_ATTEMPTS) {
    return undefined;
  }
  attempts.set(image, attempt);
  try {
    const result = await image.load(signal);
    if (typeof result === 'string') {
      attempts.delete(image);
      return result;
    }
    if (result?.status === 'ready') {
      attempts.delete(image);
      return result.dataUrl;
    }
    if (result?.status !== 'pending') {
      attempts.set(image, MAX_MEDIA_ATTEMPTS);
      return undefined;
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ImageUnavailableError) {
      attempts.set(image, MAX_MEDIA_ATTEMPTS);
      return undefined;
    }
  }
  if (attempt < MAX_MEDIA_ATTEMPTS) {
    throw new PendingImagesError();
  }
  console.warn(`[image] ${image.id} unavailable after ${MAX_MEDIA_ATTEMPTS} attempts.`);
  return undefined;
}

/** Keeps image bytes out of JSON text while retaining source IDs and message order. */
async function buildInput(message: IncomingMessage, signal?: AbortSignal): Promise<string | readonly ResponseItem[]> {
  const messages = boundedSnapshot(message);
  const sources = message.messages ?? [message];
  const retained = new Set(messages.map((source) => source.id));
  const imageSources = sources.filter((source) => retained.has(source.id ?? ''));
  const images = imageSources.flatMap((source) => source.images ?? []);
  const selected = new Set(images.slice(-MAX_IMAGES_PER_SNAPSHOT));
  const parts: Record<string, unknown>[] = [];
  let pending = false;
  for (const source of imageSources) {
    const attachments: { id: string; status: string }[] = [];
    for (const image of source.images ?? []) {
      let status = 'omitted: snapshot image limit';
      if (selected.has(image)) {
        signal?.throwIfAborted();
        try {
          const dataUrl = await loadImage(image, signal);
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
          if (!(error instanceof PendingImagesError)) {
            throw error;
          }
          pending = true;
        }
      }
      attachments.push({ id: image.id, status });
    }
    const normalized = messages.find((item) => item.id === (source.id ?? ''));
    if (normalized !== undefined) {
      normalized.images = attachments.length > 0 ? attachments : undefined;
    }
  }
  if (pending) {
    throw new PendingImagesError();
  }
  const text = JSON.stringify({
    channel: boundedText(message.channel ?? message.senderId, 100),
    messages, memory: message.memory, currentTimestamp: new Date().toISOString()
  });
  if (countTokens(text) > CONVERSATION_TEXT_TOKENS) {
    throw new Error('Conversation metadata exceeds the text input budget.');
  }
  return parts.length === 0 ? text : [{ role: 'user', content: [{ type: 'input_text', text }, ...parts] }];
}

/** Uses native Responses API image parts, including during tool round trips. */
export function createConversationInput(message: IncomingMessage, signal?: AbortSignal): Promise<string | readonly ResponseItem[]> {
  let input = inputs.get(message);
  if (input === undefined) {
    input = buildInput(message, signal);
    inputs.set(message, input);
  }
  return input;
}
