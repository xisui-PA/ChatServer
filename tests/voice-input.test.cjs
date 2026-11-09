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
const { MAX_AUDIO_BYTES } = require('../src/limit');
const { VoiceTranscriber } = require('../src/models/voice-transcriber');
const { createTranscription } = require('../src/models/transcriptions-client');
const { PendingMediaError } = require('../src/models/pending-media');
const { ResponsesApiError } = require('../src/models/responses-client');
const { ModelRegistry } = require('../src/models/runtime');
const modelStore = require('../src/models/model-store');
const credentials = require('../src/models/credentials');

const audio = { data: Buffer.from('ID3fixture'), filename: 'voice.mp3', mimeType: 'audio/mpeg' };
const request = { baseUrl: 'http://stt.fixture/v1/', model: 'stt-id', apiKey: 'stt-key', audio };

/**
 * Dispatches live committed messages exactly as the SSE stream loop does: each event
 * carries only IDs and the adapter reads the row from the exact message route.
 */
async function deliverLive(adapter, rows, startedAt) {
  adapter.startedAt = startedAt;
  let cursor = 100;
  for (const row of rows) {
    cursor += 1;
    await adapter.handleEvent({ cursor, kind: 'message.committed',
      data: { messageId: row.id, threadId: row.threadId } });
  }
}

function quiet(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
}

function voice(id = '1', senderId = 'sender', load = async () => ({ status: 'ready', audio })) {
  return { id: `message:${id}`, senderId, text: '[Voice]', timestamp: '2026-10-19T10:00:00.000Z', audio: { id: `voice:${id}`, load } };
}

test('config allows omitted STT but requires a valid explicit model when STT is configured', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatserver-voice-config-'));
  try {
    const chat = { messager: { name: 'wechat', replier: 'chat/model' }, filters: [] };
    for (const stt of [undefined, { type: 'model', model: 'speech/org/model' },
      { type: 'model', model: 'speech/model', audioConversionCmd: 'ffmpeg -i {input} {output}' }]) {
      await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ chats: [{ ...chat, stt }] }));
      const resolved = (await loadConfig(dir)).values.chats[0].stt;
      assert.deepEqual(JSON.parse(JSON.stringify(resolved ?? null)), stt ?? null);
    }
    for (const stt of [null, '', 'speech/model', 42, {}, { type: 'other' }, { type: 'model' },
      { type: 'model', model: '' }, { type: 'model', model: null },
      { type: 'model', model: 'speech/model', audioConversionCmd: '' },
      { type: 'model', model: 'speech/model', audioConversionCmd: 'ffmpeg' },
      { type: 'model', model: 'speech/model', audioConversionCmd: 42 }]) {
      await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ chats: [{ ...chat, stt }] }));
      await assert.rejects(loadConfig(dir), /stt/);
    }
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ chats: [{ ...chat, stt: { type: 'model' } }] }));
    await assert.rejects(loadConfig(dir), /chats\[0\]\.stt\.model must be a non-empty/);
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

test('WeChat live events keep voice and text separate, retain self voice, and load media lazily', async (t) => {
  const received = [];
  const adapter = new WechatMessagerAdapter('agent-token');
  adapter.handler = (message) => received.push(message);
  adapter.account = 'acct-1';
  adapter.selfUsername = 'bot';
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(16)]);
  const rows = [
    { id: 'm-1', senderId: 'alice', type: 34, direction: 'incoming', body: null },
    { id: 'm-2', senderId: 'alice', type: 1, direction: 'incoming', body: 'Also this' },
    { id: 'm-3', senderId: null, type: 34, direction: 'outgoing', body: null }
  ].map((row, index) => ({ ...row, accountId: 'acct-1', threadId: 'group@chatroom',
    createdAt: new Date(Date.parse('2026-10-19T10:00:01Z') + index * 1000).toISOString() }));
  const urls = [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    assert.equal(String(url).includes('/contacts/'), false);
    if (String(url).includes('/messages/') && !String(url).includes('/media')) {
      const id = decodeURIComponent(String(url).split('/messages/')[1]);
      return new Response(JSON.stringify(byId.get(id)));
    }
    if (url.endsWith('/messages/m-1/media')) {
      return new Response(JSON.stringify({ items: [{ id: 'asset-1', accountId: 'acct-1',
        messageId: 'm-1', kind: 'voice', variant: 'normal', actualVariant: 'normal', state: 'available',
        contentType: 'audio/wav', byteLength: wav.length,
        contentUrl: 'http://untrusted.example/asset-1', retryable: false, jobId: null }] }));
    }
    if (url.endsWith('/media/asset-1/content')) {
      return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } });
    }
    const username = String(url).split('/').at(-1);
    return new Response(JSON.stringify({ groupId: 'group@chatroom', username, state: 'present',
      member: { id: username, username, displayName: 'Alice account', roomDisplayName: 'Alice' },
      coverage: 'cached' }));
  });
  const startedAt = Date.parse('2026-10-19T10:00:00Z');
  await deliverLive(adapter, rows, startedAt);
  assert.equal(urls.filter(url => url.includes('/media')).length, 0, 'ingestion must not request media');
  assert.equal(received.length, 3, 'each live event is its own turn');
  assert.deepEqual(received.map((message) => message.messages[0].id),
    ['message:m-1', 'message:m-2', 'message:m-3']);
  assert.equal(received[0].messages[0].text, '[Voice]');
  assert.equal(received[0].senderName, 'Alice');
  assert.equal(received[1].messages[0].text, 'Also this');
  assert.equal(received[1].senderName, 'Alice');
  assert.equal(received[2].messages[0].isSelf, true);
  assert.equal(received[2].messages[0].senderId, 'bot');
  const loaded = await received[0].messages[0].audio.load();
  assert.equal(loaded.status, 'ready');
  assert.deepEqual(Buffer.from(loaded.audio.data), wav);
  assert.equal(loaded.audio.mimeType, 'audio/wav');
  assert.ok(urls.some(url => url.endsWith('/v1/accounts/acct-1/media/asset-1/content')),
    'bytes always come from the account-scoped route');
  assert.ok(urls.every(url => !url.includes('untrusted.example')));
  await deliverLive(adapter, rows, startedAt);
  assert.equal(received.length, 3, 'already-seen messages must not be dispatched again');
  adapter.account = 'different-account';
  await assert.rejects(received[0].messages[0].audio.load(), /account has changed/);
});

test('WeChat voice loading starts one transfer, rejects unconverted audio, and bounds content', async (t) => {
  const adapter = new WechatMessagerAdapter('agent-token');
  adapter.handler = () => {};
  adapter.account = 'acct-1';
  adapter.selfUsername = 'bot';
  const pending = { id: 'asset-1', accountId: 'acct-1', messageId: 'm-1', kind: 'voice',
    variant: 'normal', actualVariant: null, state: 'pending', contentType: null,
    byteLength: null, contentUrl: null, retryable: true, jobId: null };
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), body: options?.body === undefined ? undefined : JSON.parse(options.body) });
    if (url.endsWith('/messages/m-1/media')) {
      return new Response(JSON.stringify({ items: [pending] }));
    }
    return new Response(JSON.stringify({ id: 'job-1', accountId: 'acct-1', kind: 'download',
      state: 'queued', reason: null }), { status: 202 });
  });
  assert.equal((await adapter.loadAudio('m-1', 'acct-1', 'bot')).status, 'pending');
  assert.ok(requests[1].url.endsWith('/v1/accounts/acct-1/messages/m-1/media-transfers'));
  assert.deepEqual(requests[1].body, { messageId: 'm-1', assetId: 'asset-1' });

  const available = (messageId, kind, variant, contentType) => ({ items: [{ id: 'asset-2',
    accountId: 'acct-1', messageId, kind, variant, actualVariant: variant, state: 'available',
    contentType, byteLength: 7, contentUrl: '/untrusted', retryable: false, jobId: null }] });
  t.mock.method(globalThis, 'fetch', async (url) => url.endsWith('/messages/m-2/media')
    ? new Response(JSON.stringify(available('m-2', 'voice', 'normal', 'audio/silk')))
    : new Response(Buffer.from('ID3silk'), { headers: { 'Content-Type': 'audio/silk' } }));
  const silk = await adapter.loadAudio('m-2', 'acct-1', 'bot');
  assert.equal(silk.status, 'unavailable');
  assert.match(silk.reason, /Unsupported voice MIME type/);

  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 404 }));
  assert.equal((await adapter.loadAudio('m-3', 'acct-1', 'bot')).status, 'unavailable');

  t.mock.method(globalThis, 'fetch', async (url) => url.endsWith('/messages/m-4/media')
    ? new Response(JSON.stringify(available('m-4', 'voice', 'normal', 'audio/wav')))
    : new Response('{}', { headers: { 'Content-Length': String(MAX_AUDIO_BYTES + 1) } }));
  assert.match((await adapter.loadAudio('m-4', 'acct-1', 'bot')).reason, /size limit/);

  t.mock.method(globalThis, 'fetch', async (url) => url.endsWith('/messages/m-5/media')
    ? new Response(JSON.stringify(available('m-5', 'image', 'original', 'image/png')))
    : new Response('{}', { headers: { 'Content-Length': String(MAX_AUDIO_BYTES + 1) } }));
  await assert.rejects(adapter.loadImage('m-5', 'acct-1', 'bot'), /size limit/);
});

test('a cached encoded voice copy yields to the playable WAV variant instead of failing', async (t) => {
  const adapter = new WechatMessagerAdapter('agent-token');
  adapter.handler = () => {};
  adapter.account = 'acct-1';
  adapter.selfUsername = 'bot';
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(16)]);
  // Upstream exposes `normal` (decoded WAV) and `encoded` (raw SILK) copies of one voice note.
  const encoded = { id: 'asset-encoded', accountId: 'acct-1', messageId: 'm-6', kind: 'voice',
    variant: 'encoded', actualVariant: 'encoded', state: 'available', contentType: 'audio/silk',
    byteLength: 9, contentUrl: '/untrusted', retryable: false, jobId: null };
  const normal = { ...encoded, id: 'asset-normal', variant: 'normal', actualVariant: null,
    state: 'pending', contentType: null, byteLength: null, retryable: true };
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), body: options?.body === undefined ? undefined : JSON.parse(options.body) });
    if (url.endsWith('/messages/m-6/media')) {
      return new Response(JSON.stringify({ items: [encoded, normal] }));
    }
    return new Response(JSON.stringify({ id: 'job-1', accountId: 'acct-1', kind: 'download',
      state: 'queued', reason: null }), { status: 202 });
  });
  // The cached copy is raw SILK, so the download of the playable copy is started instead.
  assert.deepEqual(await adapter.loadAudio('m-6', 'acct-1', 'bot'), { status: 'pending' });
  assert.deepEqual(requests[1].body, { messageId: 'm-6', assetId: 'asset-normal' });
  assert.deepEqual(requests.filter((request) => request.url.includes('/content')), []);

  // Once decoded, the WAV bytes are used directly; ChatServer never converts audio locally.
  const fetched = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    fetched.push(String(url));
    if (url.endsWith('/messages/m-6/media')) {
      return new Response(JSON.stringify({ items: [encoded, { ...normal, state: 'available',
        actualVariant: 'normal', contentType: 'audio/wav', byteLength: wav.length, retryable: false }] }));
    }
    return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } });
  });
  const ready = await adapter.loadAudio('m-6', 'acct-1', 'bot');
  assert.equal(ready.status, 'ready');
  assert.equal(ready.audio.mimeType, 'audio/wav');
  assert.equal(ready.audio.filename, 'voice_m-6.wav');
  assert.deepEqual(Buffer.from(ready.audio.data), wav);
  assert.ok(fetched.some((url) => url.endsWith('/v1/accounts/acct-1/media/asset-normal/content')));
  assert.ok(!fetched.some((url) => url.includes('asset-encoded')), 'raw SILK bytes are never fetched');

  // A note with only the raw copy left stays unavailable rather than being mislabeled.
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ items: [encoded] })));
  assert.equal((await adapter.loadAudio('m-6', 'acct-1', 'bot')).status, 'unavailable');
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
  const options = { chats: [{ messager: { name: 'wechat', replier: 'chat/model' }, stt: { type: 'model', model: 'speech/stt' }, filters: [] }] };
  const server = new ChatServer(options, '/unused');
  server.memory.start = async () => {};
  server.memory.close = async () => {};
  server.images.start = async () => {};
  server.images.close = async () => {};
  server.buildChats = () => [];
  const resolved = [];
  t.mock.method(ModelRegistry, 'load', async (_dir, references) => { resolved.push(...references); return {}; });
  await server.start();
  assert.deepEqual(resolved, ['chat/model', 'speech/stt']);
  await server.close();
});
