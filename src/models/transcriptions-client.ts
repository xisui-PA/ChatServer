import { AudioFile } from '../messagers/interface';
import { MAX_AUDIO_BYTES } from '../messagers/audio';
import { ResponsesApiError, resolveModelTimeoutMs } from './responses-client';

/** A provider-bound speech-to-text model, independent of text-generation capabilities. */
export interface TranscriptionModel {
  transcribe(audio: AudioFile, signal?: AbortSignal): Promise<string>;
}

interface TranscriptionRequest {
  baseUrl: string;
  model: string;
  apiKey: string;
  audio: AudioFile;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Calls an OpenAI-compatible audio/transcriptions endpoint using native multipart upload. */
export async function createTranscription(request: TranscriptionRequest): Promise<string> {
  request.signal?.throwIfAborted();
  if (request.audio.data.byteLength === 0 || request.audio.data.byteLength > MAX_AUDIO_BYTES) {
    throw new Error('Transcription audio must be nonempty and no larger than 20 MiB.');
  }
  const url = `${request.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
  const timeoutMs = resolveModelTimeoutMs(request.timeoutMs);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  request.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  try {
    const form = new FormData();
    form.set('model', request.model);
    form.set('response_format', 'json');
    form.set('file', new Blob([new Uint8Array(request.audio.data)], { type: request.audio.mimeType }), request.audio.filename);
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${request.apiKey}` },
      body: form,
      signal: controller.signal,
      redirect: 'error'
    });
    if (!response.ok) {
      throw new ResponsesApiError(`Transcription request to ${url} failed with HTTP ${response.status}.`, response.status);
    }
    let result: unknown;
    try {
      result = await response.json();
    } catch (error) {
      if (controller.signal.aborted) {
        throw error;
      }
      throw new ResponsesApiError('Transcription model returned invalid JSON.', response.status);
    }
    if (typeof result !== 'object' || result === null || Array.isArray(result) ||
      !('text' in result) || typeof result.text !== 'string' || result.text.length > 32_000) {
      throw new ResponsesApiError('Transcription model must return a text string of at most 32000 characters.', response.status);
    }
    return result.text.trim();
  } catch (error) {
    request.signal?.throwIfAborted();
    if (controller.signal.aborted) {
      throw new ResponsesApiError(`Transcription request to ${url} timed out after ${timeoutMs} ms.`);
    }
    if (error instanceof ResponsesApiError) {
      throw error;
    }
    throw new ResponsesApiError(`Transcription request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', cancel);
  }
}
