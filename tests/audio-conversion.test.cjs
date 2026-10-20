const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { convertAudio } = require('../src/models/audio-conversion');
const { VoiceTranscriber } = require('../src/models/voice-transcriber');
const { ChatServer } = require('../src/server');

const audio = { data: Buffer.from('ID3fixture'), filename: 'voice_22.mp3', mimeType: 'audio/mpeg' };

function quote(value) {
  return process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
}

/** A real subprocess creates PCM WAV fixtures; no FFmpeg installation or model server needed. */
async function converter(t, mode = 'normal') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatserver converter fixture '));
  const script = path.join(directory, 'convert fixture.cjs');
  const record = path.join(directory, 'runs.jsonl');
  await fs.writeFile(script, `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ cwd: process.cwd(), input: process.argv[2], output: process.argv[3], bytes: fs.readFileSync(process.argv[2]).toString('hex') }) + '\\n');
const mode = process.argv[4];
if (mode === 'fail') { process.stderr.write('fixture converter failure'); process.exit(7); }
if (mode === 'missing') { process.exit(0); }
if (mode === 'wait') { setInterval(() => {}, 1000); }
else {
  const wav = Buffer.alloc(48);
  wav.write('RIFF'); wav.writeUInt32LE(40, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(4, 40);
  fs.writeFileSync(process.argv[3], mode === 'empty' ? '' : mode === 'wrong' ? Buffer.alloc(48) : wav);
  if (mode === 'oversized') fs.truncateSync(process.argv[3], 20 * 1024 * 1024 + 1);
}
`);
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  return { command: `${quote(process.execPath)} ${quote(script)} {input} {output} ${mode}`, record };
}

async function assertCleaned(record) {
  let contents;
  try {
    contents = await fs.readFile(record, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  const runs = contents.trim().split('\n').map((line) => JSON.parse(line));
  for (const run of runs) {
    assert.equal(run.input, 'input.mp3');
    assert.equal(run.output, 'output.wav');
    assert.equal(run.bytes, audio.data.toString('hex'));
    await assert.rejects(fs.stat(run.cwd), { code: 'ENOENT' });
  }
  return runs;
}

test('conversion returns actual WAV with updated MIME/name and removes temporary files', async (t) => {
  const fixture = await converter(t);
  const converted = await convertAudio(audio, fixture.command);
  assert.equal(converted.mimeType, 'audio/wav');
  assert.equal(converted.filename, 'voice_22.wav');
  assert.equal(converted.data.toString('ascii', 0, 4), 'RIFF');
  assert.equal(converted.data.readUInt32LE(24), 16000);
  assert.equal(converted.data.readUInt16LE(22), 1);
  assert.equal(converted.data.readUInt16LE(34), 16);
  assert.equal((await assertCleaned(fixture.record)).length, 1);
});

for (const [mode, message] of [
  ['fail', /exit 7.*fixture converter failure/],
  ['missing', /did not create/],
  ['empty', /nonempty WAV/],
  ['wrong', /must produce WAV data/],
  ['oversized', /no larger than 20 MiB/]
]) {
  test(`conversion rejects ${mode} output and cleans up`, async (t) => {
    const fixture = await converter(t, mode);
    await assert.rejects(convertAudio(audio, fixture.command), message);
    await assertCleaned(fixture.record);
  });
}

test('a hung converter is killed at its deadline and temporary files are removed', async (t) => {
  const fixture = await converter(t, 'wait');
  await assert.rejects(convertAudio(audio, fixture.command, undefined, 250), /timed out after 250 ms/);
  await assertCleaned(fixture.record);
});

test('shutdown cancellation kills conversion and cleans up', async (t) => {
  const fixture = await converter(t, 'wait');
  const controller = new AbortController();
  const task = convertAudio(audio, fixture.command, controller.signal);
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await assert.rejects(task, { name: 'AbortError' });
    await assertCleaned(fixture.record);
  } finally {
    clearTimeout(timer);
  }
});

test('invalid commands and cancelled calls do not run a converter', async () => {
  await assert.rejects(convertAudio(audio, 'ffmpeg -i input output.wav'), /placeholders/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(convertAudio(audio, 'unused {input} {output}', controller.signal), { name: 'AbortError' });
});

test('voice transcription converts before upload and cached transcripts do not rerun conversion', async (t) => {
  t.mock.method(console, 'log', () => {});
  const fixture = await converter(t);
  let requests = 0;
  const transcriber = new VoiceTranscriber({ transcribe: async (input) => {
    requests++;
    assert.equal(input.mimeType, 'audio/wav');
    assert.equal(input.filename, 'voice_22.wav');
    assert.equal(input.data.toString('ascii', 0, 4), 'RIFF');
    return 'spoken question';
  } }, 'speech/qwen', fixture.command);
  const source = { id: 'message:22', senderId: 'sender', text: '[Voice]', audio: {
    id: 'voice:22', load: async () => ({ status: 'ready', audio })
  } };
  await transcriber.transcribe([source]);
  await transcriber.transcribe([source]);
  assert.equal(requests, 1);
  assert.equal((await assertCleaned(fixture.record)).length, 1);
});

test('conversion failure never sends the original MP3 to the model', async (t) => {
  const fixture = await converter(t, 'fail');
  const transcriber = new VoiceTranscriber({ transcribe: async () => assert.fail('failed conversion must not reach STT') }, 'speech/qwen', fixture.command);
  const source = { id: '22', senderId: 'sender', text: '[Voice]', audio: {
    id: '22', load: async () => ({ status: 'ready', audio })
  } };
  await assert.rejects(transcriber.transcribe([source]), /fixture converter failure/);
  await assertCleaned(fixture.record);
});

test('chat construction resolves explicit STT models and optional conversion settings', () => {
  const calls = [];
  const references = [];
  const model = { transcribe: async () => '' };
  const options = { chats: [
    { messager: { name: 'wechat', replyer: 'chat/default' }, stt: { type: 'model', model: 'speech/first' }, filters: [] },
    { messager: { name: 'wechat', replyer: 'chat/default' }, stt: { type: 'model', model: 'speech/qwen', audioConversionCmd: 'ffmpeg -i {input} {output}' }, filters: [] }
  ] };
  const server = new ChatServer(options, '/unused');
  // Build chat bindings without starting transports or reading credentials.
  const previous = process.env.AGENT_WECHAT_TOKEN;
  process.env.AGENT_WECHAT_TOKEN = 'fixture-token';
  try {
    const chats = server.buildChats({
      get: (reference) => { references.push(reference); return {}; },
      getTranscriber: (reference) => { calls.push(reference); return model; }
    });
    assert.deepEqual(calls, ['speech/first', 'speech/qwen']);
    assert.equal(chats[0].stt.audioConversionCmd, undefined);
    assert.equal(chats[1].stt.audioConversionCmd, 'ffmpeg -i {input} {output}');
    assert.deepEqual(references, ['chat/default', 'chat/default']);
  } finally {
    if (previous === undefined) delete process.env.AGENT_WECHAT_TOKEN;
    else process.env.AGENT_WECHAT_TOKEN = previous;
  }
});
