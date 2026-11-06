const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ConversationImageStore } = require('../src/conversations/image-store');
const { createConversationInput, PendingImagesError } = require('../src/models/conversation-input');
const { ReadImageTool } = require('../src/tools/read-image');
const { ToolRunner } = require('../src/tools/runner');
const { ModelRegistry } = require('../src/models/runtime');
const modelStore = require('../src/models/model-store');
const credentials = require('../src/models/credentials');
const { ModelReplier } = require('../src/repliers/model');
const { ModelFilter } = require('../src/filters/model');
const { ChatServer } = require('../src/server');
const { MEMORY_RETENTION_MS, MAX_CACHED_IMAGES_PER_CONVERSATION, CACHED_IMAGE_REFERENCE_TOKENS } = require('../src/limit');
const { countTokens } = require('../src/models/tokens');

const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6z8AAAAASUVORK5CYII=';
const source = (index, timestamp = new Date(Date.now() - 1000).toISOString()) => ({
  id: `message:${index}`, senderId: 'alice', senderName: 'Alice', text: '[Image]', timestamp,
  images: [{ id: `image:${index}`, load: async () => dataUrl }]
});
const textItem = text => ({ type: 'message', content: [{ type: 'output_text', text }] });
const answer = (notes = []) => JSON.stringify({ reply: true, text: 'A small image.', memoryUpdates: { notes, forget: [] } });

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatserver-images-'));
  const store = new ConversationImageStore(directory);
  await store.start();
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, store, access: store.forConversation('account-a/chat-a') };
}

async function provider(t, respond, supportsImageToolResults) {
  t.mock.method(modelStore, 'loadModels', async () => ({ version: 1, providers: [{
    provider: 'fixture', baseUrl: 'http://fixture.local/v1', timeoutMs: 1000,
    models: [{ id: 'model', supportsImageToolResults }, { id: 'default-model' }]
  }] }));
  t.mock.method(credentials, 'getModelApiKey', async () => 'fixture-key');
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    return new Response(JSON.stringify({ output: await respond(request, requests.length) }), { status: 200 });
  });
  return { model: (await ModelRegistry.load('/unused', ['fixture/model'])).get('fixture/model'), requests };
}

test('model settings validate image tool support, preserve explicit values, and default to false at runtime', async t => {
  const { directory } = await fixture(t);
  const settings = supportsImageToolResults => ({ version: 1, providers: [{
    provider: 'fixture', baseUrl: 'http://fixture.local/v1', models: [{ id: 'model', supportsImageToolResults }]
  }] });
  for (const value of [undefined, false, true]) {
    await modelStore.saveModels(directory, settings(value));
    const parsed = await modelStore.loadModels(directory);
    assert.equal(parsed.providers[0].models[0].supportsImageToolResults ?? false, value ?? false);
    await modelStore.saveModels(directory, parsed);
    assert.deepEqual(await modelStore.loadModels(directory), parsed);
  }
  for (const invalid of [null, 0, 1, 'true', 'false', {}, []]) {
    await modelStore.saveModels(directory, settings(invalid));
    await assert.rejects(modelStore.loadModels(directory), /supportsImageToolResults.*must be a boolean/);
  }
  const { model } = await provider(t, () => [], true);
  assert.equal(model.supportsImageToolResults, true);
  const registry = await ModelRegistry.load(directory, ['fixture/default-model']);
  assert.equal(registry.get('fixture/default-model').supportsImageToolResults, false);
});

test('image maps persist across restart, isolate conversations, and contain no prompt bytes in references', async t => {
  const { directory, store, access } = await fixture(t);
  const first = source(1);
  await access.save(first, first.images[0], dataUrl);
  const [reference] = await access.list();
  assert.equal(reference.id, 'image:1');
  assert.equal(reference.messageId, 'message:1');
  assert.equal(reference.dataUrl, undefined);
  assert.equal((await access.get('image:1')).dataUrl, dataUrl);
  assert.equal(await access.get('__proto__'), undefined);
  assert.equal(await store.forConversation('account-a/chat-b').get('image:1'), undefined);
  assert.equal(await store.forConversation('account-b/chat-a').get('image:1'), undefined);
  const files = await fs.readdir(path.join(directory, 'conversations'));
  assert.match(files[0], /^[a-f0-9]{64}\.images\.json$/);
  assert.equal((await fs.stat(path.join(directory, 'conversations', files[0]))).mode & 0o777, 0o600);
  await store.close();
  const restarted = new ConversationImageStore(directory);
  await restarted.start();
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.forConversation('account-a/chat-a').get('image:1'), await access.get('image:1'));
});

test('generated artifacts persist with separate assistant provenance, delivery labels, and conversation isolation', async t => {
  const { directory, store, access } = await fixture(t);
  const received = source(1);
  await access.save(received, received.images[0], dataUrl);
  const image = { data: Buffer.from(dataUrl.split(',')[1], 'base64'), mimeType: 'image/png', filename: 'generated.png' };
  const [id] = await store.saveGenerated('account-a/chat-a', [image]);
  assert.match(id, /^generated-image:/);
  const generated = await access.get(id);
  assert.equal(generated.origin, 'generated');
  assert.equal(generated.senderId, 'assistant');
  assert.equal(generated.messageId, id);
  assert.equal(generated.deliveryStatus, 'pending');
  assert.equal(generated.dataUrl, dataUrl);
  assert.equal((await access.get('image:1')).origin, undefined);
  assert.equal(await store.forConversation('account-b/chat-a').get(id), undefined);
  const reference = (await access.list()).find(image => image.id === id);
  assert.equal(reference.dataUrl, undefined);
  assert.equal(reference.origin, 'generated');
  assert.equal(reference.deliveryStatus, 'pending');
  await store.recordGeneratedDelivery('account-a/chat-a', [id], false);
  await store.close();
  const restarted = new ConversationImageStore(directory);
  await restarted.start();
  t.after(() => restarted.close());
  const restored = await restarted.forConversation('account-a/chat-a').get(id);
  assert.equal(restored.deliveryStatus, 'failed');
  assert.equal(restored.dataUrl, dataUrl);
  const snapshot = JSON.parse(await createConversationInput({
    senderId: 'alice', text: 'What was in the generated image?', imageAccess: restarted.forConversation('account-a/chat-a')
  }));
  assert.equal(snapshot.cachedImages.at(-1).origin, 'generated');
  assert.equal(snapshot.cachedImages.at(-1).deliveryStatus, 'failed');
  const retrieved = await new ToolRunner([new ReadImageTool(restarted.forConversation('account-a/chat-a'))])
    .execute('read_image', JSON.stringify({ imageId: id }));
  assert.equal(retrieved.images[0].dataUrl, dataUrl);
  assert.equal(retrieved.images[0].origin, 'generated');
});

test('generated artifacts share cache eviction and expiry without delivery updates refreshing retention', async t => {
  const { directory, store, access } = await fixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const image = { data: Buffer.from(dataUrl.split(',')[1], 'base64'), mimeType: 'image/png', filename: 'generated.png' };
  const received = source(1, new Date(now - 1000).toISOString());
  await access.save(received, received.images[0], dataUrl);
  const ids = await store.saveGenerated('account-a/chat-a', Array(MAX_CACHED_IMAGES_PER_CONVERSATION).fill(image));
  assert.equal((await access.list()).length, MAX_CACHED_IMAGES_PER_CONVERSATION);
  assert.equal(await access.get('image:1'), undefined);
  const original = await access.get(ids[0]);
  now += 60_000;
  await store.recordGeneratedDelivery('account-a/chat-a', [ids[0]], true);
  const updated = await access.get(ids[0]);
  assert.equal(updated.deliveryStatus, 'sent');
  assert.equal(updated.timestamp, original.timestamp);
  assert.equal(updated.expiresAt, original.expiresAt);
  now = Date.parse(original.timestamp) + MEMORY_RETENTION_MS;
  assert.equal(await access.get(ids[0]), undefined);
  await store.recordGeneratedDelivery('account-a/chat-a', ids, false);
  assert.deepEqual(await access.list(), []);
  await store.cleanup();
  assert.deepEqual(await fs.readdir(path.join(directory, 'conversations')), []);
});

test('image expiry uses original source time, is checked on lookup, and cleanup removes only image files', async t => {
  const { directory, store, access } = await fixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const first = source(1, new Date(now - 1000).toISOString());
  await access.save(first, first.images[0], dataUrl);
  const original = await access.get('image:1');
  now += 60_000;
  await access.save({ ...first, timestamp: new Date(now).toISOString() }, first.images[0], dataUrl);
  assert.equal((await access.get('image:1')).expiresAt, original.expiresAt);
  const memoryPath = path.join(directory, 'conversations', 'a'.repeat(64) + '.json');
  await fs.writeFile(memoryPath, 'memory remains untouched');
  now = Date.parse(first.timestamp) + MEMORY_RETENTION_MS;
  assert.equal(await access.get('image:1'), undefined);
  assert.deepEqual(await access.list(), []);
  await store.cleanup();
  assert.deepEqual(await fs.readdir(path.dirname(memoryPath)), [path.basename(memoryPath)]);
  assert.equal(await fs.readFile(memoryPath, 'utf8'), 'memory remains untouched');
});

test('cache rejects arbitrary URLs and malformed images, and evicts oldest images at its count limit', async t => {
  const { access } = await fixture(t);
  const first = source(1);
  for (const invalid of ['https://example.com/a.png', 'data:image/png;base64,fixture', 'data:image/jpeg;base64,' + dataUrl.split(',')[1]]) {
    await assert.rejects(access.save(first, first.images[0], invalid), /image|base64/i);
  }
  for (let index = 0; index <= MAX_CACHED_IMAGES_PER_CONVERSATION; index++) {
    const message = source(index, new Date(Date.now() - 100_000 + index).toISOString());
    await access.save(message, message.images[0], dataUrl);
  }
  assert.equal((await access.list()).length, MAX_CACHED_IMAGES_PER_CONVERSATION);
  assert.equal(await access.get('image:0'), undefined);
  assert.equal((await access.get('image:30')).id, 'image:30');
});

test('concurrent saves preserve every image and older-reference labels remain within their prompt budget', async t => {
  const { access } = await fixture(t);
  const messages = Array.from({ length: 20 }, (_, index) => ({
    ...source(index, new Date(Date.now() - 100_000 + index).toISOString()), senderName: 'A long display name '.repeat(100)
  }));
  await Promise.all(messages.map(message => access.save(message, message.images[0], dataUrl)));
  assert.equal((await access.list()).length, messages.length);
  const snapshot = JSON.parse(await createConversationInput({ id: 'q:2', senderId: 'alice', text: 'The last picture?', imageAccess: access }));
  assert.ok(snapshot.cachedImages.length > 0 && snapshot.cachedImages.length < messages.length);
  assert.equal(snapshot.cachedImages.at(-1).id, 'image:19');
  assert.ok(countTokens(JSON.stringify(snapshot.cachedImages)) <= CACHED_IMAGE_REFERENCE_TOKENS);
  // Reference eviction does not evict the actual image or IDs saved in memory.
  assert.equal((await access.get('image:0')).dataUrl, dataUrl);
});

test('latest four new images attach directly while additional images are cached for tool lookup', async t => {
  const { access } = await fixture(t);
  const messages = Array.from({ length: 5 }, (_, index) => source(index));
  const input = await createConversationInput({ ...messages[4], messages, imageAccess: access });
  assert.equal(input[0].content.filter(part => part.type === 'input_image').length, 4);
  const snapshot = JSON.parse(input[0].content[0].text);
  assert.equal(snapshot.messages[0].images[0].status, 'cached');
  assert.ok(snapshot.messages.slice(1).every(message => message.images[0].status === 'attached'));
  assert.equal((await access.list()).length, 5);
  const followUp = JSON.parse(await createConversationInput({ id: 'q:2', senderId: 'alice', text: 'What about the earlier picture?', imageAccess: access }));
  assert.equal(followUp.cachedImages.length, 5);
  assert.ok(!JSON.stringify(followUp).includes('base64'));
  assert.ok(countTokens(JSON.stringify(followUp.cachedImages)) <= CACHED_IMAGE_REFERENCE_TOKENS);
  const runner = new ToolRunner([new ReadImageTool(access)]);
  const retrieved = await runner.execute('read_image', '{"imageId":"image:0"}');
  assert.equal(retrieved.images[0].dataUrl, dataUrl);
  assert.ok(!retrieved.output.includes('base64'));
  assert.equal(JSON.parse((await runner.execute('read_image', '{"imageId":"missing"}')).output).ok, false);
});

test('cache errors do not discard directly attached images, and pending new images still defer generation', async t => {
  const first = source(1);
  t.mock.method(console, 'warn', () => {});
  const imageAccess = {
    get: async () => { throw new Error('Unreadable cache'); },
    save: async () => { throw new Error('Disk full'); },
    list: async () => { throw new Error('Unreadable cache'); }
  };
  const input = await createConversationInput({ ...first, imageAccess });
  assert.equal(input[0].content.at(-1).image_url, dataUrl);
  assert.equal(JSON.parse(input[0].content[0].text).messages[0].images[0].status, 'attached');
  await assert.rejects(createConversationInput({ ...source(2), images: [{ id: 'pending', load: async () => ({ status: 'pending' }) }], imageAccess }), PendingImagesError);
});

test('follow-up lookup after server restart attaches native image content and retains original note provenance', async t => {
  const { directory } = await fixture(t);
  const original = source(1);
  const calls = [];
  const { model, requests } = await provider(t, (_request, round) => {
    if (round === 2) {
      return [{ type: 'function_call', call_id: 'lookup-1', name: 'read_image', arguments: '{"imageId":"image:1"}' }];
    }
    return [textItem(answer(round === 3 ? [{ kind: 'fact', text: 'Image image:1 is small.', sourceIds: ['message:1'] }] : []))];
  });
  const chat = {
    name: 'fixture', memoryTokenLimit: 1000, imageLookupEnabled: true, filters: [],
    replier: new ModelReplier(model, [new ReadImageTool()]), replierModel: 'fixture/model',
    messager: { name: 'fixture', reply: async (_message, reply) => calls.push(reply) }
  };
  const server = new ChatServer({ chats: [] }, directory);
  assert.equal(await server.handleMessage({ chat, memoryKey: 'chat', selfRevision: 0 }, { ...original, messages: [original] }, 0), true);
  await server.close();
  const restarted = new ChatServer({ chats: [] }, directory);
  t.after(() => restarted.close());
  const question = { id: 'q:2', senderId: 'alice', text: 'What else is in that image?', timestamp: new Date().toISOString() };
  assert.equal(await restarted.handleMessage({ chat, memoryKey: 'chat', selfRevision: 0 }, { ...question, messages: [question] }, 0), true);
  assert.equal(calls.length, 2);
  assert.equal(requests.length, 3);
  const initial = requests[0].input[0].content;
  assert.equal(initial.at(-1).image_url, dataUrl);
  const followUp = JSON.parse(requests[1].input[0].content);
  assert.equal(followUp.cachedImages[0].id, 'image:1');
  assert.ok(!JSON.stringify(requests[1].input).includes('base64'));
  const secondRound = requests[2].input;
  assert.equal(secondRound.find(item => item.type === 'function_call_output').call_id, 'lookup-1');
  assert.equal(secondRound.at(-1).content.at(-1).image_url, dataUrl);
  assert.equal(secondRound.at(-1).content.at(-1).type, 'input_image');
  const memory = await restarted.memory.load('chat');
  assert.equal(memory.notes[0].sourceTimestamp, original.timestamp);
  assert.match(memory.notes[0].text, /image:1/);
});

test('model filters can inspect older cached images without receiving unrelated tools', async t => {
  const { access } = await fixture(t);
  const first = source(1);
  await access.save(first, first.images[0], dataUrl);
  const { model, requests } = await provider(t, (_request, round) => round === 1
    ? [{ type: 'function_call', call_id: 'filter-image', name: 'read_image', arguments: '{"imageId":"image:1"}' }]
    : [textItem('allowed')]);
  assert.equal(await new ModelFilter(model).shouldReply({ id: 'q:2', senderId: 'alice', text: 'What is in that picture?', imageAccess: access }), 'allowed');
  assert.deepEqual(requests[0].tools.map(tool => tool.name), ['read_image']);
  assert.equal(requests[1].input.at(-1).content.at(-1).image_url, dataUrl);
  assert.equal(requests[0].reasoning.effort, 'none');
});

test('multiple image lookups return all function outputs before attaching native images, and misses attach nothing', async t => {
  const { access } = await fixture(t);
  await Promise.all([source(1), source(2)].map(message => access.save(message, message.images[0], dataUrl)));
  const { model, requests } = await provider(t, (_request, round) => round === 1
    ? [1, 2, 3].map(index => ({ type: 'function_call', call_id: `image-call-${index}`, name: 'read_image', arguments: JSON.stringify({ imageId: `image:${index}` }) }))
    : [textItem('Two images.')]);
  assert.equal(await model.generate('Compare the earlier images.', 'Use images.', undefined, { localTools: [new ReadImageTool(access)] }), 'Two images.');
  const input = requests[1].input;
  const outputs = input.filter(item => item.type === 'function_call_output');
  assert.equal(outputs.length, 3);
  assert.equal(JSON.parse(outputs[2].output).ok, false);
  assert.ok(outputs.every(item => !item.output.includes('base64')));
  assert.equal(input.at(-2), outputs[2]);
  assert.equal(input.at(-1).content.filter(part => part.type === 'input_image').length, 2);
});

test('enabled models receive image IDs initially and native image content inside the tool result', async t => {
  const { access } = await fixture(t);
  const { model, requests } = await provider(t, (_request, round) => round === 1
    ? [{ type: 'function_call', call_id: 'native-image', name: 'read_image', arguments: '{"imageId":"image:1"}' }]
    : [textItem(answer())], true);
  const replier = new ModelReplier(model, [new ReadImageTool()]);
  const message = { ...source(1), text: 'Describe this picture.', imageAccess: access };
  const result = await replier.replyTo(message, 'optional');
  assert.equal(result.reply.text, 'A small image.');
  assert.equal(requests.length, 2);
  const initial = JSON.parse(requests[0].input[0].content);
  assert.equal(initial.messages[0].images[0].id, 'image:1');
  assert.equal(initial.messages[0].images[0].status, 'cached');
  assert.ok(!JSON.stringify(requests[0].input).includes('data:image/'));
  const output = requests[1].input.find(item => item.type === 'function_call_output');
  assert.equal(output.call_id, 'native-image');
  assert.ok(Array.isArray(output.output));
  assert.equal(output.output.at(-1).type, 'input_image');
  assert.equal(output.output.at(-1).image_url, dataUrl);
  assert.equal(requests[1].input.filter(item => item.role === 'user').length, 1);
});

test('enabled models can skip image inspection without receiving image bytes', async t => {
  const { access } = await fixture(t);
  const { model, requests } = await provider(t, () => [textItem(answer())], true);
  await new ModelReplier(model, [new ReadImageTool()]).replyTo({
    ...source(1), text: 'Never mind the image; just say hello.', imageAccess: access
  }, 'optional');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tool_choice, 'auto');
  assert.ok(!JSON.stringify(requests.map(request => request.input)).includes('data:image/'));
});

test('enabled filter models retrieve new images inside native tool results only when needed', async t => {
  const { access } = await fixture(t);
  const { model, requests } = await provider(t, (_request, round) => round === 1
    ? [{ type: 'function_call', call_id: 'native-filter-image', name: 'read_image', arguments: '{"imageId":"image:1"}' }]
    : [textItem('allowed')], true);
  assert.equal(await new ModelFilter(model).shouldReply({ ...source(1), imageAccess: access }), 'allowed');
  assert.ok(!JSON.stringify(requests[0].input).includes('data:image/'));
  const output = requests[1].input.find(item => item.type === 'function_call_output');
  assert.equal(output.output.at(-1).image_url, dataUrl);
  assert.equal(requests[1].input.filter(item => item.role === 'user').length, 1);
});

test('filters and repliers with different model settings share downloads and get the correct image format', async t => {
  const { access } = await fixture(t);
  let downloads = 0;
  const message = { ...source(1), imageAccess: access,
    images: [{ id: 'image:1', load: async () => { downloads++; return dataUrl; } }]
  };
  const calls = [];
  const nativeFilterModel = { supportsImageToolResults: true, generate: async input => { calls.push(input); return 'allowed'; } };
  const hybridReplierModel = { generate: async input => { calls.push(input); return answer(); } };
  assert.equal(await new ModelFilter(nativeFilterModel).shouldReply(message), 'allowed');
  await new ModelReplier(hybridReplierModel, [new ReadImageTool()]).replyTo(message, 'optional');
  assert.equal(downloads, 1);
  assert.equal(typeof calls[0], 'string');
  assert.equal(JSON.parse(calls[0]).messages[0].images[0].status, 'cached');
  assert.equal(calls[1][0].content.at(-1).image_url, dataUrl);
  assert.equal(JSON.parse(calls[1][0].content[0].text).messages[0].images[0].status, 'attached');
  // Reversing the model order also keeps both cached input variants intact.
  await new ModelFilter(nativeFilterModel).shouldReply(message);
  await new ModelReplier(hybridReplierModel, [new ReadImageTool()]).replyTo(message, 'optional');
  assert.equal(calls[0], calls[2]);
  assert.equal(calls[1], calls[3]);
  assert.equal(downloads, 1);
});

test('native image tool failures remain ordinary error results without fabricated images', async t => {
  const { access } = await fixture(t);
  const { model, requests } = await provider(t, (_request, round) => round === 1
    ? [{ type: 'function_call', call_id: 'missing-image', name: 'read_image', arguments: '{"imageId":"unknown"}' }]
    : [textItem(answer())], true);
  await model.generate('Describe the missing image.', 'Use the tool.', undefined, { localTools: [new ReadImageTool(access)] });
  const output = requests[1].input.find(item => item.type === 'function_call_output');
  assert.equal(typeof output.output, 'string');
  assert.equal(JSON.parse(output.output).ok, false);
  assert.ok(!JSON.stringify(requests).includes('base64'));
});

test('image-capable models keep direct attachments when the replier has no lookup tool', async t => {
  const { access } = await fixture(t);
  for (const imageAccess of [undefined, access]) {
    let calls = 0;
    const model = { supportsImageToolResults: true, generate: async (input, instructions, _signal, options) => {
      calls++;
      assert.equal(input[0].content.at(-1).image_url, dataUrl);
      assert.equal(JSON.parse(input[0].content[0].text).messages[0].images[0].status, 'attached');
      assert.deepEqual(options.localTools, []);
      assert.doesNotMatch(instructions, /Images are provided as source labels and IDs in the initial input/);
      return answer();
    } };
    await new ModelReplier(model, []).replyTo({ ...source(1), imageAccess }, 'optional');
    assert.equal(calls, 1);
  }
});

test('image-capable filters keep direct attachments when lookup access is unavailable', async () => {
  const model = { supportsImageToolResults: true, generate: async (input, _instructions, _signal, options) => {
    assert.equal(input[0].content.at(-1).image_url, dataUrl);
    assert.equal(options.localTools, undefined);
    return 'allowed';
  } };
  assert.equal(await new ModelFilter(model).shouldReply(source(1)), 'allowed');
});

test('pending images do not block text replies when images are retrieved through tools', async t => {
  const { access } = await fixture(t);
  const { model, requests } = await provider(t, () => [textItem(answer())], true);
  const messages = Array.from({ length: 5 }, (_, index) => source(index));
  messages[0].images[0].load = async () => ({ status: 'pending' });
  const question = { ...messages.at(-1), text: 'Ignore the images and say hello.', messages, imageAccess: access };
  await new ModelReplier(model, [new ReadImageTool()]).replyTo(question, 'optional');
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(requests[0].input[0].content).messages[0].images[0].status, 'pending');
  assert.ok(!JSON.stringify(requests[0].input).includes('data:image/'));
});

test('read_image retries pending source media when the model requests inspection', async t => {
  const { access } = await fixture(t);
  let downloads = 0;
  const message = { ...source(1), imageAccess: access, images: [{ id: 'image:1', load: async () => {
    downloads++;
    return downloads === 1 ? { status: 'pending' } : dataUrl;
  } }] };
  const { model, requests } = await provider(t, (_request, round) => round === 1
    ? [{ type: 'function_call', call_id: 'pending-image', name: 'read_image', arguments: '{"imageId":"image:1"}' }]
    : [textItem(answer())], true);
  await new ModelReplier(model, [new ReadImageTool()]).replyTo(message, 'optional');
  assert.equal(downloads, 2);
  assert.equal(JSON.parse(requests[0].input[0].content).messages[0].images[0].status, 'pending');
  const output = requests[1].input.find(item => item.type === 'function_call_output');
  assert.equal(output.output.at(-1).image_url, dataUrl);
  assert.equal((await access.get('image:1')).dataUrl, dataUrl);
});

test('existing cached images remain usable without reloading unavailable source media', async t => {
  const { access } = await fixture(t);
  const first = source(1);
  await access.save(first, first.images[0], dataUrl);
  const message = { ...first, imageAccess: access,
    images: [{ id: 'image:1', load: async () => assert.fail('Cached images must not require the original media loader.') }]
  };
  const direct = await createConversationInput(message);
  assert.equal(direct[0].content.at(-1).image_url, dataUrl);
  const reference = JSON.parse(await createConversationInput(message, undefined, { attachImages: false }));
  assert.equal(reference.messages[0].images[0].status, 'cached');
  const runner = new ToolRunner([new ReadImageTool(access, message)]);
  assert.equal((await runner.execute('read_image', '{"imageId":"image:1"}')).images[0].dataUrl, dataUrl);
});
