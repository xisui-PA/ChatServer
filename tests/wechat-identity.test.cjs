const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ChatServer } = require('../src/server');

/** Minimal stored note; only its text matters to these fixtures. */
const storedNote = (text) => ({
  id: `note:${text}`, kind: 'fact', text,
  sourceTimestamp: new Date(1000).toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString()
});

/**
 * A native WeChat bundle: the daemon account is a profile, so the signed-in username is
 * the narrower identity. A message without a username models legacy persisted data.
 */
const wechatMessage = (id, text, senderId, username, thread = 'group@chatroom') => ({
  id,
  text,
  senderId,
  senderName: `${senderId} display`,
  isSelf: false,
  channel: thread,
  timestamp: new Date(1000).toISOString(),
  metadata: username === undefined
    ? { wechatAccount: 'acct-1' }
    : { wechatAccount: 'acct-1', wechatUsername: username }
});

/**
 * A server whose worker stays stopped, plus recording memory/image stores and a replier
 * that reports what each model turn received and remembers one note per turn.
 */
function fixture(messagerName = 'wechat') {
  const server = new ChatServer({ chats: [] }, '/unused-wechat-identity-fixture');
  server.startProcessing = () => {};
  server.replySlotReady = true;
  const memoryLoads = [];
  const memoryUpdates = [];
  const notes = new Map();
  server.memory.load = async (key) => {
    memoryLoads.push(key);
    return { notes: (notes.get(key) ?? []).map(storedNote), replies: [] };
  };
  server.memory.update = async (key, updates) => {
    memoryUpdates.push(key);
    notes.set(key, [...(notes.get(key) ?? []), ...updates.notes.map((update) => update.text)]);
  };
  server.memory.recordReply = async () => {};
  const imageLists = [];
  const imageSaves = [];
  const images = new Map();
  let generated = 0;
  server.images.forConversation = (key) => {
    imageLists.push(key);
    return {
      list: async () => images.get(key) ?? [],
      get: async (id) => (images.get(key) ?? []).find((image) => image.id === id),
      save: async () => {}
    };
  };
  server.images.saveGenerated = async (key, files) => {
    imageSaves.push(key);
    const cached = images.get(key) ?? [];
    const ids = files.map(() => {
      const id = `generated-image:${++generated}`;
      cached.push({
        id, messageId: id, senderId: 'assistant', senderName: 'Assistant', origin: 'generated',
        deliveryStatus: 'pending', timestamp: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      });
      return id;
    });
    images.set(key, cached);
    return ids;
  };
  const turns = [];
  const chat = {
    name: 'chat-1',
    replierModel: 'provider/model',
    filters: [],
    memoryTokenLimit: 1000,
    imageLookupEnabled: true,
    messager: { name: messagerName, reply: async () => {} },
    replier: {
      replyTo: async (message) => {
        turns.push({
          text: message.text,
          account: message.metadata?.wechatAccount,
          username: message.metadata?.wechatUsername,
          memory: (message.memory?.notes ?? []).map((note) => note.text),
          images: (await message.imageAccess?.list() ?? []).map((image) => image.id)
        });
        await message.onGeneratedImages?.([{
          data: Buffer.from('generated'), filename: 'generated.png', mimeType: 'image/png'
        }]);
        return {
          memoryUpdates: {
            notes: [{ kind: 'fact', text: `saw ${message.id}`, sourceIds: [message.id] }],
            forget: []
          }
        };
      }
    }
  };
  return { server, chat, turns, memoryLoads, memoryUpdates, imageLists, imageSaves };
}

test('another signed-in username on one daemon account gets its own queue and storage', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { server, chat, turns, memoryLoads, imageLists, imageSaves } = fixture();
  await server.receiveMessage(chat, wechatMessage('message:1', 'secret from alice', 'wxid_alice', 'wxid_login_a'));
  assert.equal(server.conversations.size, 1);
  await server.receiveMessage(chat, wechatMessage('message:2', 'hello from bob', 'wxid_bob', 'wxid_login_b'));
  assert.equal(server.conversations.size, 2,
    'the same daemon account and thread under another username is a separate conversation');
  assert.equal(server.pending.size, 2, 'each signed-in username has its own queued turn');
  assert.deepEqual([...server.conversations.values()]
    .map((conversation) => conversation.messages.map((entry) => entry.message.text)).sort(),
  [['hello from bob'], ['secret from alice']]);

  await server.processConversations();
  assert.equal(turns.length, 2);
  const alice = turns.find((turn) => turn.username === 'wxid_login_a');
  const bob = turns.find((turn) => turn.username === 'wxid_login_b');
  assert.ok(alice !== undefined && bob !== undefined);
  assert.equal(alice.account, 'acct-1');
  assert.equal(bob.account, 'acct-1');
  assert.match(alice.text, /secret from alice/);
  assert.doesNotMatch(alice.text, /hello from bob/);
  assert.match(bob.text, /hello from bob/);
  assert.doesNotMatch(bob.text, /secret from alice/, 'B never sees the previous login text');
  assert.deepEqual(bob.memory, [], 'B never loads the previous login memory');
  assert.deepEqual(alice.memory, []);
  assert.deepEqual(turns.map((turn) => turn.images), [[], []],
    'a generated image cached for one login is invisible to the other');
  assert.equal(new Set(memoryLoads).size, 2, 'memory storage namespaces are per signed-in username');
  assert.equal(new Set(imageLists).size, 2, 'cached image access is namespaced per signed-in username');
  assert.equal(new Set(imageSaves).size, 2, 'generated image writes are namespaced per signed-in username');
  assert.deepEqual([...imageLists].sort(), [...memoryLoads].sort(),
    'memory and images of one turn share the same identity scope');
});

test('pending sources recorded without a username never enter a named login snapshot', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { server, chat, turns, memoryLoads } = fixture();
  // A legacy bundle predates metadata.wechatUsername; it must not be adopted by a login.
  await server.receiveMessage(chat, wechatMessage('message:1', 'legacy secret', 'wxid_alice', undefined));
  await server.processConversations();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].username, undefined);

  server.replySlotReady = true;
  await server.receiveMessage(chat, wechatMessage('message:2', 'new login hello', 'wxid_bob', 'wxid_login_b'));
  assert.equal(server.conversations.size, 1);
  await server.processConversations();
  assert.equal(turns.length, 2);
  const named = turns[1];
  assert.equal(named.username, 'wxid_login_b');
  assert.match(named.text, /new login hello/);
  assert.doesNotMatch(named.text, /legacy secret/, 'legacy pending context cannot enter the new snapshot');
  assert.deepEqual(named.memory, [], 'legacy persisted memory is not loaded into the named login');
  assert.deepEqual(named.images, [], 'legacy cached images are not visible to the named login');
  assert.notEqual(memoryLoads[1], memoryLoads[0]);
});

test('the same signed-in username keeps one conversation and one remembered context', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { server, chat, turns, memoryLoads } = fixture();
  await server.receiveMessage(chat, wechatMessage('message:1', 'first', 'wxid_alice', 'wxid_login_a'));
  await server.receiveMessage(chat, wechatMessage('message:2', 'second', 'wxid_bob', 'wxid_login_a'));
  assert.equal(server.conversations.size, 1, 'one login keeps one conversation');
  assert.equal(server.pending.size, 1, 'and one queued turn');
  await server.processConversations();
  assert.equal(turns.length, 1);
  assert.match(turns[0].text, /first/);
  assert.match(turns[0].text, /second/);
  assert.equal(new Set(memoryLoads).size, 1, 'the same login keeps one memory namespace');
});

test('transports without a WeChat identity keep their existing conversation and memory keys', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { server, chat, memoryLoads } = fixture('stdin');
  await server.receiveMessage(chat, {
    id: 'message:1', channel: 'room', senderId: 'local-user', text: 'hello from stdin',
    metadata: { remoteAddress: '127.0.0.1' }
  });
  assert.deepEqual([...server.conversations.keys()], [JSON.stringify(['chat-1', null, 'room'])],
    'a non-WeChat transport keeps the transport-neutral conversation key');

  // The same chat and thread under a signed-in WeChat identity is a different scope.
  await server.receiveMessage(chat, wechatMessage('message:2', 'hello from wechat', 'wxid_alice',
    'wxid_login_a', 'room'));
  assert.equal(server.conversations.size, 2,
    'a WeChat identity never joins a transport-neutral conversation');

  await server.processConversations();
  assert.equal(memoryLoads[0], JSON.stringify(['stdin', 'chat-1', 'room']),
    'the non-WeChat turn keeps the transport-neutral memory namespace');
  assert.equal(memoryLoads.length, 2);
  assert.notEqual(memoryLoads[1], memoryLoads[0],
    'a WeChat identity never shares a namespace with a transport-neutral conversation');
});

test('identity strings scope namespaces verbatim, matching the adapter equality check', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { server, chat, memoryLoads } = fixture();
  const identityMessage = (id, text, senderId, account, username) => ({
    ...wechatMessage(id, text, senderId, username),
    metadata: { wechatAccount: account, wechatUsername: username }
  });
  await server.receiveMessage(chat, identityMessage('message:1', 'one', 'wxid_alice', 'acct-1', 'wxid_login'));
  await server.receiveMessage(chat, identityMessage('message:2', 'two', 'wxid_bob', ' acct-1', 'wxid_login'));
  await server.receiveMessage(chat, identityMessage('message:3', 'three', 'wxid_carol', 'acct-1', 'wxid_login '));
  assert.equal(server.conversations.size, 3,
    'surrounding whitespace is part of an opaque identity and never merges two scopes');
  await server.processConversations();
  assert.equal(new Set(memoryLoads).size, 3);
  assert.ok(memoryLoads.includes(JSON.stringify(['wechat', 'acct-1', 'wxid_login', 'group@chatroom'])),
    'the reported identity strings are stored unmodified');
  assert.ok(memoryLoads.includes(JSON.stringify(['wechat', ' acct-1', 'wxid_login', 'group@chatroom'])));
  assert.ok(memoryLoads.includes(JSON.stringify(['wechat', 'acct-1', 'wxid_login ', 'group@chatroom'])));
});
