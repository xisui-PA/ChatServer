const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MessagerContextFile } = require('../src/messagers/context-file');
const { createConversationInput } = require('../src/models/conversation-input');
const { countTokens } = require('../src/models/tokens');
const { CONVERSATION_TEXT_TOKENS, MESSAGER_CONTEXT_TOKENS } = require('../src/limit');
const { ChatServer } = require('../src/server');
const { ModelFilter } = require('../src/filters/model');
const { ModelReplier } = require('../src/repliers/model');
const { registerMessager } = require('../src/messagers/registry');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatserver-context-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, context: new MessagerContextFile(directory, 'wechat') };
}

test('missing context files and directories are not created', async (t) => {
  const { directory, context } = await fixture(t);
  assert.equal(await context.load(), undefined);
  await assert.rejects(fs.stat(context.path), { code: 'ENOENT' });
  const missingDirectory = path.join(directory, 'not-created');
  assert.equal(await new MessagerContextFile(missingDirectory, 'wechat').load(), undefined);
  await assert.rejects(fs.stat(missingDirectory), { code: 'ENOENT' });
});

test('plain UTF-8 background loads, updates, and disappears without restarting or recreating files', async (t) => {
  const { context } = await fixture(t);
  await fs.writeFile(context.path, ' \nFriend wxid_alice: 爱丽丝在学习摄影。\nGroup club@chatroom: Weekend outings.\n');
  assert.equal(await context.load(), 'Friend wxid_alice: 爱丽丝在学习摄影。\nGroup club@chatroom: Weekend outings.');
  await fs.writeFile(context.path, 'Updated background');
  assert.equal(await context.load(), 'Updated background');
  await fs.writeFile(context.path, ' \n\t ');
  assert.equal(await context.load(), undefined);
  await fs.unlink(context.path);
  assert.equal(await context.load(), undefined);
  await assert.rejects(fs.stat(context.path), { code: 'ENOENT' });
});

test('context read failures warn and continue without context', async (t) => {
  const { context } = await fixture(t);
  const warning = t.mock.method(console, 'warn', () => {});
  await fs.mkdir(context.path);
  assert.equal(await context.load(), undefined);
  assert.equal(warning.mock.callCount(), 1);
  assert.match(warning.mock.calls[0].arguments[0], /continuing without additional context/);
});

test('background has a separate bounded budget and does not evict snapshot messages', async () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({
    id: `message:${index}`, senderId: `sender:${index}`, text: 'word '.repeat(400)
  }));
  const message = { id: 'root', senderId: 'sender', channel: 'group', text: 'hello', messages };
  const baseline = JSON.parse(await createConversationInput(message));
  const withContext = JSON.parse(await createConversationInput({ ...message, additionalContext: 'Background '.repeat(20000) }));
  assert.deepEqual(withContext.messages, baseline.messages);
  assert.match(withContext.additionalContext, /\[truncated\]$/);
  assert.ok(countTokens(withContext.additionalContext) <= MESSAGER_CONTEXT_TOKENS);
  assert.ok(countTokens(JSON.stringify(withContext)) > CONVERSATION_TEXT_TOKENS);
  assert.equal(baseline.additionalContext, undefined);
});

test('image turns retain native image input alongside optional background', async () => {
  const imageUrl = 'data:image/png;base64,fixture';
  const message = { id: 'message:1', senderId: 'alice', text: '[Image]', channel: 'group',
    additionalContext: 'alice is learning photography', images: [{ id: 'image:1', load: async () => imageUrl }]
  };
  const input = await createConversationInput(message);
  assert.ok(Array.isArray(input));
  assert.equal(JSON.parse(input[0].content[0].text).additionalContext, message.additionalContext);
  assert.equal(input[0].content.at(-1).image_url, imageUrl);
});

test('each turn shares file background with filters and replier, and missing files preserve prompts', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { directory, context } = await fixture(t);
  const server = new ChatServer({ chats: [] }, directory);
  server.memory.load = async () => ({ notes: [], replies: [] });
  const updates = [];
  server.memory.update = async (_key, notes) => updates.push(notes);
  server.memory.recordReply = async () => {};
  const filters = [];
  const replies = [];
  const deliveries = [];
  const filter = new ModelFilter({ generate: async (input, instructions) => {
    filters.push({ input: JSON.parse(input), instructions });
    return 'optional';
  } });
  const replier = new ModelReplier({ generate: async (input, instructions) => {
    replies.push({ input: JSON.parse(input), instructions });
    return JSON.stringify({ reply: true, text: 'Hello!', memoryUpdates: { notes: [], forget: [] } });
  } });
  const chat = { name: 'chat-1', contextFile: context, filters: [filter], replier, replierModel: 'provider/model',
    messager: { name: 'wechat', reply: async (_message, reply) => deliveries.push(reply) }
  };
  const source = { id: 'message:1', senderId: 'wxid_alice', text: 'hello', channel: 'group' };
  const conversation = { chat, memoryKey: 'fixture', selfRevision: 0 };
  assert.equal(await server.handleMessage(conversation, source, 0), true);
  assert.equal(filters[0].input.additionalContext, undefined);
  assert.equal(replies[0].input.additionalContext, undefined);
  await assert.rejects(fs.stat(context.path), { code: 'ENOENT' });

  const background = 'Friend wxid_alice: Alice likes photography.\nGroup group: Weekend outings.';
  await fs.writeFile(context.path, background);
  assert.equal(await server.handleMessage(conversation, source, 0), true);
  assert.equal(filters[1].input.additionalContext, background);
  assert.equal(replies[1].input.additionalContext, background);
  assert.equal(replies[1].input.messages[0].id, source.id);
  await fs.writeFile(context.path, 'Updated background');
  assert.equal(await server.handleMessage(conversation, source, 0), true);
  assert.equal(replies[2].input.additionalContext, 'Updated background');
  await fs.unlink(context.path);
  assert.equal(await server.handleMessage(conversation, source, 0), true);
  assert.equal(filters[3].instructions, filters[0].instructions);
  assert.equal(replies[3].instructions, replies[0].instructions);
  assert.equal(replies[3].input.additionalContext, undefined);
  assert.equal(deliveries.length, 4);
  assert.ok(updates.every((value) => JSON.stringify(value) === '{"notes":[],"forget":[]}'));
});

test('context filename uses the configured messager name rather than its display name', async (t) => {
  const { directory } = await fixture(t);
  registerMessager('context-fixture', () => ({ name: 'Human readable name', start: () => {}, reply: () => {} }));
  const server = new ChatServer({ chats: [{ messager: { name: 'context-fixture', replier: 'provider/model' }, filters: [] }] }, directory);
  const chats = server.buildChats({ get: () => ({ generate: async () => '' }) });
  assert.equal(chats[0].contextFile.path, path.join(directory, 'context-fixture_context'));
  await assert.rejects(fs.stat(chats[0].contextFile.path), { code: 'ENOENT' });
});
