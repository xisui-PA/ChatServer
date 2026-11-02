const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { ConversationMemoryStore } = require('../src/conversations/memory-store');
const { countTokens } = require('../src/models/tokens');
const { createConversationInput } = require('../src/models/conversation-input');
const { ChatServer } = require('../src/server');
const { registerMessager } = require('../src/messagers/registry');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatserver-memory-limit-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function open(t, directory) {
  const store = new ConversationMemoryStore(directory);
  await store.start();
  t.after(() => store.close());
  return store;
}

async function populate(store, key, tokenLimit) {
  const messages = Array.from({ length: 10 }, (_, index) => ({
    id: `m:${index}`, senderId: 'alice', text: 'hello',
    timestamp: new Date(Date.now() - (10 - index) * 1000).toISOString()
  }));
  await store.update(key, { notes: messages.map((message, index) => ({
    kind: 'fact', text: `Note ${index}: ${'useful background '.repeat(90)}`, sourceIds: [message.id]
  })), forget: [] }, messages, tokenLimit);
}

test('messager memory limits are optional and validated per chat', async (t) => {
  const directory = await fixture(t);
  const chat = memoryTokenLimit => ({ messager: { name: 'wechat', replier: 'provider/model', memoryTokenLimit } });
  const write = limit => fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ chats: [chat(limit)] }));
  await write(undefined);
  assert.equal((await loadConfig(directory)).values.chats[0].messager.memoryTokenLimit, undefined);
  for (const limit of [100, 4000, 16000]) {
    await write(limit);
    assert.equal((await loadConfig(directory)).values.chats[0].messager.memoryTokenLimit, limit);
  }
  for (const limit of [null, '4000', 0, -1, 99, 16001, 1000.5]) {
    await write(limit);
    await assert.rejects(loadConfig(directory), /chats\[0\].messager.memoryTokenLimit must be an integer/);
  }
});

test('one store keeps independent memory limits for different conversations', async (t) => {
  const directory = await fixture(t);
  const store = await open(t, directory);
  await populate(store, 'large', 4000);
  await populate(store, 'default');
  const full = await store.load('large', 4000);
  const smaller = await store.load('default');
  assert.equal(full.notes.length, 10);
  assert.ok(countTokens(JSON.stringify(full)) > 1000);
  assert.ok(countTokens(JSON.stringify(full)) <= 4000);
  assert.ok(smaller.notes.length > 0 && smaller.notes.length < full.notes.length);
  assert.ok(countTokens(JSON.stringify(smaller)) <= 1000);
  assert.deepEqual(smaller.notes.map(note => note.text), full.notes.slice(-smaller.notes.length).map(note => note.text));
  await store.cleanup();
  assert.deepEqual(await store.load('large', 4000), full);
});

test('restart preserves unknown pipeline budgets and a lower limit applies on load and reply recording', async (t) => {
  const directory = await fixture(t);
  const original = await open(t, directory);
  await populate(original, 'conversation', 4000);
  const full = await original.load('conversation', 4000);
  await original.close();
  const smaller = await open(t, directory);
  const [existing] = await fs.readdir(path.join(directory, 'conversations'));
  const preserved = JSON.parse(await fs.readFile(path.join(directory, 'conversations', existing), 'utf8'));
  assert.deepEqual(preserved.notes, full.notes);
  const retained = await smaller.load('conversation', 700);
  assert.ok(retained.notes.length > 0 && retained.notes.length < full.notes.length);
  assert.deepEqual(retained.notes, full.notes.slice(-retained.notes.length));
  await smaller.recordReply('conversation', { text: 'A delivered answer. '.repeat(40), channel: 'alice', direct: true }, 700);
  const memory = await smaller.load('conversation', 700);
  assert.equal(memory.replies.length, 1);
  assert.ok(memory.notes.length < retained.notes.length);
  assert.ok(countTokens(JSON.stringify(memory)) <= 700);
  const files = await fs.readdir(path.join(directory, 'conversations'));
  assert.equal(files.length, 1);
  const { version, ...stored } = JSON.parse(await fs.readFile(path.join(directory, 'conversations', files[0]), 'utf8'));
  assert.equal(version, 1);
  assert.deepEqual(stored, memory);
});

test('load trims files replaced after startup and does not refresh note expiry', async (t) => {
  const directory = await fixture(t);
  const store = await open(t, directory);
  await populate(store, 'conversation', 4000);
  const full = await store.load('conversation', 4000);
  const smaller = await open(t, directory);
  const [filename] = await fs.readdir(path.join(directory, 'conversations'));
  await fs.writeFile(path.join(directory, 'conversations', filename), JSON.stringify({ version: 1, ...full }));
  const loaded = await smaller.load('conversation');
  assert.ok(countTokens(JSON.stringify(loaded)) <= 1000);
  assert.deepEqual(loaded.notes, full.notes.slice(-loaded.notes.length));
});

test('large memory has its own allowance and keeps the same recent-message snapshot', async (t) => {
  const directory = await fixture(t);
  const store = await open(t, directory);
  await populate(store, 'part:0', 16000);
  const part = await store.load('part:0', 16000);
  const memory = { notes: Array.from({ length: 4 }, () => part.notes).flat(), replies: [] };
  assert.ok(countTokens(JSON.stringify(memory)) > 8000);
  assert.ok(countTokens(JSON.stringify(memory)) < 16000);
  const message = { id: 'latest', senderId: 'alice', text: 'What did we discuss?',
    messages: Array.from({ length: 30 }, (_, index) => ({ id: `snapshot:${index}`, senderId: 'alice', text: 'recent message '.repeat(50) })) };
  const baseline = JSON.parse(await createConversationInput(message));
  const input = JSON.parse(await createConversationInput({ ...message, memory }));
  assert.deepEqual(input.messages, baseline.messages);
  assert.deepEqual(input.memory, memory);
  await assert.rejects(createConversationInput({ ...message, memory: { notes: Array(10).fill(part.notes).flat(), replies: [] } }), /memory input budget/);
});

test('server uses each pipeline budget for prompts, loading, updates, and confirmed replies', async (t) => {
  t.mock.method(console, 'log', () => {});
  const directory = await fixture(t);
  registerMessager('memory-fixture', () => ({ name: 'fixture', start() {}, reply() {} }));
  const limits = [undefined, 4000, 700];
  const server = new ChatServer({ chats: limits.map(memoryTokenLimit => ({
    messager: { name: 'memory-fixture', replier: 'provider/model', localTools: [], memoryTokenLimit }, filters: []
  })) }, directory);
  let prompt;
  const chats = server.buildChats({ get: () => ({ generate: async (_input, instructions) => {
    prompt = instructions;
    return '{"reply":true,"text":"Hello!","memoryUpdates":{"notes":[],"forget":[]}}';
  } }) });
  const calls = [];
  server.memory.load = async (key, limit) => { calls.push(['load', key, limit]); return { notes: [], replies: [] }; };
  server.memory.update = async (key, _updates, _messages, limit) => calls.push(['update', key, limit]);
  server.memory.recordReply = async (key, _reply, limit) => calls.push(['recordReply', key, limit]);
  server.deliverReply = async () => true;
  for (const [index, chat] of chats.entries()) {
    const limit = limits[index] ?? 1000;
    assert.equal(chat.memoryTokenLimit, limit);
    const key = `conversation:${index}`;
    const source = { id: 'm:1', senderId: 'alice', text: 'hello', channel: key };
    assert.equal(await server.handleMessage({ chat, memoryKey: key, selfRevision: 0 }, source, 0), true);
    assert.ok(prompt.includes(`budget of ${limit} tokens`));
    assert.deepEqual(calls.slice(-3), [['load', key, limit], ['update', key, limit], ['recordReply', key, limit]]);
  }
});
