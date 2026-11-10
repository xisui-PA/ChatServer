const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const timers = require('node:timers/promises');
const { loadConfig } = require('../src/config');
const { ImageGenerationPolicy, generatedImages } = require('../src/models/image-generation');
const { ModelRegistry } = require('../src/models/runtime');
const modelStore = require('../src/models/model-store');
const credentials = require('../src/models/credentials');
const { ModelReplier } = require('../src/repliers/model');
const { FilterOutcome } = require('../src/filters/interface');
const { WechatMessagerAdapter } = require('../src/messagers/wechat');
const { ChatServer } = require('../src/server');
const { registerMessager } = require('../src/messagers/registry');
const { MAX_IMAGE_BYTES } = require('../src/limit');
const { modelInputTokens } = require('../src/models/input-budget');
const { createConversationInput } = require('../src/models/conversation-input');
const { ReadImageTool } = require('../src/tools/read-image');
const { ToolRunner } = require('../src/tools/runner');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');
const image = { data: png, filename: 'generated.png', mimeType: 'image/png' };
const imageCall = (overrides = {}) => ({ type: 'image_generation_call', id: 'image-1', status: 'completed', result: png.toString('base64'), ...overrides });
const textItem = text => ({ type: 'message', content: [{ type: 'output_text', text }] });
const reply = (text = 'A cat.', extra = {}) => JSON.stringify({ reply: true, text, memoryUpdates: { notes: [], forget: [] }, ...extra });
const message = { id: 'message:1', senderId: 'wxid_friend', channel: 'group@chatroom', text: 'Draw a cat.',
  timestamp: new Date().toISOString(), metadata: { wechatAccount: 'wxid_bot', wechatUsername: 'wxid_bot' } };

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatserver-image-gen-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(t, respond) {
  t.mock.method(modelStore, 'loadModels', async () => ({ providers: [{ provider: 'fixture', baseUrl: 'http://image.fixture/v1',
    timeoutMs: 1000, models: [{ id: 'chat', name: 'chat' }] }] }));
  t.mock.method(credentials, 'getModelApiKey', async () => 'fixture-key');
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://image.fixture/v1/responses');
    assert.equal(options.headers.Authorization, 'Bearer fixture-key');
    const request = JSON.parse(options.body);
    assert.equal(request.model, 'chat');
    requests.push(request);
    const response = await respond(request, requests.length);
    return response instanceof Response ? response : new Response(JSON.stringify(response));
  });
  const models = await ModelRegistry.load('/unused', ['fixture/chat']);
  return { model: models.get('fixture/chat'), models, requests };
}

function adapter() {
  const transport = new WechatMessagerAdapter('wechat-token');
  transport.account = 'wxid_bot';
  transport.selfUsername = 'wxid_bot';
  transport.handler = () => {};
  return transport;
}

test('image config defaults and overrides validate before startup', async (t) => {
  const dir = await directory(t);
  const load = async fields => {
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ chats: [{ messager: {
      name: 'wechat', replier: 'fixture/chat', ...fields
    } }] }));
    return (await loadConfig(dir)).values.chats[0].messager;
  };
  const defaults = await load({});
  assert.equal(defaults.imageGeneration, undefined);
  assert.equal(defaults.imageWidthLimit, 1024);
  assert.equal(defaults.imageHeightLimit, 1024);
  assert.equal(defaults.dailyImageGenLimit, 10);
  const config = await load({ imageGeneration: true, imageWidthLimit: 1536, imageHeightLimit: 512, dailyImageGenLimit: 2 });
  assert.equal(config.imageGeneration, true);
  assert.equal(config.imageWidthLimit, 1536);
  assert.equal(config.imageHeightLimit, 512);
  assert.equal(config.dailyImageGenLimit, 2);
  const widthOnly = await load({ imageWidthLimit: 1536 });
  assert.equal(widthOnly.imageWidthLimit, 1536);
  assert.equal(widthOnly.imageHeightLimit, 1024);
  const heightOnly = await load({ imageHeightLimit: 1536 });
  assert.equal(heightOnly.imageWidthLimit, 1024);
  assert.equal(heightOnly.imageHeightLimit, 1536);
  const boundaries = await load({ imageWidthLimit: 1, imageHeightLimit: 16384 });
  assert.equal(boundaries.imageWidthLimit, 1);
  assert.equal(boundaries.imageHeightLimit, 16384);
  assert.equal((await load({ dailyImageGenLimit: 0 })).dailyImageGenLimit, 0);
  for (const imageGeneration of [null, 'true', 0, {}]) {
    await assert.rejects(load({ imageGeneration }), /imageGeneration/);
  }
  for (const field of ['imageWidthLimit', 'imageHeightLimit']) {
    for (const value of [null, '1024', '1024x1024', true, {}, [], 0, -1, 1.5, 16385]) {
      await assert.rejects(load({ [field]: value }), new RegExp(field));
    }
  }
  for (const dailyImageGenLimit of [null, '10', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(load({ dailyImageGenLimit }), /dailyImageGenLimit/);
  }
});

test('explicit image support overrides apiTools detection and bounds hosted size without mutating config', () => {
  const tools = [{ type: 'image_generation', size: '1536x1024', quality: 'high', output_format: 'jpeg' }, { type: 'web_search' }];
  const snapshot = JSON.stringify(tools);
  assert.equal(new ImageGenerationPolicy({}, []).enabled, false);
  const auto = new ImageGenerationPolicy({}, tools);
  assert.equal(auto.enabled, true);
  assert.deepEqual(auto.tools(tools), [{ type: 'web_search' }, {
    type: 'image_generation', size: '1024x1024', quality: 'high', output_format: 'png'
  }]);
  assert.deepEqual(new ImageGenerationPolicy({ imageGeneration: false }, tools).tools(tools), [{ type: 'web_search' }]);
  assert.deepEqual(new ImageGenerationPolicy({ imageGeneration: true }).tools([]), [
    { type: 'image_generation', size: '1024x1024', output_format: 'png' }
  ]);
  const larger = new ImageGenerationPolicy({ imageWidthLimit: 1536, imageHeightLimit: 1536 }, tools);
  assert.equal(larger.tools(tools)[1].size, '1536x1024');
  const landscape = new ImageGenerationPolicy({ imageGeneration: true, imageWidthLimit: 1536 });
  assert.equal(landscape.tools([])[0].size, '1536x1024');
  const portrait = new ImageGenerationPolicy({ imageGeneration: true, imageHeightLimit: 1536 });
  assert.equal(portrait.tools([])[0].size, '1024x1536');
  assert.equal(portrait.tools(tools)[1].size, '1024x1536');
  assert.equal(auto.tools([{ type: 'image_generation', size: 'auto' }])[0].size, '1024x1024');
  assert.deepEqual(new ImageGenerationPolicy({ dailyImageGenLimit: 0 }, tools).tools(tools), [{ type: 'web_search' }]);
  assert.equal(JSON.stringify(tools), snapshot);
});

test('daily reservations are shared, atomic, refundable when unused, and reset at local midnight or restart', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 20, 23, 59).getTime() });
  const settings = { imageGeneration: true, dailyImageGenLimit: 1 };
  const policy = new ImageGenerationPolicy(settings);
  const reservations = await Promise.all([policy.reserve(), policy.reserve(), policy.reserve()]);
  assert.equal(reservations.filter(Boolean).length, 1);
  await reservations[0].finish(0);
  const used = await policy.reserve();
  await used.finish(1);
  assert.equal(await policy.reserve(), undefined);
  const restarted = new ImageGenerationPolicy(settings);
  assert.ok(await restarted.reserve());
  assert.equal(await restarted.reserve(), undefined);
  t.mock.timers.tick(60_000);
  assert.ok(await restarted.reserve());
  assert.equal(await restarted.reserve(), undefined);
  // A late unused request from yesterday must not refund today's reservation.
  const old = new ImageGenerationPolicy(settings);
  const pending = await old.reserve();
  t.mock.timers.tick(24 * 60 * 60_000);
  assert.ok(await old.reserve());
  await pending.finish(0);
  assert.equal(await old.reserve(), undefined);
});

test('returned image dimensions and bytes are validated rather than trusting metadata', () => {
  assert.deepEqual(generatedImages([imageCall()]), [image]);
  for (const [offset, dimension] of [[16, 'imageWidthLimit'], [20, 'imageHeightLimit']]) {
    const oversized = Buffer.from(png);
    oversized.writeUInt32BE(1025, offset);
    assert.throws(() => generatedImages([imageCall({ result: oversized.toString('base64'), size: '1x1' })]), new RegExp(dimension));
  }
  for (const overrides of [{ status: 'failed' }, { result: null }, { result: 'invalid!' },
    { result: png.subarray(0, 8).toString('base64') }, { result: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }]) {
    assert.throws(() => generatedImages([imageCall(overrides)]));
  }
});

test('provider generation delivers image-only output and exhausts the daily cap while preserving text replies', async (t) => {
  const f = await fixture(t, (_request, round) => ({ output: round <= 2 ? [imageCall()] : [textItem(reply('Daily limit reached.'))] }));
  const policy = new ImageGenerationPolicy({ imageGeneration: true, dailyImageGenLimit: 2 });
  const replier = new ModelReplier(f.model, [], undefined, undefined, false, [], policy);
  for (let index = 0; index < 2; index++) {
    const result = await replier.replyTo({ ...message, channel: `chat-${index}` }, FilterOutcome.Optional);
    assert.equal(result.reply.text, '');
    assert.deepEqual(result.reply.images, [image]);
    assert.equal(result.reply.channel, `chat-${index}`);
    assert.equal(f.requests[index].max_tool_calls, 1);
    assert.deepEqual(f.requests[index].tools, [{ type: 'image_generation', size: '1024x1024', output_format: 'png' }]);
  }
  const result = await replier.replyTo(message, FilterOutcome.Optional);
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2].tools, undefined);
  assert.equal(result.reply.images, undefined);
  assert.equal(result.reply.text, 'Daily limit reached.');
});

test('disabling generation removes the hosted tool and keeps ordinary hosted tools available', async (t) => {
  const f = await fixture(t, () => ({ output: [textItem(reply('Hello.'))] }));
  const apiTools = ['image_generation', 'web_search'];
  const policy = new ImageGenerationPolicy({ imageGeneration: false }, apiTools);
  await new ModelReplier(f.model, [], undefined, undefined, false, apiTools, policy).replyTo(message, FilterOutcome.Optional);
  assert.deepEqual(f.requests[0].tools, [{ type: 'web_search' }]);
  assert.equal(f.requests[0].max_tool_calls, 8);
  assert.match(f.requests[0].instructions, /Ignore image generation/);
});

test('text-only responses release quota and formatting repair preserves images without generating again', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const f = await fixture(t, (_request, round) => ({ output: round === 1 ? [textItem(reply('Hello.'))]
    : round === 2 ? [imageCall(), textItem('A cat.')]
      : [textItem(reply('A cat.', { voice: true }))] }));
  const policy = new ImageGenerationPolicy({ imageGeneration: true, dailyImageGenLimit: 1 });
  const replier = new ModelReplier(f.model, [], undefined, undefined, true, [], policy);
  await replier.replyTo(message, FilterOutcome.Optional);
  const result = await replier.replyTo(message, FilterOutcome.Optional);
  assert.deepEqual(result.reply.images, [image]);
  assert.equal(result.reply.voice, undefined);
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2].tools, undefined);
  assert.equal(await policy.reserve(), undefined);
});

test('images survive local tool rounds without another image call or base64 token inflation', async (t) => {
  const call = { type: 'function_call', call_id: 'local-1', name: 'calculate', arguments: '{}' };
  const f = await fixture(t, (_request, round) => ({ output: round === 1 ? [imageCall(), call] : [textItem(reply())] }));
  let executions = 0;
  const local = { definition: { type: 'function', name: 'calculate', description: 'Calculate', parameters: {}, strict: true },
    execute: async () => { executions++; return 2; } };
  const result = await new ModelReplier(f.model, [local], undefined, undefined, false, ['image_generation']).replyTo(message, FilterOutcome.Optional);
  assert.equal(executions, 1);
  assert.deepEqual(result.reply.images, [image]);
  assert.deepEqual(f.requests[1].tools, [local.definition]);
  assert.ok(f.requests[1].input.some(item => item.type === 'image_generation_call'));
  assert.ok(modelInputTokens([imageCall({ result: 'A'.repeat(1_000_000) })], '') < 4000);
});

test('provider over-generation and incomplete images fail before delivery callbacks', async (t) => {
  for (const output of [[imageCall(), imageCall({ id: 'image-2' })], [imageCall({ status: 'failed' })]]) {
    const f = await fixture(t, () => ({ output }));
    const policy = new ImageGenerationPolicy({ imageGeneration: true, dailyImageGenLimit: 1 });
    await assert.rejects(f.model.generate('Draw a cat', '', undefined, {
      imageGeneration: policy, onImages: () => assert.fail('Invalid images delivered')
    }), /budget|incomplete/);
    assert.equal(await policy.reserve(), undefined);
    assert.equal(f.requests.length, 1);
  }
});

test('ambiguous provider failures consume quota across retries; explicit request rejection refunds it', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(timers, 'setTimeout', async () => {});
  const policy = new ImageGenerationPolicy({ imageGeneration: true, dailyImageGenLimit: 1 });
  const f = await fixture(t, (_request, round) => round === 1 ? new Response('temporary failure', { status: 503 })
    : { output: [textItem(reply('Daily limit reached.'))] });
  await f.model.generate('Draw a cat', '', undefined, { imageGeneration: policy });
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].tools, undefined);
  assert.equal(await policy.reserve(), undefined);
  const rejected = new ImageGenerationPolicy({ imageGeneration: true, dailyImageGenLimit: 1 });
  const g = await fixture(t, () => new Response('Unsupported image tool', { status: 400 }));
  await assert.rejects(g.model.generate('Draw a cat', '', undefined, { imageGeneration: rejected }), /HTTP 400/);
  assert.ok(await rejected.reserve());
});

test('WeChat stages image bytes, sends them separately, and respects direct routing', async (t) => {
  const uploads = [];
  const sends = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer wechat-token');
    if (url.endsWith('/uploads')) {
      const file = options.body.get('file');
      uploads.push({ name: file.name, type: file.type,
        bytes: Buffer.from(await file.arrayBuffer()) });
      return new Response(JSON.stringify({ id: `source-${uploads.length}`, mediaType: 'image/png',
        name: 'generated.png', byteLength: png.length, sha256: '0'.repeat(64),
        createdAt: new Date().toISOString() }), { status: 201 });
    }
    assert.ok(url.endsWith('/v1/accounts/wxid_bot/sends'), url);
    assert.match(options.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/);
    const body = JSON.parse(options.body);
    sends.push(body);
    if (body.kind === 'image') {
      return new Response(JSON.stringify({ id: 'job-1', accountId: 'wxid_bot', kind: 'send',
        threadId: body.threadId, state: 'accepted', reason: null }), { status: 202 });
    }
    return new Response(JSON.stringify({ id: 'send-1', accountId: 'wxid_bot',
      destination: body.threadId, state: 'accepted', errorCode: null,
      createdAt: new Date().toISOString() }));
  });
  const transport = adapter();
  await transport.reply(message, { text: 'A cat.', images: [image], direct: true });
  await transport.reply(message, { text: '', images: [image] });
  // The v2 API has no combined image/text send, so the caption is a separate text send.
  assert.deepEqual(sends, [
    { kind: 'image', threadId: message.senderId, sourceId: 'source-1' },
    { threadId: message.senderId, text: 'A cat.' },
    { kind: 'image', threadId: message.channel, sourceId: 'source-2' }
  ]);
  assert.deepEqual(uploads.map(item => [item.name, item.type]),
    [['generated.png', 'image/png'], ['generated.png', 'image/png']]);
  assert.ok(uploads.every(item => item.bytes.equals(png)));
  // Images cannot be mixed with synthesized voice audio.
  await assert.rejects(transport.reply(message, { images: [image], audio: { data: Buffer.from('ID3'),
    filename: 'voice.mp3', mimeType: 'audio/mpeg' } }), /voice audio/);
});

test('WeChat validates attachments before staging and never retries an uncertain send', async (t) => {
  const urls = [];
  const transport = adapter();
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    if (urls.length === 1) { throw new Error('connection lost'); }
    return new Response(JSON.stringify({ id: 'send-1', accountId: 'wxid_bot',
      destination: message.channel, state: 'accepted', errorCode: null,
      createdAt: new Date().toISOString() }));
  });
  await assert.rejects(transport.reply(message, { text: '', images: [image, { ...image, data: Buffer.from('invalid') }] }),
    /Only PNG, JPEG, GIF, and WebP/);
  await assert.rejects(transport.reply(message, { text: '', images: [{ ...image, mimeType: 'image/jpeg' }] }), /MIME/);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(transport.reply(message, { text: '', images: [image] }, cancelled.signal), { name: 'AbortError' });
  assert.equal(urls.length, 0);
  await assert.rejects(transport.reply(message, { text: '', images: [image] }), /connection lost/);
  assert.equal(urls.length, 1);
  await transport.reply(message, { text: 'A later reply.' });
  assert.equal(urls.length, 2);
});

test('pipeline wiring allows image requests through model filters and records only confirmed delivery', async (t) => {
  t.mock.method(console, 'log', () => {});
  const dir = await directory(t);
  const f = await fixture(t, request => ({ output: request.reasoning?.effort === 'none'
    ? [textItem('allowed')] : [imageCall(), textItem(reply(''))] }));
  let delivered = false;
  registerMessager('image-fixture', () => ({ name: 'fixture', start() {}, reply: async (_message, outgoing) => {
    assert.deepEqual(outgoing.images, [image]);
    assert.equal((await server.memory.load('conversation')).replies.length, 0);
    const [cached] = await server.images.forConversation('conversation').list();
    assert.equal(cached.origin, 'generated');
    assert.equal(cached.deliveryStatus, 'pending');
    delivered = true;
  } }));
  const server = new ChatServer({ chats: [{ messager: { name: 'image-fixture', replier: 'fixture/chat', localTools: [],
    imageWidthLimit: 1536, imageHeightLimit: 1024,
    apiTools: ['image_generation'] }, filters: [{ type: 'model', model: 'fixture/chat' }] }] }, dir);
  await server.memory.start();
  t.after(() => server.memory.close());
  const [chat] = server.buildChats(f.models);
  assert.equal(await server.handleMessage({ chat, memoryKey: 'conversation', selfRevision: 0 }, message, 0), true);
  assert.equal(delivered, true);
  assert.match(f.requests[0].instructions, /Generating and editing images are supported/);
  assert.equal(f.requests[0].tools, undefined);
  assert.equal(f.requests[1].tools[0].size, '1536x1024');
  const memory = await server.memory.load('conversation');
  assert.equal(memory.replies[0].text, '[Generated 1 image(s)]');
  assert.ok(!JSON.stringify(memory).includes(png.toString('base64')));
  const [cached] = await server.images.forConversation('conversation').list();
  assert.equal(cached.deliveryStatus, 'sent');
  assert.deepEqual(memory.replies[0].imageIds, [cached.id]);
  assert.equal((await server.images.forConversation('conversation').get(cached.id)).dataUrl, `data:image/png;base64,${png.toString('base64')}`);
  await assert.rejects(fs.access(path.join(dir, 'image-generation')), { code: 'ENOENT' });
});

test('failed image uploads remain cached after restart for inspection without resending or regenerating', async t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const dir = await directory(t);
  let id;
  const f = await fixture(t, (request, round) => {
    if (round === 1) {
      return { output: [imageCall(), textItem(reply())] };
    }
    if (round === 2) {
      const snapshot = JSON.parse(request.input[0].content);
      const [cached] = snapshot.cachedImages;
      id = cached.id;
      assert.equal(cached.origin, 'generated');
      assert.equal(cached.deliveryStatus, 'failed');
      assert.equal(cached.senderId, 'assistant');
      return { output: [{ type: 'function_call', call_id: 'inspect-generated', name: 'read_image',
        arguments: JSON.stringify({ imageId: id }) }] };
    }
    const parts = request.input.at(-1).content;
    const label = JSON.parse(parts[0].text);
    assert.equal(label.origin, 'generated');
    assert.equal(label.deliveryStatus, 'failed');
    assert.equal(parts.at(-1).image_url, `data:image/png;base64,${png.toString('base64')}`);
    return { output: [textItem(reply('It depicts a cat.'))] };
  });
  let sends = 0;
  let imageUploads = 0;
  registerMessager('image-cache-failure', () => ({ name: 'fixture', start() {}, reply: async (_source, outgoing) => {
    sends++;
    if (outgoing.images?.length) {
      imageUploads++;
      throw new Error('Image upload connection lost');
    }
  } }));
  const options = { chats: [{ messager: { name: 'image-cache-failure', replier: 'fixture/chat',
    localTools: ['read_image'], imageGeneration: true, dailyImageGenLimit: 1 }, filters: [] }] };
  const server = new ChatServer(options, dir);
  const [chat] = server.buildChats(f.models);
  assert.equal(await server.handleMessage({ chat, memoryKey: 'conversation', selfRevision: 0 }, message, 0), false);
  assert.equal((await server.memory.load('conversation')).replies.length, 0);
  await server.close();
  const restarted = new ChatServer(options, dir);
  t.after(() => restarted.close());
  const [newChat] = restarted.buildChats(f.models);
  const followUp = { ...message, id: 'message:2', text: 'Describe the generated image.' };
  assert.equal(await restarted.handleMessage({ chat: newChat, memoryKey: 'conversation', selfRevision: 0 }, followUp, 0), true);
  assert.equal(imageUploads, 1);
  assert.equal(sends, 2);
  assert.equal(f.requests.length, 3);
  assert.equal((await restarted.images.forConversation('conversation').get(id)).deliveryStatus, 'failed');
  assert.ok(f.requests[1].tools.some(tool => tool.type === 'image_generation'));
});

test('cache and delivery-status write failures are logged without blocking or repeating successful delivery', async t => {
  t.mock.method(console, 'log', () => {});
  const warnings = t.mock.method(console, 'warn', () => {});
  const dir = await directory(t);
  for (const method of ['saveGenerated', 'recordGeneratedDelivery']) {
    const server = new ChatServer({ chats: [] }, dir);
    await server.memory.start();
    t.after(() => server.close());
    t.mock.method(server.images, method, async () => { throw new Error('Cache disk full'); });
    let sends = 0;
    const chat = { name: 'fixture', filters: [], replierModel: 'fixture/model',
      replier: { replyTo: async () => ({ reply: { text: '', images: [image] }, memoryUpdates: { notes: [], forget: [] } }) },
      messager: { name: 'fixture', reply: async () => { sends++; } } };
    assert.equal(await server.handleMessage({ chat, memoryKey: method, selfRevision: 0 }, message, 0), true);
    assert.equal(sends, 1);
    assert.equal((await server.memory.load(method)).replies.length, 1);
    if (method === 'recordGeneratedDelivery') {
      assert.equal((await server.images.forConversation(method).list())[0].deliveryStatus, 'pending');
    }
  }
  assert.equal(warnings.mock.callCount(), 2);
});

test('completed images are cached before a formatting repair and survive an irreparable reply', async t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const dir = await directory(t);
  const f = await fixture(t, async (_request, round) => {
    if (round === 1) {
      return { output: [imageCall(), textItem('A cat.')] };
    }
    const [cached] = await server.images.forConversation('conversation').list();
    assert.equal(cached.origin, 'generated');
    assert.equal(cached.deliveryStatus, 'pending');
    return { output: [textItem('Still not valid JSON.')] };
  });
  registerMessager('image-format-failure', () => ({ name: 'fixture', start() {}, reply() {
    assert.fail('An irreparable reply must not be sent.');
  } }));
  const server = new ChatServer({ chats: [{ messager: { name: 'image-format-failure', replier: 'fixture/chat',
    localTools: [], imageGeneration: true }, filters: [] }] }, dir);
  await server.memory.start();
  t.after(() => server.close());
  const [chat] = server.buildChats(f.models);
  await assert.rejects(server.handleMessage({ chat, memoryKey: 'conversation', selfRevision: 0 }, message, 0), /invalid JSON/);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].tools, undefined);
  const [cached] = await server.images.forConversation('conversation').list();
  assert.equal(cached.deliveryStatus, 'pending');
  assert.equal((await server.images.forConversation('conversation').get(cached.id)).dataUrl, `data:image/png;base64,${png.toString('base64')}`);
  assert.equal((await server.memory.load('conversation')).replies.length, 0);
});

test('a later model-round failure reuses the completed image and caches it only once', async t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(timers, 'setTimeout', async () => {});
  const dir = await directory(t);
  const f = await fixture(t, (_request, round) => {
    if (round === 1) {
      return { output: [imageCall(), { type: 'function_call', call_id: 'local-1', name: 'fixture_tool', arguments: '{}' }] };
    }
    return round === 2 ? new Response('Temporary failure', { status: 503 }) : { output: [textItem(reply())] };
  });
  const server = new ChatServer({ chats: [] }, dir);
  await server.memory.start();
  t.after(() => server.close());
  const policy = new ImageGenerationPolicy({ imageGeneration: true, dailyImageGenLimit: 2 });
  const local = { definition: { type: 'function', name: 'fixture_tool', description: 'Fixture', parameters: {}, strict: true },
    execute: async () => {
      assert.equal((await server.images.forConversation('conversation').list()).length, 1);
      return 2;
    } };
  let sends = 0;
  const chat = { name: 'fixture', filters: [], replierModel: 'fixture/chat',
    replier: new ModelReplier(f.model, [local], undefined, undefined, false, [], policy),
    messager: { name: 'fixture', reply: async (_source, outgoing) => {
      sends++;
      assert.deepEqual(outgoing.images, [image]);
    } } };
  assert.equal(await server.handleMessage({ chat, memoryKey: 'conversation', selfRevision: 0 }, message, 0), true);
  assert.equal(sends, 1);
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests[2].tools.every(tool => tool.type !== 'image_generation'));
  assert.match(f.requests[2].instructions, /already generated/);
  assert.equal(f.requests[2].input.filter(item => item.type === 'image_generation_call').length, 1);
  const remaining = await policy.reserve();
  assert.ok(remaining);
  await remaining.finish(1);
  assert.equal(await policy.reserve(), undefined);
  const cached = await server.images.forConversation('conversation').list();
  assert.equal(cached.length, 1);
  assert.equal(cached[0].deliveryStatus, 'sent');
  assert.deepEqual((await server.memory.load('conversation')).replies[0].imageIds, [cached[0].id]);
});

test('server restart resets the shared quota and ignores legacy quota files', async t => {
  t.mock.method(console, 'log', () => {});
  const dir = await directory(t);
  const legacyPath = path.join(dir, 'image-generation', 'chat-1.json');
  await fs.mkdir(path.dirname(legacyPath));
  await fs.writeFile(legacyPath, '{invalid');
  const f = await fixture(t, request => ({ output: request.tools?.some(tool => tool.type === 'image_generation')
    ? [imageCall()] : [textItem(reply('Image limit reached.'))] }));
  let uploads = 0;
  registerMessager('memory-quota-fixture', () => ({ name: 'fixture', start() {}, reply: async (_source, outgoing) => {
    if (outgoing.images?.length) { uploads++; }
  } }));
  const options = { chats: [{ messager: { name: 'memory-quota-fixture', replier: 'fixture/chat',
    imageGeneration: true, dailyImageGenLimit: 1, localTools: [] }, filters: [] }] };
  const server = new ChatServer(options, dir);
  await server.memory.start();
  t.after(() => server.close());
  const [chat] = server.buildChats(f.models);
  assert.equal(await server.handleMessage({ chat, memoryKey: 'first', selfRevision: 0 }, message, 0), true);
  assert.equal(await server.handleMessage({ chat, memoryKey: 'second', selfRevision: 0 }, message, 0), true);
  assert.equal(uploads, 1);
  assert.equal(f.requests[1].tools, undefined);
  await server.close();
  const restarted = new ChatServer(options, dir);
  await restarted.memory.start();
  t.after(() => restarted.close());
  const [newChat] = restarted.buildChats(f.models);
  assert.equal(await restarted.handleMessage({ chat: newChat, memoryKey: 'third', selfRevision: 0 }, message, 0), true);
  assert.equal(uploads, 2);
  assert.ok(f.requests[2].tools.some(tool => tool.type === 'image_generation'));
  assert.equal(await fs.readFile(legacyPath, 'utf8'), '{invalid');
  assert.deepEqual(await fs.readdir(path.dirname(legacyPath)), ['chat-1.json']);
});

test('confirmed memory links older generated images after their labels leave the prompt and after restart', async t => {
  t.mock.method(console, 'log', () => {});
  const dir = await directory(t);
  const server = new ChatServer({ chats: [] }, dir);
  await server.memory.start();
  let sends = 0;
  const chat = { name: 'fixture', memoryTokenLimit: 4000, filters: [], replierModel: 'fixture/model',
    replier: { replyTo: async source => ({ reply: { text: source.text, images: [image] }, memoryUpdates: { notes: [], forget: [] } }) },
    messager: { name: 'fixture', reply: async () => { sends++; } } };
  for (let index = 0; index < 12; index++) {
    assert.equal(await server.handleMessage({ chat, memoryKey: 'conversation', selfRevision: 0 }, {
      ...message, id: `message:${index}`, text: `Cat ${index}.`
    }, 0), true);
  }
  await server.close();
  const restarted = new ChatServer({ chats: [] }, dir);
  t.after(() => restarted.close());
  const access = restarted.images.forConversation('conversation');
  const memory = await restarted.memory.load('conversation', 4000);
  const snapshot = JSON.parse(await createConversationInput({ ...message, text: 'Describe the first cat.', imageAccess: access, memory }));
  assert.equal(snapshot.memory.replies.length, 12);
  const first = snapshot.memory.replies[0];
  assert.equal(first.text, '[Generated 1 image(s)] Cat 0.');
  assert.equal(first.imageIds.length, 1);
  assert.ok(!snapshot.cachedImages.some(image => image.id === first.imageIds[0]));
  const result = await new ToolRunner([new ReadImageTool(access)])
    .execute('read_image', JSON.stringify({ imageId: first.imageIds[0] }));
  assert.equal(result.images[0].dataUrl, `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(result.images[0].deliveryStatus, 'sent');
  assert.equal(sends, 12);
});
