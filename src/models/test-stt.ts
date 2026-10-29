import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MAX_AUDIO_BYTES, DEFAULT_MODEL_TIMEOUT_MS } from '../limit';
import { audioFile } from '../messagers/audio';
import { AudioFile } from '../messagers/interface';
import { CliError, hasFlag, optionalValue, requireValue } from './cli-support';
import { loadTestModel, parseCommandOptions } from './command-support';
import { convertAudio } from './audio-conversion';
import { createTranscription } from './transcriptions-client';
import { withModelRetries } from './retry';

export const TEST_STT_HELP = `Usage: chatserver-models test-stt --provider <name> --name <name> --file <audio> [options]

Transcribes a local audio file through the configured provider's audio/transcriptions endpoint.

Options:
  --provider <name>              Provider name from models.json (required)
  --name <name>                  Model CLI alias from models.json (required)
  --file <path>                  Audio input; --audio is an alias (required)
  --audio-conversion-cmd <cmd>   Optional WAV conversion command using {input} and {output}
  --timeout <ms>                 Request timeout (default: provider setting or ${DEFAULT_MODEL_TIMEOUT_MS})
  --json                         Print { "text": "..." } instead of plain transcript text
  --config_dir <dir>             Config folder
  -h, --help                     Show this help

Supported input: mp3, mpeg, mpga, wav, ogg, flac, m4a, mp4, webm; maximum ${MAX_AUDIO_BYTES / (1024 * 1024)} MiB.
Use --audio-conversion-cmd for WAV-only engines such as speech.cpp.
Paths resolve from the current directory. Original audio is never modified.
The API key is read from CHATSERVER_MODEL_API_KEY or the OS credential manager.
`;

/** Reads a bounded regular file before attempting credentials or model requests. */
async function readAudio(file: string): Promise<AudioFile> {
  const input = await fs.open(file, 'r');
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_AUDIO_BYTES) {
      throw new CliError(`Audio input must be a nonempty regular file no larger than ${MAX_AUDIO_BYTES / (1024 * 1024)} MiB.`);
    }
    const data = await input.readFile();
    const audio = audioFile(data.toString('base64'), path.extname(file).slice(1), 0);
    return { ...audio, filename: path.basename(file) };
  } finally {
    await input.close();
  }
}

/** Exercises the same transcription and optional conversion used by incoming voice messages. */
export async function runTestStt(argv: string[]): Promise<void> {
  const cli = parseCommandOptions(argv, {
    valueFlags: { '--provider': 'provider', '--name': 'name', '--file': 'file', '--audio': 'file',
      '--timeout': 'timeout', '--audio-conversion-cmd': 'conversion' },
    booleanFlags: { '--json': 'json' }
  });
  if (hasFlag(cli, 'help')) {
    console.log(TEST_STT_HELP);
    return;
  }
  if (cli.positionals.length) {
    throw new CliError('Unexpected arguments. Pass the audio path with --file.');
  }
  const file = path.resolve(requireValue(cli, 'file', '--file'));
  const conversion = optionalValue(cli, 'conversion');
  if (conversion !== undefined && (!conversion.trim() || !conversion.includes('{input}') || !conversion.includes('{output}'))) {
    throw new CliError('--audio-conversion-cmd must contain {input} and {output}.');
  }
  let audio = await readAudio(file);
  const { provider, model, apiKey, timeoutMs } = await loadTestModel(cli);
  if (conversion !== undefined) {
    audio = await convertAudio(audio, conversion);
  }
  console.error(`Testing STT ${model.name} (${model.id}) via ${provider.provider}...`);
  const text = await withModelRetries(() => createTranscription({
    baseUrl: provider.baseUrl, model: model.id, apiKey, timeoutMs, audio
  }));
  console.log(hasFlag(cli, 'json') ? JSON.stringify({ text }) : text || '(no speech recognized)');
}
