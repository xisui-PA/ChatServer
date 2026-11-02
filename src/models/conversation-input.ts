import {
  CACHED_IMAGE_REFERENCE_TOKENS,
  CONVERSATION_ID_TOKENS,
  CONVERSATION_METADATA_TOKENS,
  CONVERSATION_TEXT_TOKENS,
  MAX_IMAGES_PER_SNAPSHOT,
  MAX_MEDIA_ATTEMPTS,
  MAX_MEMORY_TOKEN_LIMIT,
  MAX_MESSAGES_PER_SNAPSHOT,
  MESSAGER_CONTEXT_TOKENS,
  MESSAGE_TEXT_TOKENS,
  MIN_MESSAGE_TEXT_TOKENS,
  SENDER_NAME_TOKENS
} from '../limit';
import { ConversationMessage, IncomingImage, IncomingMessage } from '../messagers/interface';
import { ImageUnavailableError } from '../messagers/images';
import { ResponseItem } from './responses-client';
import { boundedText } from './input-budget';
import { countTokens } from './tokens';
import { PendingMediaError } from './pending-media';
import type { CachedImage } from '../conversations/image-store';

/** Defers this snapshot before any model request or delivery. */
export class PendingImagesError extends PendingMediaError {
  public constructor() {
    super('Image media is pending; waiting for a later turn.');
  }
}

const attempts = new WeakMap<IncomingImage, number>();
/** A turn's model filters and replier share one download of each selected image. */
const inputs = new WeakMap<IncomingMessage, Map<boolean, Promise<string | readonly ResponseItem[]>>>();
const imageLoads = new WeakMap<IncomingMessage, Map<IncomingImage, Promise<string | undefined>>>();

export interface ConversationInputOptions {
  /** False for models that retrieve all images through read_image instead. */
  attachImages?: boolean;
}

/** Different models can share a snapshot without downloading each image twice. */
function loadTurnImage(message: IncomingMessage, image: IncomingImage, signal?: AbortSignal): Promise<string | undefined> {
  let loads = imageLoads.get(message);
  if (!loads) {
    loads = new Map();
    imageLoads.set(message, loads);
  }
  let pending = loads.get(image);
  if (!pending) {
    pending = (async () => {
      try {
        const cached = await message.imageAccess?.get(image.id);
        signal?.throwIfAborted();
        if (cached) {
          return cached.dataUrl;
        }
      } catch (error) {
        signal?.throwIfAborted();
        console.warn(`[images] unable to read cached ${image.id}:`, error);
      }
      return loadImage(image, signal);
    })().catch((error: unknown) => {
      // A pending download may become ready when read_image requests it later in this turn.
      loads?.delete(image);
      throw error;
    });
    loads.set(image, pending);
  }
  return pending;
}

/** Retrieves cached images first and retries pending source media only when requested. */
export async function readConversationImage(message: IncomingMessage, imageId: string, signal?: AbortSignal): Promise<CachedImage | undefined> {
  if (!message.imageAccess) {
    return undefined;
  }
  const source = (message.messages ?? [message]).find((source) => source.images?.some((image) => image.id === imageId));
  const image = source?.images?.find((image) => image.id === imageId);
  if (!source || !image) {
    return message.imageAccess.get(imageId);
  }
  const dataUrl = await loadTurnImage(message, image, signal);
  if (!dataUrl) {
    return undefined;
  }
  await message.imageAccess.save(source, image, dataUrl);
  signal?.throwIfAborted();
  return message.imageAccess.get(imageId);
}

/** Display names are optional, bounded data; IDs remain available for attribution. */
function boundedSenderName(message: ConversationMessage): string | undefined {
  const name = message.senderName?.trim();
  return name ? boundedText(name, SENDER_NAME_TOKENS) : undefined;
}

/** Bounds serialized JSON, preserving recent messages and valid structure. */
function boundedSnapshot(message: IncomingMessage): Record<string, unknown>[] {
  const sources = (message.messages ?? [message]).slice(-MAX_MESSAGES_PER_SNAPSHOT);
  const messages = sources.map((source) => ({
    id: source.id ?? '', senderId: boundedText(source.senderId, CONVERSATION_ID_TOKENS),
    senderName: boundedSenderName(source),
    timestamp: source.timestamp, isSelf: source.isSelf === true,
    text: boundedText(source.text, MESSAGE_TEXT_TOKENS),
    images: source.images?.slice(-MAX_IMAGES_PER_SNAPSHOT).map((image) => ({ id: image.id }))
  }));
  while (countTokens(JSON.stringify(messages)) > CONVERSATION_TEXT_TOKENS - CONVERSATION_METADATA_TOKENS) {
    if (messages.length > 1) {
      messages.shift();
    } else {
      messages[0].text = boundedText(messages[0].text, MIN_MESSAGE_TEXT_TOKENS);
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
async function buildInput(message: IncomingMessage, attachImages: boolean, signal?: AbortSignal): Promise<string | readonly ResponseItem[]> {
  const messages = boundedSnapshot(message);
  const sources = message.messages ?? [message];
  const retained = new Set(messages.map((source) => source.id));
  const imageSources = sources.filter((source) => retained.has(source.id ?? ''));
  const images = imageSources.flatMap((source) => source.images ?? []);
  const selected = new Set(attachImages ? images.slice(-MAX_IMAGES_PER_SNAPSHOT) : []);
  const parts: Record<string, unknown>[] = [];
  let pending = false;
  for (const source of imageSources) {
    const attachments: { id: string; status: string }[] = [];
    for (const image of source.images ?? []) {
      let status = attachImages ? 'omitted: snapshot image limit' : 'unavailable';
      if (selected.has(image) || message.imageAccess) {
        signal?.throwIfAborted();
        try {
          const dataUrl = await loadTurnImage(message, image, signal);
          if (dataUrl !== undefined) {
            if (message.imageAccess) {
              try {
                await message.imageAccess.save(source, image, dataUrl);
                status = 'cached';
              } catch (error) {
                console.warn(`[images] unable to cache ${image.id}:`, error);
              }
            }
            if (selected.has(image)) {
              parts.push({ type: 'input_text', text: JSON.stringify({
                imageId: image.id, messageId: source.id, senderId: source.senderId,
                senderName: boundedSenderName(source), timestamp: source.timestamp
              }) });
              parts.push({ type: 'input_image', image_url: dataUrl, detail: 'auto' });
              status = 'attached';
            }
          } else {
            status = 'unavailable';
          }
        } catch (error) {
          if (!(error instanceof PendingImagesError)) {
            throw error;
          }
          status = 'pending';
          pending ||= selected.has(image);
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
  const currentImageIds = new Set(images.map((image) => image.id));
  let cachedImages: Record<string, unknown>[] = [];
  if (message.imageAccess) {
    try {
      cachedImages = (await message.imageAccess.list()).filter((image) => !currentImageIds.has(image.id)).map((image) => ({
        ...image, senderId: boundedText(image.senderId, CONVERSATION_ID_TOKENS),
        senderName: image.senderName ? boundedText(image.senderName, SENDER_NAME_TOKENS) : undefined
      }));
      while (cachedImages.length > 0 && countTokens(JSON.stringify(cachedImages)) > CACHED_IMAGE_REFERENCE_TOKENS) {
        cachedImages.shift();
      }
    } catch (error) {
      console.warn('[images] unable to list cached images:', error);
    }
  }
  const conversation = {
    channel: boundedText(message.channel ?? message.senderId, CONVERSATION_ID_TOKENS),
    messages, currentTimestamp: new Date().toISOString(),
    ...(cachedImages.length > 0 ? { cachedImages } : {})
  };
  while (cachedImages.length > 0 && countTokens(JSON.stringify(conversation)) > CONVERSATION_TEXT_TOKENS) {
    cachedImages.shift();
  }
  if (countTokens(JSON.stringify(conversation)) > CONVERSATION_TEXT_TOKENS) {
    throw new Error('Conversation metadata exceeds the text input budget.');
  }
  if (message.memory !== undefined && countTokens(JSON.stringify(message.memory)) > MAX_MEMORY_TOKEN_LIMIT) {
    throw new Error('Conversation memory exceeds the memory input budget.');
  }
  const context = message.additionalContext?.trim();
  const text = JSON.stringify({
    ...conversation, memory: message.memory,
    ...(context ? { additionalContext: boundedText(context, MESSAGER_CONTEXT_TOKENS) } : {})
  });
  return parts.length === 0 ? text : [{ role: 'user', content: [{ type: 'input_text', text }, ...parts] }];
}

/** Uses native Responses API image parts, including during tool round trips. */
export function createConversationInput(
  message: IncomingMessage, signal?: AbortSignal, options: ConversationInputOptions = {}
): Promise<string | readonly ResponseItem[]> {
  const attachImages = options.attachImages ?? true;
  let variants = inputs.get(message);
  if (!variants) {
    variants = new Map();
    inputs.set(message, variants);
  }
  let input = variants.get(attachImages);
  if (input === undefined) {
    input = buildInput(message, attachImages, signal);
    variants.set(attachImages, input);
  }
  return input;
}
