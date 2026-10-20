const assert = require('node:assert/strict');
const { test } = require('node:test');
const { WechatMessagerAdapter } = require('../src/messagers/wechat');
const { ChatServer } = require('../src/server');
const { ModelFilter } = require('../src/filters/model');
const { IgnoreSenderFilter } = require('../src/filters/ignore-sender');
const { ModelReplier } = require('../src/repliers/model');
const { VoiceTranscriber } = require('../src/models/voice-transcriber');
const { createConversationInput } = require('../src/models/conversation-input');
const { countTokens } = require('../src/models/tokens');
const { SENDER_NAME_TOKENS } = require('../src/limit');

test('WeChat polling preserves per-message display names without merging different wxids', async (t) => {
  const received = [];
  const adapter = new WechatMessagerAdapter('fixture-token');
  adapter.account = 'wxid_bot';
  adapter.handler = message => received.push(message);
  const rows = [
    { sender: 'wxid_alice', senderName: ' Alice ' },
    { sender: 'wxid_alice', senderName: 'Alice updated' },
    { sender: 'wxid_bob', senderName: 'Alice updated' },
    { sender: 'wxid_bot', senderName: ' My Bot ', isSelf: true },
    { sender: 'wxid_missing', senderName: null },
    { sender: 'wxid_missing', senderName: ' \t ' }
  ].map((row, index) => ({ localId: index + 1, timestamp: new Date(1000 * (index + 1)).toISOString(),
    type: 1, content: 'Hello', isSelf: false, ...row }));
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(rows.slice().reverse())));
  await adapter.pollChat('group@chatroom', { timestamp: 0, ids: new Set() });
  assert.equal(fetch.mock.callCount(), 1, 'names must come from the message response without extra contact requests');
  assert.equal(received.length, 4);
  assert.equal(received[0].senderId, 'wxid_alice');
  assert.equal(received[0].senderName, 'Alice updated');
  assert.deepEqual(received[0].messages.map(message => message.senderName), ['Alice', 'Alice updated']);
  assert.equal(received[1].senderId, 'wxid_bob');
  assert.equal(received[1].senderName, 'Alice updated');
  assert.equal(received[2].senderId, 'wxid_bot');
  assert.equal(received[2].senderName, 'My Bot');
  assert.equal(received[2].isSelf, true);
  assert.ok(received[3].messages.every(message => message.senderName === undefined));
});

test('the serial queue carries display names and stable IDs into both model stages', async (t) => {
  t.mock.method(console, 'log', () => {});
  const server = new ChatServer({ chats: [] }, '/unused-sender-name-fixture');
  server.startProcessing = () => {};
  server.replySlotReady = true;
  server.memory.load = async () => ({ notes: [], replies: [] });
  server.memory.update = async () => {};
  server.memory.recordReply = async () => {};
  const requests = [];
  const model = result => ({ generate: async (input, instructions) => {
    requests.push({ input: JSON.parse(input), instructions });
    return result;
  } });
  const deliveries = [];
  const chat = { name: 'fixture', replierModel: 'provider/model', filters: [new ModelFilter(model('optional'))],
    messager: { name: 'wechat', reply: async (_message, reply) => deliveries.push(reply) },
    replier: new ModelReplier(model('{"reply":true,"text":"Hello, Alice!","memoryUpdates":{"notes":[],"forget":[]}}')) };
  await server.receiveMessage(chat, { id: 'm:1', channel: 'group', senderId: 'wxid_alice', senderName: 'Alice', text: 'Hello' });
  await server.receiveMessage(chat, { id: 'm:2', channel: 'group', senderId: 'wxid_bob', senderName: 'Alice', text: 'Me too' });
  await server.receiveMessage(chat, { id: 'm:3', channel: 'group', senderId: 'wxid_unknown', text: 'Hi' });
  await server.processConversations();
  assert.equal(requests.length, 2);
  for (const { input } of requests) {
    assert.deepEqual(input.messages.map(({ senderId, senderName }) => [senderId, senderName]), [
      ['wxid_alice', 'Alice'], ['wxid_bob', 'Alice'], ['wxid_unknown', undefined]
    ]);
  }
  assert.match(requests[0].instructions, /senderId identifies the speaker/);
  assert.match(requests[1].instructions, /Prefer senderName/);
  assert.equal(deliveries[0].text, 'Hello, Alice!');
  assert.equal(deliveries[0].channel, 'group');
});

test('display names remain bounded and accompany voice transcripts and image source labels', async (t) => {
  t.mock.method(console, 'log', () => {});
  const name = '摄影爱好者 🧑🏿‍💻 '.repeat(500);
  const image = { id: 'image:1', load: async () => 'data:image/png;base64,fixture' };
  const source = { id: 'm:1', senderId: 'wxid_alice', senderName: name, text: '[Voice]', images: [image],
    audio: { id: 'voice:1', load: async () => ({ status: 'ready', audio: { data: Buffer.from('ID3fixture'),
      filename: 'voice.mp3', mimeType: 'audio/mpeg' } }) } };
  const [transcribed] = await new VoiceTranscriber({ transcribe: async () => 'Hello there' }, 'speech/model').transcribe([source]);
  assert.equal(transcribed.senderId, source.senderId);
  assert.equal(transcribed.senderName, name);
  const input = await createConversationInput(transcribed);
  const parts = input[0].content;
  const snapshot = JSON.parse(parts[0].text).messages[0];
  assert.equal(snapshot.senderId, 'wxid_alice');
  assert.ok(countTokens(snapshot.senderName) <= SENDER_NAME_TOKENS);
  assert.match(snapshot.senderName, /\[truncated\]$/);
  assert.match(snapshot.text, /Voice transcription/);
  const label = JSON.parse(parts[1].text);
  assert.equal(label.senderId, 'wxid_alice');
  assert.equal(label.senderName, snapshot.senderName);
  const unnamed = JSON.parse(await createConversationInput({ id: 'm:2', senderId: 'wxid_bob', senderName: ' ', text: 'Hi' }));
  assert.equal(unnamed.messages[0].senderId, 'wxid_bob');
  assert.ok(!Object.hasOwn(unnamed.messages[0], 'senderName'));
});

test('display names cannot bypass sender exclusions or controller authorization and delivery uses wxid', async (t) => {
  const owner = 'wxid_owner';
  const outsider = { id: 'm:1', senderId: 'wxid_outsider', senderName: owner, channel: 'wxid_outsider', text: '/status' };
  const controller = { id: 'm:2', senderId: owner, senderName: 'New display name', channel: owner, text: '/status' };
  const filter = new IgnoreSenderFilter([owner]);
  assert.deepEqual(await filter.selectMessages([outsider, controller]), [outsider]);
  const server = new ChatServer({ chats: [] }, '/unused-sender-name-fixture');
  server.startProcessing = () => {};
  const chat = { name: 'fixture', mainAccount: owner, messager: { name: 'wechat' }, filters: [] };
  await server.receiveMessage(chat, outsider);
  assert.equal(server.pending.size, 0);
  await server.receiveMessage(chat, controller);
  assert.equal(server.pending.size, 1);
  const sent = [];
  server.deliverReply = async (_chat, message) => { sent.push(message); return true; };
  await server.handleStatus(chat, outsider);
  assert.equal(sent.length, 0);
  await server.handleStatus(chat, controller);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].senderId, owner);

  const adapter = new WechatMessagerAdapter('fixture-token');
  adapter.account = 'wxid_bot';
  adapter.handler = () => {};
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response('{"success":true}');
  });
  await adapter.reply({ ...controller, metadata: { wechatAccount: 'wxid_bot' } }, { text: 'hello', direct: true });
  assert.equal(requests[0].chatId, owner);
});
