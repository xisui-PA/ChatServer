const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const timers = require('node:timers/promises');
const { loadConfig } = require('../src/config');
const { ChatServer } = require('../src/server');
const { IgnoreSenderFilter } = require('../src/filters/ignore-sender');
const { FilterOutcome } = require('../src/filters/interface');
const { WechatMessagerAdapter } = require('../src/messagers/wechat');
const { audioFile } = require('../src/messagers/audio');
const { MediaUnavailableError } = require('../src/messagers/media');
const { VoiceTranscriber } = require('../src/models/voice-transcriber');
const { createTranscription } = require('../src/models/transcriptions-client');
const { PendingMediaError } = require('../src/models/pending-media');
const { ResponsesApiError } = require('../src/models/responses-client');
const { ModelRegistry } = require('../src/models/runtime');
const modelStore = require('../src/models/model-store');
const credentials = require('../src/models/credentials');

const audio = { data: Buffer.from('ID3fixture'), filename: 'voice.mp3', mimeType: 'audio/mpeg' };
const request = { baseUrl: 'http://stt.fixture/v1/', model: 'stt-id', apiKey: 'stt-key', audio };

function quiet(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
}

function voice(id = '1', senderId = 'sender', load = async () => ({ status: 'ready', audio })) {
  return { id: `message:${id}`, senderId, text: '[Voice]', timestamp: '2026-10-19T10:00:00.000Z', audio: { id: `voice:${id}`, load } };
}

test('config accepts an optional STT reference and rejects malformed references', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatserver-voice-config-'));
  try {
    const chat = { messager: { name: 'wechat', replyer: 'chat/model' }, filters: [] };
    for (const stt of [undefined, 'speech/org/model']) {
      await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ chats: [{ ...chat, stt }] }));
      assert.equal((await loadConfig(dir)).values.chats[0].stt, stt);
    }
    for (const stt of [null, '', 'model', 42, {}]) {
      await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ chats: [{ ...chat, stt }] }));
      await assert.rejects(loadConfig(dir), /stt/);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('transcription sends actual multipart audio, model ID, and provider credentials', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://stt.fixture/v1/audio/transcriptions');
    assert.equal(options.headers.Authorization, 'Bearer stt-key');
    assert.equal(options.headers['Content-Type'], undefined);
    assert.equal(options.body.get('model'), 'stt-id');
    assert.equal(options.body.get('response_format'), 'json');
    const file = options.body.get('file');
    assert.equal(file.name, 'voice.mp3');
    assert.equal(file.type, 'audio/mpeg');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), audio.data);
    return new Response(JSON.stringify({ text: '  你好，世界。  ' }));
  });
  assert.equal(await createTranscription(request), '你好，世界。');
  assert.equal(fetch.mock.callCount(), 1);
});

test('invalid transcription responses fail without becoming generic chat input', async (t) => {
  for (const body of ['not JSON', 'null', '{}', '{"text":42}']) {
    t.mock.method(globalThis, 'fetch', async () => new Response(body));
    await assert.rejects(createTranscription(request), /invalid JSON|text string/);
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 401 }));
  await assert.rejects(createTranscription(request), (error) => error instanceof ResponsesApiError && error.status === 401);
});

test('transcription accepts silence and respects timeout and cancellation', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{"text":""}'));
  assert.equal(await createTranscription(request), '');
  const controller = new AbortController();
  controller.abort();
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  await assert.rejects(createTranscription({ ...request, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(fetch.mock.callCount(), 0);
  await assert.rejects(createTranscription({ ...request, timeoutMs: 5 }), /timed out after 5 ms/);
});

test('audio rejects invalid base64 and unsupported or disguised SILK', () => {
  assert.equal(audioFile(audio.data.toString('base64'), 'mp3', 4).filename, 'voice_4.mp3');
  for (const [data, format] of [['bad', 'mp3'], ['AAAA', 'silk'], ['AAAA', '__proto__'], [Buffer.from('#!SILK_V3').toString('base64'), 'mp3']]) {
    assert.throws(() => audioFile(data, format, 1), MediaUnavailableError);
  }
});

test('WeChat polling bundles voice with adjacent text, retains self voice, and loads media lazily', async (t) => {
  const received = [];
  const adapter = new WechatMessagerAdapter('agent-token');
  adapter.handler = (message) => received.push(message);
  adapter.account = 'bot';
  const raw = [
    { localId: 1, timestamp: '2026-10-19T10:00:01Z', type: 34, content: '<voice/>', sender: 'alice', isSelf: false },
    { localId: 2, timestamp: '2026-10-19T10:00:02Z', type: 1, content: 'Also this', sender: 'alice', isSelf: false },
    { localId: 3, timestamp: '2026-10-19T10:00:03Z', type: 34, content: '<voice/>', isSelf: true }
  ];
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer agent-token');
    return new Response(JSON.stringify(url.includes('/media/')
      ? { type: 'voice', format: 'mp3', data: audio.data.toString('base64') }
      : raw.slice().reverse()));
  });
  const cursor = { timestamp: Date.parse('2026-10-19T10:00:00Z'), ids: new Set() };
  await adapter.pollChat('group@chatroom', cursor);
  assert.equal(fetch.mock.callCount(), 1, 'polling must not download audio');
  assert.equal(received.length, 2);
  assert.deepEqual(received[0].messages.map((message) => message.id), ['message:1', 'message:2']);
  assert.equal(received[0].messages[0].text, '[Voice]');
  assert.equal(received[1].messages[0].isSelf, true);
  assert.equal(received[1].messages[0].senderId, 'bot');
  assert.equal((await received[0].messages[0].audio.load()).status, 'ready');
  assert.equal(fetch.mock.callCount(), 2);
  await adapter.pollChat('group@chatroom', cursor);
  assert.equal(received.length, 2, 'already-seen voice must not be dispatched again');
  adapter.account = 'different-account';
  await assert.rejects(received[0].messages[0].audio.load(), /account has changed/);
});

test('WeChat voice loading distinguishes pending, SILK, permanent errors, and oversized responses', async (t) => {
  const adapter = new WechatMessagerAdapter('agent-token');
  adapter.handler = () => {};
  adapter.account = 'bot';
  t.mock.method(globalThis, 'fetch', async () => new Response('{"type":"pending"}'));
  assert.equal((await adapter.loadAudio('chat', 1, 'bot')).status, 'pending');
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ type: 'voice', format: 'silk', data: 'AAAA' })));
  assert.match((await adapter.loadAudio('chat', 1, 'bot')).reason, /SILK/);
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 404 }));
  assert.equal((await adapter.loadAudio('chat', 1, 'bot')).status, 'unavailable');
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { headers: { 'Content-Length': '999999999' } }));
  assert.equal((await adapter.loadAudio('chat', 1, 'bot')).status, 'unavailable');
  await assert.rejects(adapter.loadImage('chat', 1, 'bot'), /size limit/);
});

test('transcripts preserve IDs/authors/times, run sequentially, and are reused across snapshots', async (t) => {
  quiet(t);
  const calls = [];
  let active = 0;
  let downloads = 0;
  const sources = [voice('1', 'alice', async () => { downloads++; return { status: 'ready', audio }; }), voice('2', 'bob')];
  const transcriber = new VoiceTranscriber({ transcribe: async () => {
    assert.equal(active++, 0);
    await Promise.resolve();
    calls.push('hello');
    active--;
    return 'hello';
  } }, 'speech/model');
  const result = await transcriber.transcribe(sources);
  assert.deepEqual(result.map((message) => [message.id, message.senderId, message.timestamp]), sources.map((message) => [message.id, message.senderId, message.timestamp]));
  assert.ok(result.every((message) => message.text.includes('hello') && message.audio === undefined));
  await transcriber.transcribe(sources);
  assert.equal(calls.length, 2);
  assert.equal(downloads, 1);
});

test('pending voice is retried at most three times and never replaced by fabricated text', async (t) => {
  quiet(t);
  let downloads = 0;
  const source = voice('1', 'alice', async () => { downloads++; return { status: 'pending' }; });
  const transcriber = new VoiceTranscriber({ transcribe: async () => assert.fail('must not transcribe pending audio') }, 'speech/model');
  await assert.rejects(transcriber.transcribe([source]), PendingMediaError);
  await assert.rejects(transcriber.transcribe([source]), PendingMediaError);
  assert.deepEqual(await transcriber.transcribe([source]), []);
  assert.deepEqual(await transcriber.transcribe([source]), []);
  assert.equal(downloads, 3);
});

test('silence and unavailable voice are skipped while supported text survives', async (t) => {
  quiet(t);
  const text = { id: 'text', senderId: 'alice', text: 'hello' };
  const unavailable = voice('2', 'alice', async () => ({ status: 'unavailable' }));
  const transcriber = new VoiceTranscriber({ transcribe: async () => '' }, 'speech/model');
  assert.deepEqual(await transcriber.transcribe([voice(), unavailable, text]), [text]);
});

function serverFixture(t, stt) {
  quiet(t);
  const server = new ChatServer({ chats: [] }, '/tmp/unused-voice-fixture');
  server.startProcessing = () => {};
  server.memory.load = async () => ({ notes: [], replies: [] });
  server.memory.update = async () => {};
  server.memory.recordReply = async () => {};
  const seen = [];
  const sent = [];
  const chat = {
    name: 'fixture', stt, filters: [], replierModel: 'chat/model',
    messager: { name: 'fixture', reply: async (_message, reply) => sent.push(reply) },
    replier: { replyTo: async (message) => {
      seen.push(message);
      return { reply: { text: 'reply' }, memoryUpdates: { notes: [], forget: [] } };
    } }
  };
  const process = async () => {
    server.replySlotReady = true;
    await server.processConversations();
  };
  return { server, chat, seen, sent, process };
}

test('the serial worker supplies transcribed text to both filters and replier', async (t) => {
  const transcriber = new VoiceTranscriber({ transcribe: async () => 'A spoken question?' }, 'speech/model');
  const f = serverFixture(t, transcriber);
  const filtered = [];
  f.chat.filters = [{ name: 'model', shouldReply: (message) => {
    filtered.push(message);
    return FilterOutcome.Allowed;
  } }];
  const source = voice();
  await f.server.receiveMessage(f.chat, { ...source, channel: 'group' });
  assert.equal(filtered.length, 0, 'no transcription/filter call during ingestion');
  await f.process();
  assert.equal(f.sent.length, 1);
  assert.match(filtered[0].text, /A spoken question/);
  assert.equal(f.seen[0].messages[0].id, source.id);
  assert.equal(f.seen[0].messages[0].audio, undefined);
});

test('without STT, voice is ignored without downloads and mixed text still receives a reply', async (t) => {
  const f = serverFixture(t);
  const source = voice('1', 'alice', async () => assert.fail('audio download without STT'));
  await f.server.receiveMessage(f.chat, { ...source, channel: 'group' });
  assert.equal(f.server.pending.size, 0);
  const text = { id: 'text', senderId: 'alice', text: 'hello' };
  await f.server.receiveMessage(f.chat, { ...text, channel: 'group', messages: [source, text] });
  await f.process();
  assert.equal(f.seen[0].messages.length, 1);
  assert.equal(f.seen[0].messages[0].id, 'text');
});

test('sender exclusions remove voice before any download or STT request', async (t) => {
  const f = serverFixture(t, new VoiceTranscriber({ transcribe: async () => assert.fail('ignored sender reached STT') }, 'speech/model'));
  f.chat.filters = [new IgnoreSenderFilter(['ignored'])];
  await f.server.receiveMessage(f.chat, { ...voice('1', 'ignored', async () => assert.fail('ignored sender audio downloaded')), channel: 'group' });
  assert.equal(f.server.pending.size, 0);
});

test('STT failure stops delivery and retains the unresolved source for later input', async (t) => {
  const f = serverFixture(t, new VoiceTranscriber({ transcribe: async () => { throw new Error('STT failed'); } }, 'speech/model'));
  await f.server.receiveMessage(f.chat, { ...voice(), channel: 'group' });
  await f.process();
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.seen, []);
  assert.equal([...f.server.conversations.values()][0].messages.length, 1);
});

test('pending voice uses existing bounded media scheduling before any reply', async (t) => {
  const source = voice('1', 'alice', async () => ({ status: 'pending' }));
  const f = serverFixture(t, new VoiceTranscriber({ transcribe: async () => assert.fail('pending') }, 'speech/model'));
  const retries = [];
  f.server.scheduleRetry = (...args) => retries.push(args);
  await f.server.receiveMessage(f.chat, { ...source, channel: 'group' });
  await f.process();
  assert.equal(retries.length, 1);
  assert.deepEqual(f.sent, []);
});

test('self-only voice never independently triggers transcription or reply', async (t) => {
  const f = serverFixture(t, new VoiceTranscriber({ transcribe: async () => assert.fail('self-only STT') }, 'speech/model'));
  await f.server.receiveMessage(f.chat, { ...voice(), isSelf: true, channel: 'group' });
  assert.equal(f.server.pending.size, 0);
});

test('STT registry uses the configured provider/model and normal retry policy', async (t) => {
  quiet(t);
  t.mock.method(modelStore, 'loadModels', async () => ({ version: 1, providers: [{
    provider: 'speech', baseUrl: 'http://speech.fixture/v1', timeoutMs: 12345, models: [{ id: 'org/stt', name: 'alias' }]
  }] }));
  t.mock.method(credentials, 'getModelApiKey', async (provider) => {
    assert.equal(provider, 'speech');
    return 'speech-key';
  });
  const waits = [];
  t.mock.method(timers, 'setTimeout', async (ms) => waits.push(ms));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://speech.fixture/v1/audio/transcriptions');
    assert.equal(options.body.get('model'), 'org/stt');
    assert.equal(options.headers.Authorization, 'Bearer speech-key');
    return new Response(calls++ === 0 ? '{}' : '{"text":"spoken words"}', { status: calls === 1 ? 503 : 200 });
  });
  const registry = await ModelRegistry.load('/unused', ['speech/org/stt']);
  assert.equal(await registry.getTranscriber('speech/org/stt').transcribe(audio), 'spoken words');
  assert.deepEqual(waits, [10000]);
  assert.equal(calls, 2);
});

test('startup includes the optional STT model in provider resolution', async (t) => {
  quiet(t);
  const options = { chats: [{ messager: { name: 'wechat', replyer: 'chat/model' }, stt: 'speech/stt', filters: [] }] };
  const server = new ChatServer(options, '/unused');
  server.memory.start = async () => {};
  server.memory.close = async () => {};
  server.buildChats = () => [];
  const resolved = [];
  t.mock.method(ModelRegistry, 'load', async (_dir, references) => { resolved.push(...references); return {}; });
  await server.start();
  assert.deepEqual(resolved, ['chat/model', 'speech/stt']);
  await server.close();
});
