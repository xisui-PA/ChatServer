import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_MODEL_TIMEOUT_MS, MAX_TTS_INPUT_CHARS } from '../limit';
import { CliError, hasFlag, optionalValue } from './cli-support';
import { loadTestModel, parseCommandOptions } from './command-support';
import { createSpeech } from './speech-client';
import { padVoiceAudio } from './voice-synthesizer';
import { withModelRetries } from './retry';

const DEFAULT_SPEECH_TEST_TEXT = 'Hello! This is a speech synthesis test.';

export const TEST_TTS_HELP = `Usage: chatserver-models test-tts --provider <name> --name <name> [options]

Synthesizes local test audio through audio/speech and saves WAV with WeChat's random padding.
This command does not send a WeChat message.

Options:
  --provider <name>    Provider name from models.json (required)
  --name <name>        Model CLI alias from models.json (required)
  --text <text>        Literal text to speak; --prompt is an alias (default: "${DEFAULT_SPEECH_TEST_TEXT}")
  --voice <name>       Provider voice name; overrides voice in --options
  --options <json>     Provider speech options as a JSON object, such as {"speed":1}
  --output <path>      WAV output file (default: tts-test.wav)
  --force              Overwrite an existing output file
  --timeout <ms>       Request timeout (default: provider setting or ${DEFAULT_MODEL_TIMEOUT_MS})
  --config_dir <dir>   Config folder
  -h, --help           Show this help

Options use the same format as tts.options in config.json. ChatServer controls
model, input, response_format=wav, and stream_format=audio. The provider must return
PCM/float WAV. Independent 0.5–2 second silences are added before and after speech.
Paths resolve from the current directory; the output directory must already exist.
The API key is read from CHATSERVER_MODEL_API_KEY or the OS credential manager.
`;

/** Validates operator-supplied provider options before making a model request. */
function speechOptions(encoded?: string): Record<string, unknown> {
  let value: unknown = {};
  if (encoded !== undefined) {
    try {
      value = JSON.parse(encoded);
    } catch {
      throw new CliError('--options must contain a valid JSON object.');
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliError('--options must contain a JSON object.');
  }
  for (const key of ['model', 'input', 'response_format', 'stream_format']) {
    if (Object.hasOwn(value, key)) {
      throw new CliError(`--options.${key} is controlled by ChatServer.`);
    }
  }
  return value as Record<string, unknown>;
}

/** Catches invalid destinations before synthesis; exclusive writes also guard creation races. */
async function checkOutput(output: string, force: boolean): Promise<void> {
  if (!(await fs.stat(path.dirname(output))).isDirectory()) {
    throw new CliError('The output directory must already exist.');
  }
  try {
    const stat = await fs.lstat(output);
    if (!stat.isFile()) {
      throw new CliError('The output path must be a regular file.');
    }
    if (!force) {
      throw new CliError(`Output file already exists: ${output}. Use --force to overwrite it.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/** Exercises real speech synthesis and the same padding used for WeChat voice replies. */
export async function runTestTts(argv: string[]): Promise<void> {
  const cli = parseCommandOptions(argv, {
    valueFlags: { '--provider': 'provider', '--name': 'name', '--text': 'text', '--prompt': 'text', '--voice': 'voice',
      '--options': 'options', '--output': 'output', '--timeout': 'timeout' },
    booleanFlags: { '--force': 'force' }
  });
  if (hasFlag(cli, 'help')) {
    console.log(TEST_TTS_HELP);
    return;
  }
  if (cli.positionals.length) {
    throw new CliError('Unexpected arguments. Pass literal speech text with --text.');
  }
  const text = optionalValue(cli, 'text') ?? DEFAULT_SPEECH_TEST_TEXT;
  if (!text.trim() || text.length > MAX_TTS_INPUT_CHARS) {
    throw new CliError(`--text must contain 1–${MAX_TTS_INPUT_CHARS} characters.`);
  }
  const options = speechOptions(optionalValue(cli, 'options'));
  const voice = optionalValue(cli, 'voice');
  if (voice !== undefined) {
    if (!voice.trim()) {
      throw new CliError('--voice must be nonempty.');
    }
    options.voice = voice.trim();
  }
  const outputOption = optionalValue(cli, 'output') ?? 'tts-test.wav';
  if (!outputOption.trim() || path.extname(outputOption).toLowerCase() !== '.wav') {
    throw new CliError('--output must be a WAV file path ending in .wav.');
  }
  const output = path.resolve(outputOption);
  const force = hasFlag(cli, 'force');
  await checkOutput(output, force);
  const { provider, model, apiKey, timeoutMs } = await loadTestModel(cli);
  console.error(`Testing TTS ${model.name} (${model.id}) via ${provider.provider}...`);
  const audio = padVoiceAudio(await withModelRetries(() => createSpeech({
    baseUrl: provider.baseUrl, model: model.id, apiKey, timeoutMs, text, options
  })));
  await fs.writeFile(output, audio.data, { flag: force ? 'w' : 'wx', mode: 0o600 });
  console.log(`Saved speech to ${output} (${audio.data.byteLength} bytes, including random padding).`);
}
