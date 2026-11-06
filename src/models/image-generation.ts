import { DEFAULT_DAILY_IMAGE_GEN_LIMIT, DEFAULT_IMAGE_HEIGHT_LIMIT, DEFAULT_IMAGE_WIDTH_LIMIT } from '../limit';
import { ImageFile } from '../messagers/interface';
import { imageDataUrl } from '../messagers/images';
import { ApiToolDefinition, ApiToolSpec } from '../tools/interface';
import { parseApiTools } from '../tools/api';
import type { ResponseItem } from './responses-client';

/** Validates a numeric width or height limit in pixels. */
export function parseImageDimension(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 16384) {
    throw new Error('Image dimension must be an integer between 1 and 16384.');
  }
  return value;
}

/** Validates a concrete dimension limit; provider-specific supported sizes are checked remotely. */
export function parseImageSize(value: unknown): { width: number; height: number } {
  if (typeof value !== 'string' || !/^[1-9]\d{0,4}x[1-9]\d{0,4}$/.test(value)) {
    throw new Error('Expected WIDTHxHEIGHT.');
  }
  const [width, height] = value.split('x').map(Number);
  if (width > 16384 || height > 16384) {
    throw new Error('Image dimensions exceed 16384.');
  }
  return { width, height };
}

/** Messenger-level settings; generation always uses the selected model's hosted tool. */
export interface ImageGenerationSettings {
  imageGeneration?: boolean;
  imageWidthLimit?: number;
  imageHeightLimit?: number;
  dailyImageGenLimit?: number;
}

/** Explicit enable/disable takes precedence over hosted-tool detection. */
export function supportsImageGeneration(settings: ImageGenerationSettings, apiTools: readonly ApiToolSpec[] = []): boolean {
  return settings.imageGeneration ?? parseApiTools(apiTools).some((tool) => tool.type === 'image_generation');
}

interface DailyUsage {
  day: string;
  used: number;
}

/** A reserved request permits at most one image call, including on ambiguous failures. */
export interface ImageGenerationReservation {
  finish(used: number): Promise<void>;
}

/** Applies size settings and reserves process-local daily quota before provider requests. */
export class ImageGenerationPolicy {
  public readonly enabled: boolean;
  public readonly size: string;
  private readonly dailyLimit: number;
  private usage?: DailyUsage;

  public constructor(settings: ImageGenerationSettings = {}, apiTools: readonly ApiToolSpec[] = []) {
    const width = parseImageDimension(settings.imageWidthLimit === undefined ? DEFAULT_IMAGE_WIDTH_LIMIT : settings.imageWidthLimit);
    const height = parseImageDimension(settings.imageHeightLimit === undefined ? DEFAULT_IMAGE_HEIGHT_LIMIT : settings.imageHeightLimit);
    this.size = `${width}x${height}`;
    this.dailyLimit = settings.dailyImageGenLimit ?? DEFAULT_DAILY_IMAGE_GEN_LIMIT;
    if (!Number.isSafeInteger(this.dailyLimit) || this.dailyLimit < 0) {
      throw new Error('dailyImageGenLimit must be a nonnegative safe integer.');
    }
    this.enabled = supportsImageGeneration(settings, apiTools) && this.dailyLimit > 0;
  }

  /** Normalizes a single hosted image tool and overrides unbounded size/format options. */
  public tools(apiTools: readonly ApiToolDefinition[]): ApiToolDefinition[] {
    const tools = apiTools.filter((tool) => tool.type !== 'image_generation');
    if (!this.enabled || this.dailyLimit === 0) {
      return tools;
    }
    const configured = apiTools.find((tool) => tool.type === 'image_generation');
    let size = this.size;
    if (configured?.size !== undefined && configured.size !== 'auto') {
      const requested = parseImageSize(configured.size);
      const limit = parseImageSize(this.size);
      if (requested.width <= limit.width && requested.height <= limit.height) {
        size = configured.size as string;
      }
    }
    return [...tools, { ...configured, type: 'image_generation', size, output_format: 'png' }];
  }

  /** Shared across conversations and retries. Unused slots are released only after a known response. */
  public async reserve(): Promise<ImageGenerationReservation | undefined> {
    if (!this.enabled || this.dailyLimit === 0) {
      return undefined;
    }
    const usage = this.currentUsage();
    if (usage.used >= this.dailyLimit) {
      return undefined;
    }
    // No await between checking and reserving: concurrent callers share this allowance.
    usage.used += 1;
    let finished = false;
    return { finish: async (used) => {
      if (finished || !Number.isSafeInteger(used) || used < 0) {
        throw new Error('Invalid image generation quota settlement.');
      }
      finished = true;
      // A request crossing midnight settles against its original day only.
      const current = this.currentUsage();
      if (current === usage) {
        current.used += used - 1;
      }
    } };
  }

  private currentUsage(): DailyUsage {
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (this.usage?.day !== day) {
      this.usage = { day, used: 0 };
    }
    return this.usage;
  }
}

/** Decodes completed PNG results, checking actual dimensions rather than trusting provider metadata. */
export function generatedImages(output: readonly ResponseItem[], size = `${DEFAULT_IMAGE_WIDTH_LIMIT}x${DEFAULT_IMAGE_HEIGHT_LIMIT}`): ImageFile[] {
  const limit = parseImageSize(size);
  return output.filter((item) => item.type === 'image_generation_call').map((item) => {
    if (item.status !== 'completed' || typeof item.result !== 'string') {
      throw new Error('Provider returned an incomplete image generation result.');
    }
    const url = imageDataUrl(item.result);
    const data = Buffer.from(item.result, 'base64');
    if (!url.startsWith('data:image/png;') || data.length < 24 || data.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error('Provider must return a PNG image with dimensions.');
    }
    const width = data.readUInt32BE(16);
    const height = data.readUInt32BE(20);
    if (width === 0 || height === 0 || width > limit.width || height > limit.height) {
      throw new Error(`Generated image exceeds imageWidthLimit ${limit.width} or imageHeightLimit ${limit.height}, or has invalid dimensions.`);
    }
    return { data, filename: 'generated.png', mimeType: 'image/png' };
  });
}
