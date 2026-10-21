const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const timers = require('node:timers/promises');
const store = require('../src/models/model-store');
const credentials = require('../src/models/credentials');
const conversion = require('../src/models/audio-conversion');
const { runTestStt } = require('../src/models/test-stt');
const { runTestTts } = require('../src/models/test-tts');
const { MAX_AUDIO_BYTES } = require('../src/limit');

function wav() {
  const data = Buffer.alloc(64);
  data.write('RIFF', 0);
  data.writeUInt32LE(56, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24);
  data.writeUInt32LE(32000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(20, 40);
  data.fill(0x23, 44);
  return data;
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatserver-speech-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = [];
  const progress = [];
  t.mock.method(console, 'log', value => output.push(String(value)));
  t.mock.method(console, 'error', value => progress.push(String(value)));
  t.mock.method(console, 'warn', () => {});
  const loaded = t.mock.method(store, 'loadModels', async dir => {
    assert.equal(dir, directory);
    return { version: 1, providers: [{ provider: 'speech', baseUrl: 'http://speech.fixture/v1', timeoutMs: 5000,
      models: [{ id: 'actual-stt-id', name: 'stt-alias' }, { id: 'actual-tts-id', name: 'tts-alias' }] }] };
  });
  const keys = t.mock.method(credentials, 'getModelApiKey', async name => {
    assert.equal(name, 'speech');
    return 'fixture-key';
  });
  const waits = [];
  t.mock.method(timers, 'setTimeout', async ms => waits.push(ms));
  const fetch = t.mock.method(globalThis, 'fetch', async () => assert.fail('Unexpected model request'));
  const args = name => ['--config_dir', directory, '--provider', 'speech', '--name', name];
  return { directory, output, progress, loaded, keys, waits, fetch, args };
}

test('speech test help works without files, credentials, config, or model requests', async (t) => {
  const f = await fixture(t);
  await runTestStt(['--help']);
  await runTestTts(['--help']);
  assert.ok(f.output[0].includes('--audio-conversion-cmd'));
  assert.ok(f.output[1].includes('--voice'));
  assert.equal(f.loaded.mock.callCount(), 0);
  assert.equal(f.keys.mock.callCount(), 0);
  assert.equal(f.fetch.mock.callCount(), 0);
});

test('STT test uploads the selected file with the actual model ID and prints clean JSON', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.directory, '你好 sample.WAV');
  const data = wav();
  await fs.writeFile(file, data);
  f.fetch.mock.mockImplementation(async (url, options) => {
    assert.equal(url, 'http://speech.fixture/v1/audio/transcriptions');
    assert.equal(options.headers.Authorization, 'Bearer fixture-key');
    assert.equal(options.body.get('model'), 'actual-stt-id');
    const audio = options.body.get('file');
    assert.equal(audio.name, path.basename(file));
    assert.equal(audio.type, 'audio/wav');
    assert.deepEqual(Buffer.from(await audio.arrayBuffer()), data);
    return new Response('{"text":"你好，世界。"}');
  });
  await runTestStt([...f.args('stt-alias'), '--file', file, '--json']);
  assert.deepEqual(JSON.parse(f.output.join('\n')), { text: '你好，世界。' });
  assert.ok(f.progress[0].includes('actual-stt-id'));
  assert.deepEqual(await fs.readFile(file), data);
});

test('STT conversion runs once before request retries and leaves the input unchanged', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.directory, 'input.mp3');
  await fs.writeFile(file, 'ID3original');
  const command = 'converter {input} {output}';
  const convert = t.mock.method(conversion, 'convertAudio', async (audio, cmd) => {
    assert.equal(cmd, command);
    assert.equal(Buffer.from(audio.data).toString(), 'ID3original');
    return { data: wav(), filename: 'converted.wav', mimeType: 'audio/wav' };
  });
  let attempts = 0;
  f.fetch.mock.mockImplementation(async (_url, options) => {
    assert.equal(options.body.get('file').name, 'converted.wav');
    return ++attempts === 1 ? new Response('', { status: 503 }) : new Response('{"text":"Transcribed"}');
  });
  await runTestStt([...f.args('stt-alias'), '--audio', file, '--audio-conversion-cmd', command]);
  assert.equal(convert.mock.callCount(), 1);
  assert.equal(attempts, 2);
  assert.deepEqual(f.waits, [10000]);
  assert.equal(f.output.at(-1), 'Transcribed');
  assert.equal(await fs.readFile(file, 'utf8'), 'ID3original');
});

test('invalid STT files and conversion commands fail before reading keys or requesting a model', async (t) => {
  const f = await fixture(t);
  const empty = path.join(f.directory, 'empty.wav');
  const oversized = path.join(f.directory, 'large.wav');
  const unsupported = path.join(f.directory, 'input.txt');
  await fs.writeFile(empty, '');
  await fs.writeFile(oversized, '');
  await fs.truncate(oversized, MAX_AUDIO_BYTES + 1);
  await fs.writeFile(unsupported, 'data');
  for (const file of [empty, oversized, unsupported, path.join(f.directory, 'missing.wav')]) {
    await assert.rejects(runTestStt([...f.args('stt-alias'), '--file', file]));
  }
  await assert.rejects(runTestStt([...f.args('stt-alias'), '--file', empty, '--audio-conversion-cmd', 'invalid']), /input.*output/);
  assert.equal(f.keys.mock.callCount(), 0);
  assert.equal(f.fetch.mock.callCount(), 0);
});

test('TTS test sends literal text and provider options and saves a valid padded WAV', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.directory, '输出 speech.wav');
  f.fetch.mock.mockImplementation(async (url, options) => {
    assert.equal(url, 'http://speech.fixture/v1/audio/speech');
    assert.equal(options.headers.Authorization, 'Bearer fixture-key');
    assert.deepEqual(JSON.parse(options.body), { model: 'actual-tts-id', input: '你好!', voice: 'selected-voice',
      speed: 1.2, language: 'zh', response_format: 'wav', stream_format: 'audio' });
    return new Response(wav());
  });
  await runTestTts([...f.args('tts-alias'), '--prompt', '你好!', '--voice', 'selected-voice',
    '--options', '{"voice":"overridden","speed":1.2,"language":"zh"}', '--output', file]);
  const output = await fs.readFile(file);
  assert.equal(output.toString('ascii', 0, 4), 'RIFF');
  assert.equal(output.readUInt32LE(4), output.length - 8);
  const speechSamples = output.readUInt32LE(40) - (wav().length - 44);
  assert.ok(speechSamples >= 32000 && speechSamples <= 128000);
  assert.ok(f.output.at(-1).includes(file));
});

test('TTS retries transient failures and preserves output files unless force succeeds', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.directory, 'existing.wav');
  await fs.writeFile(file, 'keep this');
  const args = [...f.args('tts-alias'), '--output', file];
  await assert.rejects(runTestTts(args), /--force/);
  assert.equal(f.fetch.mock.callCount(), 0);
  f.fetch.mock.mockImplementation(async () => new Response('', { status: 401 }));
  await assert.rejects(runTestTts([...args, '--force']), /HTTP 401/);
  assert.equal(await fs.readFile(file, 'utf8'), 'keep this');
  let attempts = 0;
  f.fetch.mock.mockImplementation(async () => ++attempts === 1 ? new Response('', { status: 503 }) : new Response(wav()));
  await runTestTts([...args, '--force']);
  assert.equal(attempts, 2);
  assert.deepEqual(f.waits, [10000]);
  assert.equal((await fs.readFile(file)).toString('ascii', 0, 4), 'RIFF');
});

test('TTS validates provider options, text, paths, and model selection before requests', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.directory, 'test.wav');
  const args = [...f.args('tts-alias'), '--output', file];
  for (const options of ['invalid JSON', 'null', '[]', '42',
    ...['model', 'input', 'response_format', 'stream_format'].map(key => JSON.stringify({ [key]: 'override' }))]) {
    await assert.rejects(runTestTts([...args, '--options', options]), /--options/);
  }
  await assert.rejects(runTestTts([...args, '--text', ' ']), /--text/);
  await assert.rejects(runTestTts([...args, '--voice', ' ']), /--voice/);
  await assert.rejects(runTestTts([...args, '--output', 'wrong.mp3']), /\.wav/);
  await assert.rejects(runTestTts([...args, '--timeout', '0']), /--timeout/);
  await assert.rejects(runTestTts([...args, '--name', 'missing-alias']), /not found/);
  assert.equal(f.keys.mock.callCount(), 0);
  assert.equal(f.fetch.mock.callCount(), 0);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('TTS with malformed provider audio does not create an output file', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.directory, 'bad.wav');
  f.fetch.mock.mockImplementation(async () => new Response('not an audio file'));
  await assert.rejects(runTestTts([...f.args('tts-alias'), '--output', file]), /WAV/);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.equal(f.fetch.mock.callCount(), 1);
});
