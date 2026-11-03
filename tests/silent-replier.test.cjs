const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ChatServer } = require('../src/server');
const { ModelReplier } = require('../src/repliers/model');
const { FilterOutcome } = require('../src/filters/interface');

const emptyUpdates = { notes: [], forget: [] };
const noteText = 'Alice prefers tea.';
const silent = (memoryUpdates = emptyUpdates) => JSON.stringify({ reply: false, text: '', memoryUpdates });
const noteUpdates = { notes: [{ kind: 'fact', text: noteText, sourceIds: ['message:1'] }], forget: [] };
const source = id => ({ id: `message:${id}`, senderId: 'alice', channel: 'group',
  text: id === 1 ? 'I prefer tea.' : 'More context.', timestamp: new Date().toISOString() });

async function fixture(t, generate) {
  t.mock.method(console, 'log', () => {});
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatserver-silent-replier-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const server = new ChatServer({ chats: [] }, directory);
  await server.memory.start();
  t.after(() => server.close());
  server.startProcessing = () => {};
  const inputs = [];
  const chat = {
    name: 'fixture', memoryTokenLimit: 1000, filters: [], replierModel: 'chat/model',
    replier: new ModelReplier({ generate: async input => {
      inputs.push(JSON.parse(input));
      return generate ? generate(inputs.at(-1)) : silent();
    } }),
    messager: { name: 'fixture', reply: async () => assert.fail('silent reply was sent') }
  };
  const process = async () => {
    server.replySlotReady = true;
    await server.processConversations();
  };
  return { server, chat, inputs, process, directory };
}

for (const saveNote of [true, false]) {
  test(`replier silence clears processed messages ${saveNote ? 'and persists notes' : 'even without notes'}`, async t => {
    const f = await fixture(t, input => silent(saveNote && input.messages[0].id === 'message:1' ? noteUpdates : emptyUpdates));
    await f.server.receiveMessage(f.chat, source(1));
    await f.process();
    assert.equal(f.server.conversations.size, 0);
    assert.equal(f.server.pending.size, 0);
    assert.equal(f.server.deliveries, 0);
    if (saveNote) {
      const [filename] = await fs.readdir(path.join(f.directory, 'conversations'));
      const memory = JSON.parse(await fs.readFile(path.join(f.directory, 'conversations', filename), 'utf8'));
      assert.equal(memory.notes[0].text, noteText);
      assert.deepEqual(memory.replies, []);
    }
    await f.server.receiveMessage(f.chat, source(2));
    await f.process();
    assert.deepEqual(f.inputs[1].messages.map(message => message.id), ['message:2']);
    if (saveNote) {
      assert.equal(f.inputs[1].memory.notes[0].text, noteText);
    }
  });
}

test('filter denial retains messages until the replier processes them', async t => {
  const f = await fixture(t, () => silent(noteUpdates));
  const filtered = [];
  f.chat.filters = [{ name: 'model', shouldReply: message => {
    filtered.push(message);
    return filtered.length === 1 ? FilterOutcome.Denied : FilterOutcome.Optional;
  } }];
  await f.server.receiveMessage(f.chat, source(1));
  await f.process();
  assert.equal(f.inputs.length, 0);
  assert.equal([...f.server.conversations.values()][0].messages.length, 1);
  assert.deepEqual(await fs.readdir(path.join(f.directory, 'conversations')), []);
  await f.server.receiveMessage(f.chat, source(2));
  await f.process();
  assert.deepEqual(f.inputs[0].messages.map(message => message.id), ['message:1', 'message:2']);
  assert.equal(f.server.conversations.size, 0);
});

test('messages arriving during a silent turn are processed separately with updated memory', async t => {
  const f = await fixture(t, async () => {
    if (f.inputs.length === 1) {
      await f.server.receiveMessage(f.chat, source(2));
      return silent(noteUpdates);
    }
    return silent();
  });
  await f.server.receiveMessage(f.chat, source(1));
  await f.process();
  assert.deepEqual(f.inputs.map(input => input.messages.map(message => message.id)), [['message:1'], ['message:2']]);
  assert.equal(f.inputs[1].memory.notes[0].text, noteText);
  assert.equal(f.server.conversations.size, 0);
  assert.equal(f.server.pending.size, 0);
});
