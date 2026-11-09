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

/**
 * Dispatches one live committed message exactly as the SSE stream loop does: the event
 * carries only IDs, and the adapter reads the row from the exact message route.
 */
async function deliverLive(adapter, row, cursor) {
  adapter.startedAt = 0;
  await adapter.handleEvent({ cursor, kind: 'message.committed',
    data: { messageId: row.id, threadId: row.threadId } });
}

/** Delivers rows one live event at a time, in the given order. */
async function deliverAll(adapter, rows) {
  let cursor = 100;
  for (const row of rows) {
    cursor += 1;
    await deliverLive(adapter, row, String(cursor));
  }
}

/** Native member payload fields used by the adapter; other fields are ignored. */
const groupMember = (username, member, state = 'present') => ({
  groupId: 'group@chatroom', username, state, member, coverage: 'cached'
});

test('WeChat group message events prefer room display names and fall through to lower names', async (t) => {
  const received = [];
  const adapter = new WechatMessagerAdapter('fixture-token');
  adapter.account = 'acct-1';
  adapter.selfUsername = 'wxid_bot';
  adapter.handler = message => received.push(message);
  const rows = [
    'wxid_alice', 'wxid_alice', 'wxid_bob', 'wxid_carol', 'wxid_dave', 'wxid_erin',
    'wxid_frank', 'wxid_grace', null
  ].map((senderId, index) => ({ id: `m-${index + 1}`, accountId: 'acct-1',
    threadId: 'group@chatroom', senderId, type: 1,
    direction: senderId === null ? 'outgoing' : 'incoming', body: 'Hello',
    createdAt: new Date(1000 * (index + 1)).toISOString() }));
  // `member.displayName` is the label upstream already resolved from remark/nickname, so a
  // group sender never needs a contact read when that label exists.
  const members = {
    wxid_alice: groupMember('wxid_alice', { id: 'wxid_alice', username: 'wxid_alice',
      displayName: 'Alice label', roomDisplayName: '  Alice room  ' }),
    wxid_bob: groupMember('wxid_bob', { id: 'wxid_bob', username: 'wxid_bob',
      displayName: ' Bob label ', roomDisplayName: '   ' }),
    wxid_carol: groupMember('wxid_carol', { id: 'wxid_carol', username: 'wxid_carol',
      displayName: '  ', roomDisplayName: null }),
    wxid_dave: groupMember('wxid_dave', null, 'unconfirmed'),
    wxid_frank: groupMember('wxid_frank', { id: 'wxid_frank', username: 'wxid_frank',
      displayName: null, roomDisplayName: null }),
    wxid_grace: groupMember('wxid_grace', { id: 'wxid_grace', username: 'wxid_grace',
      displayName: ' ', roomDisplayName: '  ' }),
    wxid_bot: groupMember('wxid_bot', { id: 'wxid_bot', username: 'wxid_bot',
      displayName: 'Bot label', roomDisplayName: 'Bot room' })
  };
  const contacts = {
    wxid_alice: { displayName: 'Alice contact' },
    wxid_bob: { displayName: 'Bob contact' },
    wxid_carol: { displayName: ' Carol contact ' },
    // Upstream tests its label fields for emptiness without trimming, so a whitespace
    // remark can mask a real nickname; the nickname still supplies the contact name.
    wxid_dave: { remark: ' ', displayName: '   ', nickname: ' Dave nickname ' },
    wxid_erin: { displayName: 'Erin contact' },
    wxid_grace: { remark: '', displayName: '', nickname: 'Grace nickname' }
  };
  const urls = [];
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const byId = new Map(rows.map((row) => [row.id, row]));
  t.mock.method(globalThis, 'fetch', async (url) => {
    const target = String(url);
    urls.push(target);
    if (target.includes('/messages/')) {
      const id = decodeURIComponent(target.split('/messages/')[1]);
      return new Response(JSON.stringify(byId.get(id)));
    }
    const username = target.split('/').at(-1);
    if (target.includes('/members/')) {
      if (username === 'wxid_erin') {
        return new Response('{}', { status: 500 });
      }
      return new Response(JSON.stringify(members[username]));
    }
    if (username === 'wxid_frank') {
      return new Response('{}', { status: 404 });
    }
    return new Response(JSON.stringify(contacts[username]));
  });
  await deliverAll(adapter, rows);
  assert.equal(urls.filter(url => url.includes('/messages/')).length, rows.length,
    'every live event reads its exact message row');
  assert.equal(urls.filter(url => url.includes('/members/')).length, 8,
    'one cached lookup per distinct sender; the second alice event reuses the cache');
  assert.equal(urls.filter(url => url.includes('/contacts/')).length, 5,
    'absent, unconfirmed, blank, or failed room names fall back to the contact route');
  assert.deepEqual(received.map(message => [message.senderId, message.senderName, message.isSelf]), [
    ['wxid_alice', 'Alice room', false],
    ['wxid_alice', 'Alice room', false],
    ['wxid_bob', 'Bob label', false],
    ['wxid_carol', 'Carol contact', false],
    ['wxid_dave', 'Dave nickname', false],
    ['wxid_erin', 'Erin contact', false],
    ['wxid_frank', undefined, false],
    ['wxid_grace', 'Grace nickname', false],
    ['wxid_bot', 'Bot room', true]
  ]);
  // Live events arrive one per turn, so each carries exactly its own source message.
  assert.deepEqual(received[0].messages.map(message => [message.id, message.senderId, message.senderName]),
    [['message:m-1', 'wxid_alice', 'Alice room']]);
  assert.deepEqual(received[1].messages.map(message => [message.id, message.senderId, message.senderName]),
    [['message:m-2', 'wxid_alice', 'Alice room']]);
  assert.equal(urls.filter(url => url.endsWith('/contacts/wxid_alice')).length, 0,
    'the room nickname and resolved member label need no contact read');
  assert.equal(urls.filter(url => url.endsWith('/contacts/wxid_bob')).length, 0,
    'the member label already carries friend remark over nickname');
  assert.equal(urls.filter(url => url.endsWith('/contacts/wxid_bot')).length, 0,
    'self messages resolve the account room nickname under the same precedence');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /group member name lookup failed for wxid_erin/);
  // A cached name needs no new request.
  assert.equal(await adapter.displayName('group@chatroom', 'wxid_alice'), 'Alice room');
  assert.equal(urls.filter(url => url.includes('/members/')).length, 8);
  // A whitespace-masked label still surfaces the nickname, and the wxid is untouched.
  assert.equal(received[4].senderId, 'wxid_dave');
  // The resolved name reaches the serialized model snapshot; the speaker ID is unchanged.
  const snapshot = JSON.parse(await createConversationInput(received[0]));
  assert.equal(snapshot.channel, 'group@chatroom');
  assert.deepEqual(snapshot.messages.map(({ senderId, senderName }) => [senderId, senderName]),
    [['wxid_alice', 'Alice room']]);
});

test('direct chats use the resolved contact label and never read group members', async (t) => {
  const adapter = new WechatMessagerAdapter('fixture-token');
  adapter.account = 'acct-1';
  adapter.selfUsername = 'wxid_bot';
  adapter.handler = () => {};
  const contacts = {
    wxid_remark: { remark: ' Friend remark ', displayName: 'Friend label', nickname: 'Global nickname' },
    wxid_known: { displayName: ' Friend label ', nickname: 'Global nickname' },
    wxid_masked: { remark: ' ', displayName: '   ', nickname: ' Global nickname ' },
    wxid_blank: { remark: '', displayName: ' ', nickname: null }
  };
  const urls = [];
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  t.mock.method(globalThis, 'fetch', async (url) => {
    const target = String(url);
    urls.push(target);
    const username = target.split('/').at(-1);
    if (username === 'wxid_failed') {
      return new Response('{}', { status: 500 });
    }
    return new Response(JSON.stringify(contacts[username]));
  });
  assert.equal(await adapter.displayName('wxid_remark', 'wxid_remark'), 'Friend remark',
    'a friend remark outranks the label and the nickname');
  assert.equal(await adapter.displayName('wxid_known', 'wxid_known'), 'Friend label');
  assert.equal(await adapter.displayName('wxid_masked', 'wxid_masked'), 'Global nickname',
    'a whitespace-only label still yields the global nickname');
  assert.equal(await adapter.displayName('wxid_blank', 'wxid_blank'), undefined,
    'blank names resolve to no name instead of a blank value');
  assert.equal(await adapter.displayName('wxid_failed', 'wxid_failed'), undefined,
    'a failed contact read never throws into message delivery');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /contact name lookup failed for wxid_failed/);
  assert.deepEqual(urls.map(url => url.split('/v1/accounts/acct-1')[1]), [
    '/contacts/wxid_remark', '/contacts/wxid_known', '/contacts/wxid_masked',
    '/contacts/wxid_blank', '/contacts/wxid_failed'
  ]);
  assert.equal(urls.some(url => url.includes('/groups/')), false,
    'direct chats never read group members');
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
  adapter.account = 'acct-1';
  adapter.selfUsername = 'wxid_bot';
  adapter.handler = () => {};
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body), headers: options.headers });
    return new Response(JSON.stringify({ id: 'send-1', accountId: 'acct-1', destination: owner,
      state: 'accepted', errorCode: null, createdAt: new Date().toISOString() }));
  });
  await adapter.reply({ ...controller, metadata: { wechatAccount: 'acct-1', wechatUsername: 'wxid_bot' } },
    { text: 'hello', direct: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/accounts\/acct-1\/sends$/);
  assert.deepEqual(calls[0].body, { threadId: owner, text: 'hello' });
  assert.match(calls[0].headers['Idempotency-Key'], /^[0-9a-f-]{36}$/);
  // A reply from a superseded WeChat identity on the same daemon account is fenced off.
  await assert.rejects(adapter.reply({ ...controller,
    metadata: { wechatAccount: 'acct-1', wechatUsername: 'wxid_old' } }, { text: 'hello', direct: true }),
  /account has changed/);
  assert.equal(calls.length, 1);
});
