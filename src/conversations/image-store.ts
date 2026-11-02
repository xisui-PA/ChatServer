import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  CONVERSATION_ID_TOKENS, MAX_CACHED_IMAGES_PER_CONVERSATION, MAX_IMAGE_CACHE_FILE_BYTES, MAX_MEMORY_ID_CHARS,
  MEMORY_CLEANUP_INTERVAL_MS, MEMORY_RETENTION_MS, SENDER_NAME_TOKENS
} from '../limit';
import { ConversationMessage, IncomingImage } from '../messagers/interface';
import { imageDataUrl } from '../messagers/images';
import { boundedText } from '../models/input-budget';

/** Small source labels can be included in prompts without including image bytes. */
export interface CachedImageReference {
  id: string;
  messageId: string;
  senderId: string;
  senderName?: string;
  timestamp: string;
  expiresAt: string;
}

export interface CachedImage extends CachedImageReference {
  dataUrl: string;
}

/** A capability bound by the server to one account and conversation. */
export interface ConversationImageAccess {
  list(): Promise<readonly CachedImageReference[]>;
  get(id: string): Promise<CachedImage | undefined>;
  save(source: ConversationMessage, image: IncomingImage, dataUrl: string): Promise<void>;
}

interface ImageFile {
  version: 1;
  images: Record<string, CachedImage>;
}

/** Rejects URLs and malformed data instead of fetching arbitrary locations. */
function validateDataUrl(value: string): string {
  const match = /^data:image\/(?:png|jpeg|gif|webp);base64,(.+)$/.exec(value);
  if (!match || imageDataUrl(match[1]) !== value) {
    throw new Error('Invalid cached image data URL.');
  }
  return value;
}

/** Stores image bytes separately from token-bounded conversation notes. */
export class ConversationImageStore {
  private readonly directory: string;
  private operations: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;

  public constructor(configDir: string) {
    this.directory = path.join(configDir, 'conversations');
  }

  public async start(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.cleanup();
    this.timer = setInterval(() => {
      void this.cleanup().catch((error: unknown) => console.error('[images] cleanup failed:', error));
    }, MEMORY_CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  public async close(): Promise<void> {
    clearInterval(this.timer);
    await this.operations;
  }

  public forConversation(key: string): ConversationImageAccess {
    const filePath = path.join(this.directory, `${createHash('sha256').update(key).digest('hex')}.images.json`);
    return {
      list: () => this.run(async () => {
        const images = await this.read(filePath);
        return Object.values(images).map((image) => ({
          id: image.id, messageId: image.messageId, senderId: image.senderId,
          senderName: image.senderName, timestamp: image.timestamp, expiresAt: image.expiresAt
        }));
      }),
      get: (id) => this.run(async () => {
        const image = (await this.read(filePath))[id];
        return image ? { ...image, dataUrl: validateDataUrl(image.dataUrl) } : undefined;
      }),
      save: (source, image, dataUrl) => this.run(async () => {
        if (!source.id || source.id.length > MAX_MEMORY_ID_CHARS || !image.id || image.id.length > MAX_MEMORY_ID_CHARS) {
          throw new Error('Cached images need valid image and source message IDs.');
        }
        const now = Date.now();
        const timestamp = Math.min(now, Date.parse(source.timestamp ?? new Date(now).toISOString()));
        if (!Number.isFinite(timestamp) || timestamp + MEMORY_RETENTION_MS <= now) {
          return;
        }
        const images = await this.read(filePath);
        // Repeated processing must never refresh the original image's expiry.
        if (Object.hasOwn(images, image.id)) {
          return;
        }
        images[image.id] = {
          id: image.id, messageId: source.id, senderId: boundedText(source.senderId, CONVERSATION_ID_TOKENS),
          senderName: source.senderName ? boundedText(source.senderName, SENDER_NAME_TOKENS) : undefined,
          timestamp: new Date(timestamp).toISOString(),
          expiresAt: new Date(timestamp + MEMORY_RETENTION_MS).toISOString(), dataUrl: validateDataUrl(dataUrl)
        };
        await this.write(filePath, images);
      })
    };
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation);
    this.operations = task.then(() => {}, () => {});
    return task;
  }

  /** Derives expiry from source time, including on every lookup after startup. */
  private async read(filePath: string): Promise<Record<string, CachedImage>> {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_IMAGE_CACHE_FILE_BYTES) {
        throw new Error('Image cache file exceeds the size limit.');
      }
      const value = JSON.parse(await fs.readFile(filePath, 'utf8')) as ImageFile;
      if (value?.version !== 1 || !value.images || typeof value.images !== 'object' || Array.isArray(value.images)) {
        throw new Error('Expected a version 1 image cache file.');
      }
      const images: Record<string, CachedImage> = Object.create(null);
      const now = Date.now();
      for (const [id, image] of Object.entries(value.images)) {
        if (!image || image.id !== id || !id || id.length > MAX_MEMORY_ID_CHARS ||
          typeof image.messageId !== 'string' || !image.messageId || image.messageId.length > MAX_MEMORY_ID_CHARS ||
          typeof image.senderId !== 'string' || typeof image.timestamp !== 'string' ||
          !Number.isFinite(Date.parse(image.timestamp)) || typeof image.dataUrl !== 'string' ||
          (image.senderName !== undefined && typeof image.senderName !== 'string')) {
          throw new Error('Invalid cached image entry.');
        }
        const timestamp = Date.parse(image.timestamp);
        if (timestamp <= now && timestamp + MEMORY_RETENTION_MS > now) {
          images[id] = {
            id, messageId: image.messageId, senderId: boundedText(image.senderId, CONVERSATION_ID_TOKENS),
            senderName: image.senderName ? boundedText(image.senderName, SENDER_NAME_TOKENS) : undefined,
            timestamp: image.timestamp, expiresAt: new Date(timestamp + MEMORY_RETENTION_MS).toISOString(), dataUrl: image.dataUrl
          };
        }
      }
      return images;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return Object.create(null) as Record<string, CachedImage>;
      }
      throw error;
    }
  }

  /** Bounds disk usage and atomically replaces the map with owner-only permissions. */
  private async write(filePath: string, images: Record<string, CachedImage>): Promise<void> {
    const entries = Object.values(images).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    while (entries.length > MAX_CACHED_IMAGES_PER_CONVERSATION) {
      entries.shift();
    }
    const payload: ImageFile = { version: 1, images: Object.fromEntries(entries.map((image) => [image.id, image])) };
    let encoded = JSON.stringify(payload);
    while (Buffer.byteLength(encoded) > MAX_IMAGE_CACHE_FILE_BYTES && entries.length > 0) {
      const oldest = entries.shift();
      if (oldest) {
        delete payload.images[oldest.id];
      }
      encoded = JSON.stringify(payload);
    }
    if (entries.length === 0) {
      await fs.rm(filePath, { force: true });
      return;
    }
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, filePath);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  private cleanup(): Promise<void> {
    return this.run(async () => {
      for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
        if (entry.isFile() && /^[a-f0-9]{64}\.images\.json$/.test(entry.name)) {
          const filePath = path.join(this.directory, entry.name);
          try {
            await this.write(filePath, await this.read(filePath));
          } catch (error) {
            console.warn(`[images] unable to prune ${filePath}:`, error);
          }
        }
      }
    });
  }
}
