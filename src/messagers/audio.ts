import { AudioFile } from './interface';
import { MediaUnavailableError } from './media';

export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export const MAX_ENCODED_AUDIO_BYTES = 4 * Math.ceil(MAX_AUDIO_BYTES / 3);

const formats: Record<string, string> = {
  mp3: 'audio/mpeg', mpeg: 'audio/mpeg', mpga: 'audio/mpeg',
  wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  m4a: 'audio/mp4', mp4: 'audio/mp4', webm: 'audio/webm'
};

/** Decodes supported upstream audio without writing files or attempting local conversion. */
export function audioFile(data: string, format: string, id: number): AudioFile {
  const extension = format.toLowerCase();
  const mimeType = formats[extension];
  if (!Object.hasOwn(formats, extension)) {
    throw new MediaUnavailableError(`Unsupported voice format "${format}"; agent-wechat must convert SILK to MP3.`);
  }
  if (!data || data.length > MAX_ENCODED_AUDIO_BYTES || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new MediaUnavailableError('Voice data must be valid base64 no larger than 20 MiB.');
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_AUDIO_BYTES || bytes.toString('base64') !== data ||
    bytes.subarray(0, 16).toString('ascii').includes('#!SILK')) {
    throw new MediaUnavailableError('Voice data is invalid, oversized, or unconverted SILK.');
  }
  return { data: bytes, filename: `voice_${id}.${extension}`, mimeType };
}
