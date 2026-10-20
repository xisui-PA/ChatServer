import {
  AUDIO_CLEANUP_RETRIES,
  AUDIO_CLEANUP_RETRY_DELAY_MS,
  AUDIO_CONVERSION_STDERR_CHARS,
  AUDIO_CONVERSION_TIMEOUT_MS,
  MAX_AUDIO_BYTES,
  MAX_TIMER_MS
} from '../limit';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AudioFile } from '../messagers/interface';

/** Runs a configured command with bounded diagnostics, cancellation, and a process-tree deadline. */
async function runConversion(command: string, directory: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: directory, shell: true, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const stop = (error: Error): void => {
      if (settled) {
        return;
      }
      if (child.pid !== undefined) {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill('SIGKILL'));
          killer.unref();
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      }
      child.stderr?.destroy();
      child.unref();
      finish(error);
    };
    const abort = (): void => stop(signal?.reason instanceof Error ? signal.reason : new Error('Audio conversion cancelled.'));
    const timer = setTimeout(() => stop(new Error(`Audio conversion timed out after ${timeoutMs} ms.`)), timeoutMs);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(0, AUDIO_CONVERSION_STDERR_CHARS);
    });
    child.on('error', () => finish(new Error('Unable to start audioConversionCmd. Check the command and installed converter.')));
    child.on('close', (code) => finish(code === 0 ? undefined :
      new Error(`Audio conversion failed (exit ${code ?? 'unknown'})${stderr.trim() ? `: ${stderr.trim()}` : '.'}`)));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
  });
}

/** Converts input to a real WAV file in an isolated temporary directory, then removes both files. */
export async function convertAudio(
  audio: AudioFile,
  command: string,
  signal?: AbortSignal,
  timeoutMs = AUDIO_CONVERSION_TIMEOUT_MS
): Promise<AudioFile> {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_MS) {
    throw new Error(`Audio conversion timeout must be a positive integer up to ${MAX_TIMER_MS}.`);
  }
  if (!command.includes('{input}') || !command.includes('{output}')) {
    throw new Error('audioConversionCmd must contain {input} and {output} placeholders.');
  }
  if (!audio.data.byteLength || audio.data.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(`Audio conversion input must be nonempty and no larger than ${MAX_AUDIO_BYTES / (1024 * 1024)} MiB.`);
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatserver-audio-'));
  const extension = path.extname(audio.filename);
  const inputName = `input${/^\.[a-z0-9]+$/i.test(extension) ? extension : '.bin'}`;
  const outputName = 'output.wav';
  try {
    await fs.writeFile(path.join(directory, inputName), audio.data, { mode: 0o600 });
    // Only generated ASCII filenames enter the command; message content and paths never do.
    const expanded = command.replaceAll('{input}', inputName).replaceAll('{output}', outputName);
    await runConversion(expanded, directory, timeoutMs, signal);
    signal?.throwIfAborted();
    const outputPath = path.join(directory, outputName);
    let stat;
    try {
      stat = await fs.lstat(outputPath);
    } catch {
      throw new Error('audioConversionCmd did not create its {output} WAV file.');
    }
    if (!stat.isFile() || stat.size < 44 || stat.size > MAX_AUDIO_BYTES) {
      throw new Error(`Converted audio must be a nonempty WAV file no larger than ${MAX_AUDIO_BYTES / (1024 * 1024)} MiB.`);
    }
    const data = await fs.readFile(outputPath);
    if (data.subarray(0, 4).toString('ascii') !== 'RIFF' || data.subarray(8, 12).toString('ascii') !== 'WAVE') {
      throw new Error('audioConversionCmd must produce WAV data, not just rename the input.');
    }
    return { data, mimeType: 'audio/wav', filename: `${path.basename(audio.filename, extension) || 'voice'}.wav` };
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: AUDIO_CLEANUP_RETRIES, retryDelay: AUDIO_CLEANUP_RETRY_DELAY_MS });
  }
}
