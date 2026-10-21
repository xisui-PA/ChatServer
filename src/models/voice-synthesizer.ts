import { randomInt } from 'node:crypto';
import { MAX_AUDIO_BYTES, MAX_VOICE_PADDING_MS, MIN_VOICE_PADDING_MS } from '../limit';
import { AudioFile } from '../messagers/interface';
import { SpeechModel } from './speech-client';

/** Adds actual silence to PCM/float WAV samples, independently at either end. */
export function padVoiceAudio(audio: AudioFile): AudioFile {
  const wav = Buffer.from(audio.data);
  const invalid = () => new Error('TTS must return a valid, uncompressed PCM or float WAV file for voice padding.');
  if (wav.length < 44 || wav.length > MAX_AUDIO_BYTES || wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw invalid();
  }
  let format: Buffer | undefined;
  let samples: Buffer | undefined;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const id = wav.toString('ascii', offset, offset + 4);
    const declared = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    // Streaming WAV encoders can leave RIFF/data sizes as large placeholders.
    const size = id === 'data' && declared >= 0x7fff0000 ? wav.length - start : declared;
    if (start + size > wav.length) {
      throw invalid();
    }
    if (id === 'fmt ') {
      if (format !== undefined) {
        throw invalid();
      }
      format = wav.subarray(start, start + size);
    } else if (id === 'data') {
      if (samples !== undefined) {
        throw invalid();
      }
      samples = wav.subarray(start, start + size);
    }
    offset = start + size + size % 2;
  }
  if (format === undefined || format.length < 16 || samples === undefined || !samples.length) {
    throw invalid();
  }
  let encoding = format.readUInt16LE(0);
  if (encoding === 0xfffe && format.length >= 40 &&
    format.subarray(28, 40).equals(Buffer.from('00001000800000aa00389b71', 'hex'))) {
    encoding = format.readUInt32LE(24);
  }
  const channels = format.readUInt16LE(2);
  const sampleRate = format.readUInt32LE(4);
  const frameBytes = format.readUInt16LE(12);
  const bits = format.readUInt16LE(14);
  if (!channels || !sampleRate || !frameBytes || frameBytes !== channels * bits / 8 || samples.length % frameBytes !== 0 ||
    !(encoding === 1 && [8, 16, 24, 32].includes(bits) || encoding === 3 && [32, 64].includes(bits))) {
    throw invalid();
  }
  const leadingMs = randomInt(MIN_VOICE_PADDING_MS, MAX_VOICE_PADDING_MS + 1);
  const trailingMs = randomInt(MIN_VOICE_PADDING_MS, MAX_VOICE_PADDING_MS + 1);
  const leadingBytes = Math.round(sampleRate * leadingMs / 1000) * frameBytes;
  const trailingBytes = Math.round(sampleRate * trailingMs / 1000) * frameBytes;
  const dataSize = leadingBytes + samples.length + trailingBytes;
  const formatSize = format.length + format.length % 2;
  const totalSize = 12 + 8 + formatSize + 8 + dataSize + dataSize % 2;
  if (totalSize > MAX_AUDIO_BYTES) {
    throw new Error('Padded speech exceeds the audio size limit.');
  }
  const output = Buffer.alloc(totalSize);
  output.write('RIFF', 0);
  output.writeUInt32LE(totalSize - 8, 4);
  output.write('WAVEfmt ', 8);
  output.writeUInt32LE(format.length, 16);
  format.copy(output, 20);
  const dataOffset = 20 + formatSize;
  output.write('data', dataOffset);
  output.writeUInt32LE(dataSize, dataOffset + 4);
  // Unsigned 8-bit PCM uses midpoint 128 for silence; other supported samples use zero.
  output.fill(encoding === 1 && bits === 8 ? 128 : 0, dataOffset + 8, dataOffset + 8 + dataSize);
  samples.copy(output, dataOffset + 8 + leadingBytes);
  return { data: output, filename: 'reply.wav', mimeType: 'audio/wav' };
}

/** Synthesizes the bounded public reply text and pads it before any send attempt. */
export class VoiceSynthesizer {
  public constructor(private readonly model: SpeechModel, private readonly options: Readonly<Record<string, unknown>> = {}) {}

  public async synthesize(text: string, signal?: AbortSignal): Promise<AudioFile> {
    const audio = await this.model.synthesize(text, this.options, signal);
    signal?.throwIfAborted();
    return padVoiceAudio(audio);
  }
}
