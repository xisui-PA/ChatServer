const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const timers = require('node:timers/promises');
const { loadConfig } = require('../src/config');
const { createSpeech } = require('../src/models/speech-client');
const { padVoiceAudio, VoiceSynthesizer } = require('../src/models/voice-synthesizer');
const { ModelRegistry } = require('../src/models/runtime');
const modelStore = require('../src/models/model-store');
const credentials = require('../src/models/credentials');
const { ModelReplier } = require('../src/repliers/model');
const { FilterOutcome } = require('../src/filters/interface');
const { WechatMessagerAdapter } = require('../src/messagers/wechat');
const { ChatServer } = require('../src/server');
const { registerMessager } = require('../src/messagers/registry');
const { MAX_AUDIO_BYTES, MIN_VOICE_PADDING_MS, MAX_VOICE_PADDING_MS, WECHAT_VOICE_JOB_TIMEOUT_MS } = require('../src/limit');

function wav(bits = 16, encoding = 1) {
  const frameBytes = bits / 8;
  const data = Buffer.alloc(44 + frameBytes * 10, 0);
  data.write('RIFF', 0);
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(encoding, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24);
  data.writeUInt32LE(16000 * frameBytes, 28);
  data.writeUInt16LE(frameBytes, 32);
  data.writeUInt16LE(bits, 34);
  data.write('data', 36);
  data.writeUInt32LE(data.length - 44, 40);
  data.fill(0x25, 44);
  return { data, filename: 'speech.wav', mimeType: 'audio/wav' };
}

const message = { id: 'message:1', senderId: 'wxid_friend', channel: 'group@chatroom',
  text: 'Please reply by voice.', timestamp: new Date().toISOString(), metadata: { wechatAccount: 'wxid_bot' } };
const response = voice => JSON.stringify({ reply: true, text: 'Here is the answer.', voice, memoryUpdates: { notes: [], forget: [] } });
const job = (status, extra = {}) => ({ jobId: 'voice-job-1', chatId: message.channel, accountId: 'wxid_bot', status, ...extra });

function adapter() {
  const result = new WechatMessagerAdapter('agent-fixture-token');
  result.account = 'wxid_bot';
  result.handler = () => {};
  return result;
}

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatserver-tts-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('TTS config accepts explicit models and provider options while rejecting malformed and reserved fields', async (t) => {
  const dir = await directory(t);
  const write = tts => fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ chats: [{
    messager: { name: 'wechat', replier: 'chat/model' }, tts
  }] }));
  await write(undefined);
  assert.equal((await loadConfig(dir)).values.chats[0].tts, undefined);
  const options = { voice: 'provider-voice', speed: 1.1, instructions: 'A calm tone', language: 'zh' };
  for (const value of [{ type: 'model', model: 'speech/org/model', options }, { type: 'model', model: 'speech/model' }]) {
    await write(value);
    const parsed = (await loadConfig(dir)).values.chats[0].tts;
    assert.equal(parsed.model, value.model);
    assert.deepEqual(parsed.options, value.options ?? {});
  }
  for (const value of [null, '', 'speech/model', {}, { type: 'other', model: 'speech/model' }, { type: 'model' },
    { type: 'model', model: 'invalid' }, { type: 'model', model: 'speech/model', options: null },
    { type: 'model', model: 'speech/model', options: [] },
    ...['model', 'input', 'response_format', 'stream_format'].map(key => ({ type: 'model', model: 'speech/model', options: { [key]: 'override' } }))]) {
    await write(value);
    await assert.rejects(loadConfig(dir), /tts/);
  }
});

test('speech requests bind provider credentials, model, options, and WAV output', async (t) => {
  const audio = wav();
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://speech.fixture/v1/audio/speech');
    assert.equal(options.headers.Authorization, 'Bearer fixture-key');
    assert.deepEqual(JSON.parse(options.body), { voice: 'local-voice', speed: 1.2, instructions: 'Calm',
      model: 'tts-id', input: 'Hello!', response_format: 'wav', stream_format: 'audio' });
    return new Response(audio.data, { headers: { 'Content-Type': 'audio/wav' } });
  });
  const result = await createSpeech({ baseUrl: 'http://speech.fixture/v1/', model: 'tts-id', apiKey: 'fixture-key',
    text: 'Hello!', options: { voice: 'local-voice', speed: 1.2, instructions: 'Calm' } });
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(Buffer.from(result.data), audio.data);
  assert.equal(result.mimeType, 'audio/wav');
});

test('speech requests reject missing or excessive audio and respect deadlines and cancellation', async (t) => {
  const request = { baseUrl: 'http://speech.fixture/v1', model: 'tts-id', apiKey: 'fixture-key', text: 'Hello' };
  t.mock.method(globalThis, 'fetch', async () => new Response('', { headers: { 'Content-Length': String(MAX_AUDIO_BYTES + 1) } }));
  await assert.rejects(createSpeech(request), /size limit/);
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array()));
  await assert.rejects(createSpeech(request), /empty audio/);
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 401 }));
  await assert.rejects(createSpeech(request), /HTTP 401/);
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createSpeech({ ...request, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(fetch.mock.callCount(), 0);
  await assert.rejects(createSpeech({ ...request, timeoutMs: 5 }), /timed out after 5 ms/);
});

test('provider-bound speech synthesis uses the configured model and retries before any delivery', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(modelStore, 'loadModels', async () => ({ providers: [{ provider: 'speech', baseUrl: 'http://speech.fixture/v1',
    timeoutMs: 1000, models: [{ id: 'tts-id', name: 'speech-name' }] }] }));
  t.mock.method(credentials, 'getModelApiKey', async () => 'fixture-key');
  const waits = [];
  t.mock.method(timers, 'setTimeout', async ms => waits.push(ms));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(JSON.parse(options.body).model, 'tts-id');
    assert.equal(options.headers.Authorization, 'Bearer fixture-key');
    return ++calls === 1 ? new Response('', { status: 503 }) : new Response(wav().data);
  });
  const registry = await ModelRegistry.load('/unused-tts', ['speech/tts-id']);
  assert.throws(() => registry.getSynthesizer('missing/model'), /not been loaded/);
  const audio = await registry.getSynthesizer('speech/tts-id').synthesize('Hello', { voice: 'fixture' });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [10000]);
  assert.ok(audio.data.byteLength > 0);
});

test('padding independently samples 0.5 and 2 seconds, preserving PCM/float speech and correct WAV lengths', (t) => {
  for (const [bits, encoding] of [[8, 1], [16, 1], [24, 1], [32, 1], [32, 3], [64, 3]]) {
    let count = 0;
    t.mock.method(crypto, 'randomInt', (min, max) => {
      assert.equal(min, MIN_VOICE_PADDING_MS);
      assert.equal(max, MAX_VOICE_PADDING_MS + 1);
      return count++ === 0 ? min : max - 1;
    });
    const original = wav(bits, encoding);
    const padded = Buffer.from(padVoiceAudio(original).data);
    const frameBytes = bits / 8;
    const leading = 8000 * frameBytes;
    const trailing = 32000 * frameBytes;
    const silence = bits === 8 ? 128 : 0;
    assert.equal(count, 2);
    assert.equal(padded.readUInt32LE(4), padded.length - 8);
    assert.equal(padded.readUInt32LE(40), leading + original.data.length - 44 + trailing);
    assert.ok(padded.subarray(44, 44 + leading).every(value => value === silence));
    assert.deepEqual(padded.subarray(44 + leading, padded.length - trailing), original.data.subarray(44));
    assert.ok(padded.subarray(padded.length - trailing).every(value => value === silence));
  }
});

test('padding handles streaming WAV sizes and rejects invalid or compressed audio', () => {
  const streaming = wav();
  streaming.data.writeUInt32LE(0xffffffff, 4);
  streaming.data.writeUInt32LE(0xffffffff, 40);
  assert.ok(padVoiceAudio(streaming).data.byteLength > streaming.data.byteLength);
  const broken = wav();
  broken.data.writeUInt32LE(100000, 40);
  const badAlign = wav();
  badAlign.data.writeUInt16LE(3, 32);
  for (const audio of [{ ...wav(), data: Buffer.from('ID3not-wav') }, broken, badAlign, wav(16, 6)]) {
    assert.throws(() => padVoiceAudio(audio), /uncompressed PCM or float WAV/);
  }
});

test('the replier selects voice with one generation and defaults to text without TTS', async () => {
  for (const [enabled, selected] of [[true, true], [true, false], [false, true]]) {
    let calls = 0;
    const replier = new ModelReplier({ generate: async (_input, instructions) => {
      calls++;
      assert.match(instructions, enabled ? /explicitly asks for a voice reply/ : /Voice replies are unavailable/);
      if (enabled) { assert.match(instructions, /Receiving a voice message alone is not a request/); }
      return response(selected);
    } }, [], undefined, undefined, enabled);
    const result = await replier.replyTo(message, FilterOutcome.Optional);
    assert.equal(calls, 1);
    assert.equal(result.reply.voice, enabled && selected ? true : undefined);
    assert.equal(result.reply.text, 'Here is the answer.');
  }
});

test('malformed voice selection is logged and repaired with the original output', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  let calls = 0;
  const replier = new ModelReplier({ generate: async (input, _instructions, _signal, options) => {
    if (++calls === 1) { return response('true'); }
    assert.equal(JSON.parse(input).output, response('true'));
    assert.deepEqual(options.tools, []);
    return response(true);
  } }, [], undefined, undefined, true);
  assert.equal((await replier.replyTo(message, FilterOutcome.Optional)).reply.voice, true);
  assert.equal(calls, 2);
  assert.ok(warnings.mock.calls.some(call => call.arguments.includes(response('true'))));
});

test('configured TTS receives only reply text and memory records it after confirmed delivery', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = await directory(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let startedSending;
  const sending = new Promise(resolve => { startedSending = resolve; });
  const options = { voice: 'local-voice' };
  registerMessager('tts-fixture', () => ({ name: 'fixture', start() {}, async reply(_source, reply) {
    assert.equal(reply.voice, true);
    assert.equal(reply.text, 'Here is the answer.');
    assert.equal(reply.audio.mimeType, 'audio/wav');
    assert.ok(reply.audio.data.byteLength > wav().data.byteLength);
    startedSending();
    await gate;
  } }));
  const server = new ChatServer({ chats: [{ messager: { name: 'tts-fixture', replier: 'chat/model', tools: [] }, filters: [],
    tts: { type: 'model', model: 'speech/model', options } }] }, dir);
  await server.memory.start();
  t.after(() => server.memory.close());
  let synthesizes = 0;
  const [chat] = server.buildChats({ get: () => ({ generate: async () => response(true) }),
    getSynthesizer: reference => {
      assert.equal(reference, 'speech/model');
      return { synthesize: async (text, suppliedOptions) => {
        synthesizes++;
        assert.equal(text, 'Here is the answer.');
        assert.deepEqual(suppliedOptions, options);
        return wav();
      } };
    } });
  const task = server.handleMessage({ chat, memoryKey: 'conversation', selfRevision: 0 }, message, 0);
  await sending;
  assert.equal((await server.memory.load('conversation')).replies.length, 0);
  release();
  assert.equal(await task, true);
  assert.equal(synthesizes, 1);
  const memory = await server.memory.load('conversation');
  assert.equal(memory.replies[0].text, 'Here is the answer.');
  assert.ok(!JSON.stringify(memory).includes('audio'));
});

test('TTS failure and superseded generation prevent upload and confirmed memory', async (t) => {
  t.mock.method(console, 'log', () => {});
  for (const superseded of [false, true]) {
    const server = new ChatServer({ chats: [] }, '/unused-tts');
    server.memory.load = async () => ({ notes: [], replies: [] });
    server.memory.update = async () => {};
    server.memory.recordReply = async () => assert.fail('unconfirmed reply recorded');
    let conversation;
    const chat = { name: 'fixture', filters: [], replier: { replyTo: async () => ({ reply: { text: 'Hello', voice: true }, memoryUpdates: { notes: [], forget: [] } }) },
      messager: { name: 'fixture', reply: async () => assert.fail('stale or failed speech uploaded') },
      tts: { synthesize: async () => {
        if (!superseded) { throw new Error('speech provider unavailable'); }
        conversation.selfRevision = 1;
        return wav();
      } } };
    conversation = { chat, memoryKey: 'fixture', selfRevision: 0 };
    await assert.rejects(server.handleMessage(conversation, message, 0), superseded ? undefined : /speech provider unavailable/);
  }
});

test('WeChat voice upload uses multipart and idempotency, waiting for completion before resolving', async (t) => {
  const transport = adapter();
  const audio = wav();
  const urls = [];
  let polls = 0;
  t.mock.method(timers, 'setTimeout', async () => {});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    urls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer agent-fixture-token');
    if (options.method === 'POST') {
      assert.match(options.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/);
      assert.equal(options.headers['Content-Type'], undefined);
      assert.equal(options.body.get('chatId'), message.channel);
      const file = options.body.get('audio');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), audio.data);
      return new Response(JSON.stringify(job('queued')), { status: 202 });
    }
    polls++;
    return new Response(JSON.stringify(job(polls === 1 ? 'recording' : 'completed')));
  });
  await transport.reply(message, { text: 'Here is the answer.', voice: true, audio });
  assert.equal(urls.filter(url => url.endsWith('/api/messages/voice')).length, 1);
  assert.equal(polls, 2);
  assert.ok(urls.every(url => !url.endsWith('/api/messages/send')));
});

test('uncertain voice jobs are not resent or followed by a text fallback; the send queue recovers', async (t) => {
  const transport = adapter();
  let uploads = 0;
  let texts = 0;
  t.mock.method(timers, 'setTimeout', async () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.endsWith('/api/messages/send')) { texts++; return new Response('{"success":true}'); }
    if (url.endsWith('/api/messages/voice')) { uploads++; return new Response(JSON.stringify(job('needs_review'))); }
    assert.fail('terminal job should not be polled or cancelled');
  });
  await assert.rejects(transport.reply(message, { text: 'Answer', voice: true, audio: wav() }), /needs_review/);
  assert.equal(uploads, 1);
  assert.equal(texts, 0);
  await transport.reply(message, { text: 'A later text reply' });
  assert.equal(texts, 1);
});

test('cancellation stops polling and sends a separate best-effort voice-job cancellation', async (t) => {
  const transport = adapter();
  const controller = new AbortController();
  const urls = [];
  t.mock.method(timers, 'setTimeout', async () => { controller.abort(); controller.signal.throwIfAborted(); });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    urls.push(url);
    if (url.endsWith('/cancel')) {
      assert.equal(options.signal.aborted, false);
      assert.equal(options.method, 'POST');
      return new Response(JSON.stringify(job('cancelled')));
    }
    return new Response(JSON.stringify(job('queued')), { status: 202 });
  });
  await assert.rejects(transport.reply(message, { text: 'Answer', voice: true, audio: wav() }, controller.signal), /unconfirmed/);
  assert.equal(urls.length, 2);
  assert.ok(urls[1].endsWith('/voice-job-1/cancel'));
});

test('voice job deadline cancels a pending job without resubmitting audio', async (t) => {
  const originalTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) =>
    originalTimeout(callback, ms === WECHAT_VOICE_JOB_TIMEOUT_MS ? 5 : ms, ...args));
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url);
    return new Response(JSON.stringify(job(url.endsWith('/cancel') ? 'cancelled' : 'queued')));
  });
  await assert.rejects(adapter().reply(message, { text: 'Answer', voice: true, audio: wav() }), /exceeded/);
  assert.equal(urls.length, 2);
  assert.ok(urls[1].endsWith('/cancel'));
});

test('a cancelled synthesizer never returns padded speech for delivery', async () => {
  const controller = new AbortController();
  const synthesizer = new VoiceSynthesizer({ synthesize: async () => { controller.abort(); return wav(); } });
  await assert.rejects(synthesizer.synthesize('Hello', controller.signal), { name: 'AbortError' });
});
