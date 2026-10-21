import { MAX_AUDIO_BYTES, MAX_TTS_INPUT_CHARS } from '../limit';
import { AudioFile } from '../messagers/interface';
import { ResponsesApiError, resolveModelTimeoutMs } from './responses-client';

/** Provider speech synthesis; options are JSON fields such as voice, speed, or instructions. */
export interface SpeechModel {
  synthesize(text: string, options?: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<AudioFile>;
}

interface SpeechRequest {
  baseUrl: string;
  model: string;
  apiKey: string;
  text: string;
  options?: Readonly<Record<string, unknown>>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Requests bounded WAV audio from an OpenAI-compatible audio/speech endpoint. */
export async function createSpeech(request: SpeechRequest): Promise<AudioFile> {
  request.signal?.throwIfAborted();
  if (!request.text.trim() || request.text.length > MAX_TTS_INPUT_CHARS) {
    throw new Error(`Speech input must contain 1–${MAX_TTS_INPUT_CHARS} characters.`);
  }
  const url = `${request.baseUrl.replace(/\/+$/, '')}/audio/speech`;
  const timeoutMs = resolveModelTimeoutMs(request.timeoutMs);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  request.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${request.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request.options, model: request.model, input: request.text,
        response_format: 'wav', stream_format: 'audio' }),
      signal: controller.signal,
      redirect: 'error'
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ResponsesApiError(`Speech request to ${url} failed with HTTP ${response.status}.`, response.status);
    }
    if (Number(response.headers.get('content-length')) > MAX_AUDIO_BYTES || response.body === null) {
      await response.body?.cancel();
      throw new ResponsesApiError('Speech response is missing or exceeds the audio size limit.', response.status);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        size += chunk.value.byteLength;
        if (size > MAX_AUDIO_BYTES) {
          await reader.cancel();
          throw new ResponsesApiError('Speech response exceeds the audio size limit.', response.status);
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    if (!size) {
      throw new ResponsesApiError('Speech model returned empty audio.', response.status);
    }
    return { data: Buffer.concat(chunks), filename: 'reply.wav', mimeType: 'audio/wav' };
  } catch (error) {
    request.signal?.throwIfAborted();
    if (error instanceof ResponsesApiError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new ResponsesApiError(`Speech request to ${url} timed out after ${timeoutMs} ms.`);
    }
    throw new ResponsesApiError(`Speech request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', cancel);
  }
}
