import { MAX_MEDIA_ATTEMPTS } from '../limit';
import { ConversationMessage, IncomingAudio } from '../messagers/interface';
import { MediaUnavailableError } from '../messagers/media';
import { PendingMediaError } from './pending-media';
import { TranscriptionModel } from './transcriptions-client';
import { convertAudio } from './audio-conversion';

interface VoiceState {
  attempts: number;
  /** undefined is unresolved; null means unavailable or no recognized speech. */
  text?: string | null;
}

/** Transcribes retained voice messages once per source, in the serialized conversation worker. */
export class VoiceTranscriber {
  private readonly states = new WeakMap<IncomingAudio, VoiceState>();

  public constructor(
    private readonly model: TranscriptionModel,
    private readonly modelReference: string,
    private readonly audioConversionCmd?: string
  ) {}

  /** Keeps author/time/ID metadata, replacing audio with ordinary untrusted transcript text. */
  public async transcribe(messages: readonly ConversationMessage[], signal?: AbortSignal): Promise<ConversationMessage[]> {
    const result: ConversationMessage[] = [];
    for (const message of messages) {
      signal?.throwIfAborted();
      if (message.audio === undefined) {
        result.push(message);
        continue;
      }
      const text = await this.transcribeVoice(message.audio, signal);
      if (text !== null) {
        result.push({ ...message, text: `[Voice transcription]\n${text}`, audio: undefined });
      }
    }
    return result;
  }

  private async transcribeVoice(audio: IncomingAudio, signal?: AbortSignal): Promise<string | null> {
    let state = this.states.get(audio);
    if (state === undefined) {
      state = { attempts: 0 };
      this.states.set(audio, state);
    }
    if (state.text !== undefined) {
      return state.text;
    }
    const unavailable = (reason: string): null => {
      state.text = null;
      console.warn(`[stt:${this.modelReference}] skipped voice ${audio.id}: ${reason}`);
      return null;
    };
    let loaded;
    try {
      loaded = await audio.load(signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof MediaUnavailableError) {
        return unavailable(error.message);
      }
      if (++state.attempts < MAX_MEDIA_ATTEMPTS) {
        throw new PendingMediaError(`Voice media ${audio.id} could not be loaded; waiting for a later turn.`);
      }
      return unavailable(`media download failed after ${MAX_MEDIA_ATTEMPTS} attempts`);
    }
    signal?.throwIfAborted();
    if (loaded.status === 'unavailable') {
      return unavailable(loaded.reason ?? 'media unavailable');
    }
    if (loaded.status === 'pending') {
      if (++state.attempts < MAX_MEDIA_ATTEMPTS) {
        throw new PendingMediaError(`Voice media ${audio.id} is pending; waiting for a later turn.`);
      }
      return unavailable(`media still pending after ${MAX_MEDIA_ATTEMPTS} attempts`);
    }
    state.attempts = 0;
    const input = this.audioConversionCmd === undefined ? loaded.audio :
      await convertAudio(loaded.audio, this.audioConversionCmd, signal);
    // Provider errors retain the unresolved source; normal model retries happen inside transcribe.
    const text = (await this.model.transcribe(input, signal)).trim();
    signal?.throwIfAborted();
    if (!text) {
      return unavailable('no speech recognized');
    }
    state.text = text;
    console.log(`[stt:${this.modelReference}] transcribed voice ${audio.id}`);
    return text;
  }
}
