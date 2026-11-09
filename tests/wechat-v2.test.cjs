const assert = require('node:assert/strict');
const { test } = require('node:test');
const { WechatMessagerAdapter } = require('../src/messagers/wechat');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');
const encoder = new TextEncoder();
const account = (id, authenticated, ownUsername = `self-${id}`) => ({ id, authenticated,
  ...(ownUsername === undefined ? {} : { ownUsername }), connection: authenticated ? 'online' : 'disconnected' });
const message = { id: 'message:m-1', senderId: 'wxid_alice', channel: 'wxid_alice', text: 'Hello',
  timestamp: '2026-10-19T10:00:00Z',
  metadata: { wechatAccount: 'acct-1', wechatUsername: 'wxid_bot' } };
const intent = (state, extra = {}) => ({ id: 'send-1', accountId: 'acct-1', destination: 'wxid_alice',
  state, errorCode: null, createdAt: new Date().toISOString(), ...extra });
const send = (adapter) => {
  adapter.account = 'acct-1';
  adapter.selfUsername = 'wxid_bot';
  adapter.handler = () => {};
  return adapter;
};

const json = (value, status = 200) => new Response(JSON.stringify(value), { status,
  headers: { 'Content-Type': 'application/json' } });
const native = (id, overrides = {}) => ({ id, accountId: 'acct-1', threadId: 'wxid_alice',
  senderId: 'wxid_alice', type: 1, direction: 'incoming', body: id,
  createdAt: new Date().toISOString(), ...overrides });
const frame = (cursor, kind, data, extra = {}) => `id: ${cursor}\ndata: ${JSON.stringify({
  cursor, kind, data, createdAt: new Date().toISOString(), ...extra })}\n\n`;

/** A mock SSE response whose body can be fed incrementally and honors abort. */
function streamResponse(signal) {
  let controller;
  const body = new ReadableStream({
    start(value) { controller = value; },
    cancel() {}
  });
  signal?.addEventListener('abort', () => {
    try { controller.error(new Error('stream aborted')); } catch { /* already closed */ }
  }, { once: true });
  return {
    response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    push(value) { try { controller.enqueue(encoder.encode(value)); } catch { /* closed */ } },
    pushBytes(value) { try { controller.enqueue(value); } catch { /* closed */ } },
    close() { try { controller.close(); } catch { /* closed */ } }
  };
}

async function waitFor(predicate, label, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('startup uses one authenticated account, rejects ambiguity, and accepts an explicit account ID', async (t) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    return json({ items: [account('acct-1', true), account('acct-2', true),
      account('acct-3', false)] });
  });
  const ambiguous = new WechatMessagerAdapter('token');
  await assert.rejects(ambiguous.start(() => {}), /2 authenticated accounts \(acct-1, acct-2\)/);
  assert.equal(ambiguous.getStatus().active, false);

  t.mock.method(globalThis, 'fetch', async () => json({ items: [account('acct-3', false)] }));
  await assert.rejects(new WechatMessagerAdapter('token').start(() => {}), /no authenticated account/);

  const singleUrls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    singleUrls.push(String(url));
    if (url.endsWith('/v1/accounts')) {
      return json({ items: [account('acct-3', false), account('acct-1', true, 'wxid_bot')] });
    }
    if (url.includes('/threads?')) {
      return json({ items: [], nextCursor: null, asOfEventCursor: '0' });
    }
    if (url.includes('/events/stream')) {
      return streamResponse(options.signal).response;
    }
    throw new Error(`unexpected request ${url}`);
  });
  const single = new WechatMessagerAdapter('token');
  t.after(() => single.stop());
  await single.start(() => {});
  await waitFor(() => singleUrls.some((url) => url.includes('/events/stream')), 'initial stream');
  assert.equal(single.account, 'acct-1');
  assert.equal(single.selfUsername, 'wxid_bot');
  assert.equal(singleUrls[0], 'http://127.0.0.1:6174/v1/accounts');

  const explicitUrls = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    explicitUrls.push(String(url));
    if (url.endsWith('/v1/accounts/acct-9')) {
      return json(account('acct-9', true, 'wxid_self'));
    }
    if (url.includes('/threads?')) {
      return json({ items: [], nextCursor: null, asOfEventCursor: '0' });
    }
    if (url.includes('/events/stream')) {
      return streamResponse(options.signal).response;
    }
    throw new Error(`unexpected request ${url}`);
  });
  // A `/v1` suffix is accepted without producing a duplicated path segment.
  const explicit = new WechatMessagerAdapter('token', { accountId: 'acct-9', baseUrl: 'http://127.0.0.1:6174/v1/' });
  t.after(() => explicit.stop());
  await explicit.start(() => {});
  await waitFor(() => explicitUrls.some((url) => url.includes('/events/stream')), 'explicit stream');
  assert.equal(explicit.account, 'acct-9');
  assert.equal(explicitUrls[0], 'http://127.0.0.1:6174/v1/accounts/acct-9');
  assert.ok(explicitUrls.every((url) => !url.includes('/v1/v1')));

  t.mock.method(globalThis, 'fetch', async () => json(account('acct-9', false)));
  await assert.rejects(new WechatMessagerAdapter('token', { accountId: 'acct-9' }).start(() => {}),
    /not authenticated/);
});

test('the event stream parses split UTF-8, CRLF, multiline frames, comments, and filtered threads', async (t) => {
  const received = [];
  const requests = [];
  let stream;
  let streamUrl;
  let streamOptions;
  const old = new Date(Date.now() - 60_000).toISOString();
  const thread = { id: 'wxid_alice', lastMessage: { id: 'old', createdAt: old },
    unreadCount: 0, readStateVersion: 'r1' };
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    requests.push(String(url));
    if (url.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1', true, 'wxid_bot'));
    }
    if (url.includes('/threads?')) {
      return json({ items: [thread], nextCursor: null, asOfEventCursor: '100' });
    }
    if (url.includes('/events/stream')) {
      streamUrl = String(url);
      streamOptions = options;
      stream = streamResponse(options.signal);
      return stream.response;
    }
    if (url.endsWith('/messages/m-1')) {
      return json(native('m-1', { body: 'One' }));
    }
    if (url.endsWith('/messages/m-2')) {
      return json(native('m-2', { type: 3, body: null }));
    }
    if (url.endsWith('/messages/m-3')) {
      return json(native('m-3', { direction: 'outgoing', body: 'Manual' }));
    }
    if (url.includes('/contacts/')) {
      return json({ displayName: 'Alice' });
    }
    throw new Error(`unexpected request ${url}`);
  });
  t.mock.method(console, 'error', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1', chatIds: ['wxid_alice'] });
  t.after(() => adapter.stop());
  await adapter.start((incoming) => received.push(incoming));
  await waitFor(() => stream !== undefined, 'event stream');
  assert.match(streamUrl, /\/events\/stream\?after=100$/);
  assert.equal(streamOptions.headers.Authorization, 'Bearer token');
  assert.equal(streamOptions.headers.Accept, 'text/event-stream');

  stream.push(': connected\r\n\r\n');
  // Split one frame at every byte, including a multi-byte character, across chunks.
  const bytes = encoder.encode(frame('101', 'message.committed',
    { messageId: 'm-1', threadId: 'wxid_alice' }, { note: 'hé😀' }));
  for (let index = 0; index < bytes.length; index += 3) {
    stream.pushBytes(bytes.slice(index, index + 3));
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  // A CRLF sequence split between chunks is still one line ending.
  stream.push('id: 102\r');
  stream.push(`\ndata: ${JSON.stringify({ cursor: '102', kind: 'message.committed',
    data: { messageId: 'm-2', threadId: 'wxid_alice' }, createdAt: new Date().toISOString() })}\r\n\r\n`);
  // Multiline data fields are joined with newlines before JSON parsing.
  const multiline = JSON.stringify({ cursor: '103', kind: 'message.committed',
    data: { messageId: 'm-3', threadId: 'wxid_alice' }, createdAt: new Date().toISOString() }, null, 2);
  stream.push(`id: 103\r\n${multiline.split('\n').map((line) => `data: ${line}`).join('\r\n')}\r\n\r\n`);
  stream.push(': keepalive\n\n');
  // An unmonitored thread must be filtered before its message is read.
  stream.push(frame('104', 'message.committed', { messageId: 'm-4', threadId: 'wxid_bob' }));
  // Unknown kinds are ignored and still advance the checkpoint.
  stream.push(frame('105', 'thread.updated', { threadId: 'wxid_alice' }));

  await waitFor(() => received.length === 3 && adapter.after === '105', 'three deliveries');
  assert.deepEqual(received.map((item) => item.messages[0].id),
    ['message:m-1', 'message:m-2', 'message:m-3']);
  assert.equal(received[0].text, 'One');
  assert.equal(received[1].text, '[Image]');
  assert.equal(received[1].messages[0].images[0].id, 'image:m-2');
  assert.equal(received[2].isSelf, true, 'self messages are delivered as context');
  assert.equal(received[2].messages[0].isSelf, true);
  assert.equal(requests.filter((url) => url.includes('/messages/m-4')).length, 0,
    'chatIds are filtered before any message read');
  assert.equal(requests.filter((url) => url.includes('/media')).length, 0, 'media stays lazy');
  const status = adapter.getStatus();
  assert.ok(status.lastEventAt);
  assert.equal(status.consecutiveFailures, 0);
});

test('reconnect resumes from an opaque cursor above 2^53 and deduplicates replay', async (t) => {
  const received = [];
  const streams = [];
  const reads = [];
  let accountReads = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      accountReads += 1;
      return json(account('acct-1', true, 'wxid_bot'));
    }
    if (url.includes('/threads?')) {
      return json({ items: [], nextCursor: null, asOfEventCursor: '9007199254740993' });
    }
    if (url.includes('/events/stream')) {
      const channel = streamResponse(options.signal);
      streams.push({ url: String(url), channel });
      return channel.response;
    }
    if (url.includes('/messages/')) {
      const id = decodeURIComponent(url.split('/messages/')[1]);
      reads.push(id);
      return json(native(id));
    }
    if (url.includes('/contacts/')) {
      return json({ displayName: 'Alice' });
    }
    throw new Error(`unexpected request ${url}`);
  });
  t.mock.method(console, 'error', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1', reconnectIntervalMs: 5 });
  t.after(() => adapter.stop());
  await adapter.start((incoming) => received.push(incoming));
  await waitFor(() => streams.length === 1, 'first stream');
  assert.match(streams[0].url, /after=9007199254740993$/);

  streams[0].channel.push(frame('9007199254740994', 'message.committed',
    { messageId: 'm-1', threadId: 'wxid_alice' }));
  await waitFor(() => received.length === 1 && adapter.after === '9007199254740994', 'first event');
  streams[0].channel.close();
  await waitFor(() => streams.length === 2, 'reconnect');
  assert.match(streams[1].url, /after=9007199254740994$/,
    'the decimal cursor is preserved as a string without precision loss');
  assert.ok(accountReads >= 2, 'reconnect revalidates the account');

  streams[1].channel.push(frame('9007199254740995', 'message.committed',
    { messageId: 'm-1', threadId: 'wxid_alice' }));
  streams[1].channel.push(frame('9007199254740996', 'message.committed',
    { messageId: 'm-2', threadId: 'wxid_alice' }));
  await waitFor(() => received.length === 2 && adapter.after === '9007199254740996', 'second event');
  assert.deepEqual(received.map((item) => item.messages[0].id),
    ['message:m-1', 'message:m-2']);

  // An older cursor is compared with BigInt: it is neither replayed nor checkpointed.
  streams[1].channel.push(frame('9007199254740995', 'message.committed',
    { messageId: 'm-unseen', threadId: 'wxid_alice' }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(adapter.after, '9007199254740996', 'an older cursor never regresses the checkpoint');
  assert.deepEqual(reads, ['m-1', 'm-2'], 'a replayed older event is not even read');
  assert.equal(received.length, 2);
});

test('a failed message read keeps the checkpoint and reconnects for replay', async (t) => {
  const received = [];
  const streams = [];
  let failRead = true;
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1', true, 'wxid_bot'));
    }
    if (url.includes('/threads?')) {
      return json({ items: [], nextCursor: null, asOfEventCursor: '50' });
    }
    if (url.includes('/events/stream')) {
      const channel = streamResponse(options.signal);
      streams.push({ url: String(url), channel });
      return channel.response;
    }
    if (url.endsWith('/messages/m-1')) {
      reads += 1;
      return failRead ? new Response('{}', { status: 500 }) : json(native('m-1'));
    }
    if (url.includes('/contacts/')) {
      return json({ displayName: 'Alice' });
    }
    throw new Error(`unexpected request ${url}`);
  });
  t.mock.method(console, 'error', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1', reconnectIntervalMs: 5 });
  t.after(() => adapter.stop());
  await adapter.start((incoming) => received.push(incoming));
  await waitFor(() => streams.length === 1, 'first stream');
  streams[0].channel.push(frame('51', 'message.committed',
    { messageId: 'm-1', threadId: 'wxid_alice' }));
  await waitFor(() => reads === 1, 'failed read');
  assert.equal(adapter.after, '50', 'the event is not checkpointed before a successful read');
  assert.equal(received.length, 0);
  assert.match(adapter.getStatus().lastError, /HTTP 500/);
  assert.equal(adapter.getStatus().lastEventAt, undefined, 'a failed read is not healthy');

  failRead = false;
  await waitFor(() => streams.length === 2, 'reconnect after read failure');
  assert.match(streams[1].url, /after=50$/, 'replay starts from the prior checkpoint');
  streams[1].channel.push(frame('51', 'message.committed',
    { messageId: 'm-1', threadId: 'wxid_alice' }));
  await waitFor(() => received.length === 1 && adapter.after === '51', 'replayed delivery');
  assert.equal(reads, 2);
});

test('cursor expiry rebases once at the current tail and skips the missed window', async (t) => {
  const received = [];
  const streams = [];
  const streamRequests = [];
  const lookups = [];
  const highs = ['10', '20', '30'];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1', true, 'wxid_bot'));
    }
    if (url.includes('/threads?limit=1')) {
      lookups.push(String(url));
      return json({ items: [], nextCursor: null,
        asOfEventCursor: highs[Math.min(lookups.length - 1, highs.length - 1)] });
    }
    if (url.includes('/events/stream')) {
      streamRequests.push(String(url));
      // The daemon rejects the startup cursor once before headers.
      if (streamRequests.length === 1) {
        return json({ error: { code: 'event_cursor_expired' } }, 409);
      }
      const channel = streamResponse(options.signal);
      streams.push({ url: String(url), channel });
      return channel.response;
    }
    throw new Error(`unexpected request ${url}`);
  });
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1', reconnectIntervalMs: 5 });
  t.after(() => adapter.stop());
  await adapter.start((incoming) => received.push(incoming));

  await waitFor(() => streams.length === 1, 'stream after HTTP expiry rebase');
  assert.match(streams[0].url, /after=20$/, 'the current tail is used after expiry');
  assert.doesNotMatch(streams[0].url, /after=0/);
  assert.equal(adapter.after, '20');
  assert.deepEqual(received, [], 'the missed window is skipped rather than backfilled');

  streams[0].channel.push('event: error\ndata: {"error":{"code":"event_cursor_expired"}}\n\n');
  await waitFor(() => streams.length === 2, 'stream after in-stream expiry rebase');
  assert.match(streams[1].url, /after=30$/);
  assert.deepEqual(received, []);
  assert.equal(adapter.after, '30');
  assert.equal(lookups.length, 3, 'one current-tail lookup at startup and after each expiry');
  assert.ok(streamRequests.every((url) => !url.includes('/messages')));
});
test('heartbeat comments keep a quiet stream alive, an idle stream reconnects, and stop is prompt', async (t) => {
  const streams = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1', true, 'wxid_bot'));
    }
    if (url.includes('/threads?')) {
      return json({ items: [], nextCursor: null, asOfEventCursor: '0' });
    }
    if (url.includes('/events/stream')) {
      const channel = streamResponse(options.signal);
      streams.push({ url: String(url), channel });
      return channel.response;
    }
    return json({ displayName: 'Alice' });
  });
  t.mock.method(console, 'error', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1',
    timeoutMs: 200, reconnectIntervalMs: 5 });
  t.after(() => adapter.stop());
  await adapter.start(() => {});
  await waitFor(() => streams.length === 1, 'first stream');

  const beat = setInterval(() => streams[0].channel.push(': keepalive\n\n'), 50);
  t.after(() => clearInterval(beat));
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(streams.length, 1, 'heartbeats reset the idle deadline');

  clearInterval(beat);
  await waitFor(() => streams.length === 2, 'idle reconnect', 4000);
  assert.match(streams[1].url, /after=0$/);
  const started = Date.now();
  await adapter.stop();
  assert.ok(Date.now() - started < 1000, 'stop does not wait for a quiet stream');
  const count = streams.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(streams.length, count, 'stopped streams do not reconnect');
});

test('stop aborts a long reconnect backoff immediately', async (t) => {
  let streamCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1', true, 'wxid_bot'));
    }
    if (url.includes('/threads?')) {
      return json({ items: [], nextCursor: null, asOfEventCursor: '0' });
    }
    if (url.includes('/events/stream')) {
      streamCalls += 1;
      throw new Error('connection refused');
    }
    return json({});
  });
  t.mock.method(console, 'error', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1', reconnectIntervalMs: 60000 });
  await adapter.start(() => {});
  await waitFor(() => streamCalls === 1 && adapter.getStatus().consecutiveFailures > 0, 'failure');
  const started = Date.now();
  await adapter.stop();
  assert.ok(Date.now() - started < 1000, 'stop interrupts the backoff sleep');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(streamCalls, 1, 'no reconnect after stop');
});

test('account.updated revalidates daemon ID plus username and tail-bootstraps the new login', async (t) => {
  const streams = [];
  let accountReads = 0;
  let lookups = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      accountReads += 1;
      return json(account('acct-1', true, accountReads === 1 ? 'wxid_bot' : 'wxid_new_login'));
    }
    if (url.includes('/threads?limit=1')) {
      lookups += 1;
      return json({ items: [], nextCursor: null, asOfEventCursor: lookups === 1 ? '5' : '100' });
    }
    if (url.includes('/events/stream')) {
      const channel = streamResponse(options.signal);
      streams.push({ url: String(url), channel });
      return channel.response;
    }
    throw new Error(`unexpected request ${url}`);
  });
  t.mock.method(console, 'error', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1', reconnectIntervalMs: 5 });
  t.after(() => adapter.stop());
  await adapter.start(() => {});
  await waitFor(() => streams.length === 1, 'first stream');
  assert.match(streams[0].url, /after=5$/);
  assert.equal(adapter.selfUsername, 'wxid_bot');
  assert.equal(lookups, 1, 'startup performs one current-tail lookup');

  streams[0].channel.push(frame('6', 'account.updated', {}));
  await waitFor(() => streams.length === 2, 'restarted stream');
  assert.ok(accountReads >= 2, 'account.updated revalidates the account');
  assert.equal(adapter.selfUsername, 'wxid_new_login', 'a re-login is detected by both identity fields');
  assert.match(streams[1].url, /after=100$/, 'the previous login cursor is never reused');
  assert.equal(adapter.after, '100');
  assert.equal(lookups, 2, 'the new login tail-bootstraps instead of replaying the old cursor');
});
test('media owned by another account or message is never selected or fetched', async (t) => {
  const adapter = send(new WechatMessagerAdapter('token', { accountId: 'acct-1' }));
  const asset = (overrides) => ({ id: 'asset-1', accountId: 'acct-1', messageId: 'm-1', kind: 'image',
    variant: 'original', actualVariant: 'original', state: 'available', contentType: 'image/png',
    byteLength: png.length, contentUrl: '/untrusted', retryable: false, jobId: null, ...overrides });
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    if (url.endsWith('/messages/m-1/media')) {
      return json({ items: [asset({ accountId: 'acct-2' }), asset({ messageId: 'm-2' })] });
    }
    assert.fail('another account or message must never be fetched');
  });
  assert.deepEqual(await adapter.loadImage('m-1', 'acct-1', 'wxid_bot'), { status: 'unavailable' });
  assert.deepEqual(requested.filter((url) => url.includes('/content')), []);
});

test('reply metadata without the signed-in username is rejected as a different session', async () => {
  const adapter = send(new WechatMessagerAdapter('token', { accountId: 'acct-1' }));
  await assert.rejects(adapter.reply({ ...message, metadata: { wechatAccount: 'acct-1' } }, { text: 'Hi' }),
    /account has changed/);
});

test('text sends complete from send.updated, reconcile once, and never resend', async (t) => {
  const accepted = send(new WechatMessagerAdapter('token'));
  const requests = [];
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), body: options.body === undefined ? undefined : JSON.parse(options.body),
      key: options.headers['Idempotency-Key'] });
    if (url.endsWith('/sends')) {
      return new Response(JSON.stringify(intent('queued')), { status: 202 });
    }
    reads += 1;
    return new Response(JSON.stringify(intent('queued')));
  });
  const reply = accepted.reply(message, { text: 'Hi' });
  await waitFor(() => reads === 1, 'one status reconciliation');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(reads, 1, 'a queued send waits on its event instead of polling');
  await accepted.handleEvent({ cursor: '1', kind: 'send.updated', data: intent('accepted') });
  await reply;
  assert.deepEqual(requests[0].body, { threadId: 'wxid_alice', text: 'Hi' });
  assert.match(requests[0].key, /^[0-9a-f-]{36}$/);
  assert.equal(requests.filter((request) => request.url.endsWith('/sends')).length, 1, 'no resend');

  // A terminal submission response needs neither a status read nor an event.
  const uncertain = send(new WechatMessagerAdapter('token'));
  const uncertainUrls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    uncertainUrls.push(String(url));
    assert.ok(url.endsWith('/sends'), 'a terminal submission is neither read nor cancelled');
    return new Response(JSON.stringify(intent('needs_review', { errorCode: 'send_uncertain' })), { status: 202 });
  });
  await assert.rejects(uncertain.reply(message, { text: 'Hi' }), /needs_review: send_uncertain/);
  assert.equal(uncertainUrls.length, 1);

  // A caller abort settles promptly and cancels once without resending.
  const cancelled = send(new WechatMessagerAdapter('token'));
  const controller = new AbortController();
  const cancelUrls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    cancelUrls.push({ url: String(url), method: options.method });
    if (url.endsWith('/sends/send-1/cancel')) {
      return new Response(JSON.stringify(intent('cancelled')));
    }
    if (url.endsWith('/sends')) {
      return new Response(JSON.stringify(intent('queued')), { status: 202 });
    }
    return new Response(JSON.stringify(intent('queued')));
  });
  const pending = cancelled.reply(message, { text: 'Hi' }, controller.signal);
  await waitFor(() => cancelUrls.some((request) => request.url.endsWith('/sends/send-1')), 'reconcile');
  controller.abort();
  await assert.rejects(pending, /unconfirmed/);
  assert.equal(cancelUrls.filter((request) => request.method === 'POST' &&
    request.url.endsWith('/sends')).length, 1, 'the send is never repeated');
  assert.ok(cancelUrls.at(-1).url.endsWith('/sends/send-1/cancel'));
});
test('pending image media starts one transfer at the best quality and stays fenced to its account', async (t) => {
  const adapter = send(new WechatMessagerAdapter('token'));
  const requests = [];
  const asset = (variant, state, extra = {}) => ({ id: `asset-${variant}`, accountId: 'acct-1',
    messageId: 'm-1', kind: 'image', variant, actualVariant: variant, state, contentType: null,
    byteLength: null, contentUrl: '/untrusted', retryable: true, jobId: null, ...extra });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: String(url), body: options?.body === undefined ? undefined : JSON.parse(options.body) });
    if (url.endsWith('/messages/m-1/media')) {
      return json({ items: [asset('thumbnail', 'pending'), asset('original', 'pending')] });
    }
    assert.ok(url.endsWith('/messages/m-1/media-transfers'));
    return new Response(JSON.stringify({ id: 'job-1', accountId: 'acct-1', kind: 'download',
      state: 'queued', reason: null }), { status: 202 });
  });
  assert.deepEqual(await adapter.loadImage('m-1', 'acct-1', 'wxid_bot'), { status: 'pending' });
  assert.deepEqual(requests[1].body, { messageId: 'm-1', assetId: 'asset-original' });

  const content = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    content.push(String(url));
    if (url.endsWith('/messages/m-1/media')) {
      return json({ items: [asset('original', 'available', {
        contentType: 'image/png', byteLength: png.length, retryable: false })] });
    }
    assert.ok(url.endsWith('/v1/accounts/acct-1/media/asset-original/content'), 'account-scoped route');
    return new Response(png, { headers: { 'Content-Type': 'image/png' } });
  });
  assert.deepEqual(await adapter.loadImage('m-1', 'acct-1', 'wxid_bot'),
    { status: 'ready', dataUrl: `data:image/png;base64,${png.toString('base64')}` });
  assert.equal(content.filter((url) => url.includes('/media/asset-original/content')).length, 1);

  adapter.account = 'acct-2';
  await assert.rejects(adapter.loadImage('m-1', 'acct-1', 'wxid_bot'), /account has changed/);

  adapter.account = 'acct-1';
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      { once: true });
  }));
  const pending = adapter.loadImage('m-2', 'acct-1', 'wxid_bot', controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('every route uses the daemon root plus a single /v1 prefix, whatever baseUrl is given', async (t) => {
  const expectRoot = async (options, expected) => {
    const urls = [];
    t.mock.method(globalThis, 'fetch', async (url, fetchOptions = {}) => {
      urls.push(String(url));
      if (url.endsWith('/v1/accounts/acct-1')) {
        return json(account('acct-1', true, 'wxid_bot'));
      }
      if (url.includes('/threads?')) {
        return json({ items: [], nextCursor: null, asOfEventCursor: '0' });
      }
      if (url.includes('/events/stream')) {
        return streamResponse(fetchOptions.signal).response;
      }
      throw new Error(`unexpected request ${url}`);
    });
    const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1', ...options });
    t.after(() => adapter.stop());
    await adapter.start(() => {});
    await waitFor(() => urls.some((url) => url.includes('/events/stream')), 'stream');
    assert.equal(urls[0], expected);
    assert.ok(urls.every((url) => !url.includes('/v1/v1')));
  };
  // The documented default is the daemon root; `/v1` is added by the route table.
  await expectRoot({}, 'http://127.0.0.1:6174/v1/accounts/acct-1');
  await expectRoot({ baseUrl: 'http://127.0.0.1:6174' }, 'http://127.0.0.1:6174/v1/accounts/acct-1');
  await expectRoot({ baseUrl: 'http://127.0.0.1:6174/' }, 'http://127.0.0.1:6174/v1/accounts/acct-1');
  await expectRoot({ baseUrl: 'http://127.0.0.1:6174/v1' }, 'http://127.0.0.1:6174/v1/accounts/acct-1');
  await expectRoot({ baseUrl: 'https://wechat.example.test/daemon' },
    'https://wechat.example.test/daemon/v1/accounts/acct-1');

  // A send and its confirmation use the same exact prefix, with no `/v1/v1` anywhere.
  const adapter = send(new WechatMessagerAdapter('token', { accountId: 'acct-1' }));
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify(intent('accepted')));
  });
  await adapter.reply(message, { text: 'Hi' });
  assert.deepEqual(urls, ['http://127.0.0.1:6174/v1/accounts/acct-1/sends']);
  assert.ok(urls.every((url) => !url.includes('/v1/v1')));
});

test('switching the signed-in username fences queued replies and lazy media in the same profile', async (t) => {
  const adapter = send(new WechatMessagerAdapter('token', { accountId: 'acct-1' }));
  const received = [];
  adapter.handler = (incoming) => received.push(incoming);
  const rows = [{ id: 'm-1', accountId: 'acct-1', threadId: 'wxid_alice', senderId: 'wxid_alice',
    type: 3, direction: 'incoming', body: null, createdAt: '2026-10-19T10:00:01Z' }];
  adapter.startedAt = 0;
  const mediaUrls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    mediaUrls.push(String(url));
    if (url.endsWith('/messages/m-1')) {
      return json(rows[0]);
    }
    return new Response('{}', { status: 404 });
  });
  await adapter.handleEvent({ cursor: '1', kind: 'message.committed',
    data: { messageId: 'm-1', threadId: 'wxid_alice' } });
  assert.equal(received.length, 1);
  // The daemon account ID is unchanged; only the signed-in username switched.
  adapter.selfUsername = 'wxid_new_login';
  await assert.rejects(received[0].messages[0].images[0].load(), /account has changed/);
  assert.deepEqual(mediaUrls.filter((url) => url.includes('/media')), [], 'no media fetched after a re-login');
  await assert.rejects(adapter.reply(message, { text: 'Hi' }), /account has changed/);

  // A switch that happens while a reply is in flight also stops the send.
  adapter.selfUsername = 'wxid_bot';
  const inFlight = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    inFlight.push({ url: String(url), body: options.body === undefined ? undefined : options.body });
    if (url.endsWith('/uploads')) {
      adapter.selfUsername = 'wxid_new_login';
      return new Response(JSON.stringify({ id: 'source-1', mediaType: 'image/png', name: 'image.png',
        byteLength: png.length, sha256: '0'.repeat(64), createdAt: new Date().toISOString() }), { status: 201 });
    }
    return new Response(JSON.stringify({ id: 'send-1', accountId: 'acct-1', destination: 'wxid_alice',
      state: 'accepted', errorCode: null, createdAt: new Date().toISOString() }));
  });
  await assert.rejects(adapter.reply(message, { text: '', images: [{ data: png, filename: 'image.png',
    mimeType: 'image/png' }] }), /account has changed/);
  assert.equal(inFlight.filter((request) => String(request.url).endsWith('/sends')).length, 0,
    'the switched profile never submits the staged upload');
});

test('a re-login settles the pending send and an in-flight accepted read cannot confirm it', async (t) => {
  const adapter = send(new WechatMessagerAdapter('token', { accountId: 'acct-1' }));
  const urls = [];
  let releaseRead;
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    if (url.endsWith('/v1/accounts/acct-1')) {
      // The re-login is only adopted through the real event path.
      return json(account('acct-1', true, 'wxid_new_login'));
    }
    if (url.endsWith('/sends')) {
      return new Response(JSON.stringify(intent('queued')), { status: 202 });
    }
    if (url.endsWith('/sends/send-1/cancel')) {
      return new Response(JSON.stringify(intent('cancelled')));
    }
    // The status read is still outstanding when the re-login arrives, and it then
    // reports success for the previous login.
    return new Promise((resolve) => {
      releaseRead = () => resolve(new Response(JSON.stringify(intent('accepted'))));
    });
  });
  const reply = adapter.reply(message, { text: 'Hi' });
  await waitFor(() => urls.some((url) => url.endsWith('/sends/send-1')), 'status reconciliation');
  await adapter.handleEvent({ cursor: '1', kind: 'account.updated', data: {} });
  assert.equal(adapter.selfUsername, 'wxid_new_login');
  await assert.rejects(reply, /account changed/);
  releaseRead();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(urls.every((url) => url.startsWith('http://127.0.0.1:6174/v1/accounts/acct-1')),
    urls.join(','));
  assert.equal(urls.filter((url) => url.endsWith('/sends')).length, 1, 'no resend');
});
test('a replayed event older than startup is checkpointed without delivery', async (t) => {
  const received = [];
  const reads = [];
  const future = new Date(Date.now() + 60_000).toISOString();
  let stream;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1', true, 'wxid_bot'));
    }
    if (url.includes('/threads?')) {
      return json({ items: [], nextCursor: null, asOfEventCursor: '10' });
    }
    if (url.includes('/events/stream')) {
      stream = streamResponse(options.signal);
      return stream.response;
    }
    if (url.includes('/messages/')) {
      const id = decodeURIComponent(url.split('/messages/')[1]);
      reads.push(id);
      if (id === 'm-old') {
        return json(native('m-old', { createdAt: '2020-01-01T00:00:00Z' }));
      }
      if (id === 'm-undated') {
        return json(native('m-undated', { createdAt: null }));
      }
      // A live message whose source time is older than the newest delivered one but
      // still at or after the startup cutoff.
      return json(native(id, { createdAt: id === 'm-newest' ? future : new Date().toISOString() }));
    }
    if (url.includes('/contacts/')) {
      return json({ displayName: 'Alice' });
    }
    throw new Error(`unexpected request ${url}`);
  });
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1' });
  t.after(() => adapter.stop());
  await adapter.start((incoming) => received.push(incoming));
  await waitFor(() => stream !== undefined, 'event stream');

  stream.push(frame('11', 'message.committed', { messageId: 'm-old', threadId: 'wxid_alice' }));
  await waitFor(() => adapter.after === '11', 'checkpoint after a pre-start event');
  assert.deepEqual(received, [], 'downtime history replayed by the stream is not delivered');

  // An undated event cannot be ordered against the cutoff, so it is skipped as well.
  stream.push(frame('12', 'message.committed', { messageId: 'm-undated', threadId: 'wxid_alice' }));
  await waitFor(() => adapter.after === '12', 'checkpoint after an undated event');
  assert.deepEqual(received, [], 'an undated live event is skipped and still checkpointed');
  assert.deepEqual(reads, ['m-old', 'm-undated']);

  // Distinct live events are never compared by timestamp: the newer one arrives first,
  // then an older-but-after-startup one is still delivered.
  stream.push(frame('13', 'message.committed', { messageId: 'm-newest', threadId: 'wxid_alice' }));
  await waitFor(() => received.length === 1 && adapter.after === '13', 'newest live event');
  stream.push(frame('14', 'message.committed', { messageId: 'm-earlier', threadId: 'wxid_alice' }));
  await waitFor(() => received.length === 2 && adapter.after === '14', 'out-of-order live event');
  assert.deepEqual(received.map((item) => item.messages[0].id),
    ['message:m-newest', 'message:m-earlier'],
    'an out-of-order source time below the newest event is not dropped');
});

test('keepalives do not reset backoff while a message read keeps failing', async (t) => {
  const streams = [];
  const attempts = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1', true, 'wxid_bot'));
    }
    if (url.includes('/threads?')) {
      return json({ items: [], nextCursor: null, asOfEventCursor: '10' });
    }
    if (url.includes('/events/stream')) {
      const channel = streamResponse(options.signal);
      streams.push(String(url));
      attempts.push(Date.now());
      // The connection and a keepalive succeed before the message read fails again.
      setTimeout(() => {
        channel.push(': connected\n\n');
        channel.push(frame('11', 'message.committed', { messageId: 'm-1', threadId: 'wxid_alice' }));
      }, 1);
      return channel.response;
    }
    if (url.endsWith('/messages/m-1')) {
      return new Response('{}', { status: 500 });
    }
    throw new Error(`unexpected request ${url}`);
  });
  t.mock.method(console, 'error', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1', reconnectIntervalMs: 5 });
  t.after(() => adapter.stop());
  await adapter.start(() => {});
  await waitFor(() => attempts.length >= 4, 'four failed attempts', 5000);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const status = adapter.getStatus();
  assert.ok(streams.every((url) => url.endsWith('/events/stream?after=10')), streams.join(','));
  assert.ok(status.lastStreamActivityAt, 'the keepalive was observed');
  assert.equal(status.lastEventAt, undefined, 'a failed read is never reported healthy');
  assert.match(status.lastError, /HTTP 500/);
  const gaps = attempts.slice(1).map((time, index) => time - attempts[index]);
  assert.ok(gaps.at(-1) > gaps[0],
    `a keepalive on every attempt must not reset the backoff: ${gaps.join(',')}`);
  assert.ok(attempts.length < 25, `attempts stay bounded, saw ${attempts.length}`);
  assert.ok(status.consecutiveFailures >= 3, 'failures accumulate across connects');
});

test('replayed cursors never regress or redeliver, while equal source times still deliver', async (t) => {
  const received = [];
  const reads = [];
  let stream;
  let stamp;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1', true, 'wxid_bot'));
    }
    if (url.includes('/threads?')) {
      return json({ items: [], nextCursor: null, asOfEventCursor: '100' });
    }
    if (url.includes('/events/stream')) {
      stream = streamResponse(options.signal);
      return stream.response;
    }
    if (url.includes('/messages/')) {
      const id = decodeURIComponent(url.split('/messages/')[1]);
      reads.push(id);
      // Both live messages share one source time, recorded after startup.
      stamp ??= new Date().toISOString();
      return json(native(id, { body: id, createdAt: stamp }));
    }
    if (url.includes('/contacts/')) {
      return json({ displayName: 'Alice' });
    }
    throw new Error(`unexpected request ${url}`);
  });
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1' });
  t.after(() => adapter.stop());
  await adapter.start((incoming) => received.push(incoming));
  await waitFor(() => stream !== undefined, 'event stream');

  stream.push(frame('101', 'message.committed', { messageId: 'm-1', threadId: 'wxid_alice' }));
  stream.push(frame('102', 'message.committed', { messageId: 'm-2', threadId: 'wxid_alice' }));
  await waitFor(() => received.length === 2 && adapter.after === '102', 'two live events');
  assert.deepEqual(received.map((item) => item.messages[0].id), ['message:m-1', 'message:m-2'],
    'equal source timestamps are not merged or dropped');

  // A replay below the checkpoint is ignored without a message read or regression.
  stream.push(frame('101', 'message.committed', { messageId: 'm-3', threadId: 'wxid_alice' }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(reads, ['m-1', 'm-2'], 'a covered cursor is not even read');
  assert.equal(adapter.after, '102', 'the checkpoint never moves backwards');
  assert.equal(received.length, 2);
});

test('repeated cursor expiry keeps backing off instead of spinning', async (t) => {
  const attempts = [];
  const streams = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1', true, 'wxid_bot'));
    }
    if (url.includes('/threads?limit=1')) {
      // The tail never advances, so every attempt is rejected again.
      return json({ items: [], nextCursor: null, asOfEventCursor: '10' });
    }
    if (url.includes('/events/stream')) {
      attempts.push(Date.now());
      streams.push(String(url));
      return json({ error: { code: 'event_cursor_expired' } }, 409);
    }
    throw new Error(`unexpected request ${url}`);
  });
  t.mock.method(console, 'error', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1', reconnectIntervalMs: 5 });
  t.after(async () => { await adapter.stop(); });
  await adapter.start(() => {});
  await waitFor(() => attempts.length >= 4, 'several expiry attempts', 4000);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(attempts.length < 40, `bounded attempts, saw ${attempts.length}`);
  const gaps = attempts.slice(1).map((time, index) => time - attempts[index]);
  assert.ok(gaps.at(-1) > gaps[0], `backoff grows: ${gaps.join(',')}`);
  // Expiry clears the checkpoint and rebases on the current tail; it never resets to 0.
  assert.ok(streams.every((url) => /after=10$/.test(url)), streams.join(','));
  assert.ok(streams.every((url) => !/after=0$/.test(url)), 'cursor zero is never used');
  const started = Date.now();
  await adapter.stop();
  assert.ok(Date.now() - started < 1000, 'stop interrupts an expiry backoff');
  const count = attempts.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(attempts.length, count, 'no reconnect after stop');
});

test('CR-only frames, large chunks, a skipped undated event, and a bounded error body are handled', async (t) => {
  const received = [];
  const streams = [];
  let errorBodies = 0;
  const recent = () => new Date().toISOString();
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1', true, 'wxid_bot'));
    }
    if (url.includes('/threads?')) {
      return json({ items: [], nextCursor: null, asOfEventCursor: '20' });
    }
    if (url.includes('/events/stream')) {
      streams.push(String(url));
      // The first attempt is rejected with a large non-expiry error body.
      if (streams.length === 1) {
        errorBodies += 1;
        return new Response(JSON.stringify({ error: { code: 'rate_limited',
          message: 'x'.repeat(200_000) } }), { status: 429 });
      }
      const channel = streamResponse(options.signal);
      channels.push(channel);
      return channel.response;
    }
    if (url.endsWith('/messages/m-pad')) {
      return json(native('m-pad', { body: 'Large', createdAt: recent() }));
    }
    if (url.endsWith('/messages/m-undated')) {
      return json(native('m-undated', { createdAt: null }));
    }
    if (url.includes('/contacts/')) {
      return json({ displayName: 'Alice' });
    }
    throw new Error(`unexpected request ${url}`);
  });
  const channels = [];
  t.mock.method(console, 'error', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1',
    reconnectIntervalMs: 5, timeoutMs: 500 });
  t.after(async () => { await adapter.stop(); });
  await adapter.start((incoming) => received.push(incoming));
  await waitFor(() => channels.length === 1 && adapter.getStatus().consecutiveFailures > 0,
    'recovery from the large error body', 4000);
  assert.equal(errorBodies, 1, 'the oversized error body was read once and bounded');
  assert.match(streams[1], /after=20$/, 'the checkpoint is unchanged by the rejected attempt');

  // A frame whose JSON payload is large but valid is still one bounded line.
  const pad = JSON.stringify({ cursor: '21', kind: 'message.committed',
    data: { messageId: 'm-pad', threadId: 'wxid_alice', pad: 'x'.repeat(400_000) },
    createdAt: recent() });
  channels[0].push(`id: 21\ndata: ${pad}\n\n`);
  await waitFor(() => received.length === 1 && adapter.after === '21', 'large chunk delivery');
  assert.equal(received[0].messages[0].text, 'Large');

  // CR-only line endings are valid SSE separators.
  channels[0].push(`id: 22\rdata: ${JSON.stringify({ cursor: '22', kind: 'message.committed',
    data: { messageId: 'm-undated', threadId: 'wxid_alice' }, createdAt: recent() })}\r\r`);
  await waitFor(() => adapter.after === '22', 'CR-only frame');
  assert.equal(received.length, 1, 'an undated live message cannot be ordered and is skipped');
});

test('an overlong stream line fails the attempt instead of buffering without bound', async (t) => {
  const streams = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1', true, 'wxid_bot'));
    }
    if (url.includes('/threads?')) {
      return json({ items: [], nextCursor: null, asOfEventCursor: '30' });
    }
    if (url.includes('/events/stream')) {
      streams.push(String(url));
      const channel = streamResponse(options.signal);
      if (streams.length === 1) {
        // No line terminator: the parser must stop at its line bound.
        channel.push('data: ' + 'x'.repeat(1_200_000));
      }
      return channel.response;
    }
    throw new Error(`unexpected request ${url}`);
  });
  t.mock.method(console, 'error', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1', reconnectIntervalMs: 5 });
  t.after(async () => { await adapter.stop(); });
  await adapter.start(() => {});
  await waitFor(() => streams.length >= 2, 'reconnect after an overlong line', 4000);
  assert.ok(streams.every((url) => url.endsWith('after=30')), streams.join(','));
  assert.match(adapter.getStatus().lastError, /size limit/);
});

test('a chunk larger than the line limit passes when every frame is small', async (t) => {
  const received = [];
  let stream;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1', true, 'wxid_bot'));
    }
    if (url.includes('/threads?')) {
      return json({ items: [], nextCursor: null, asOfEventCursor: '0' });
    }
    if (url.includes('/events/stream')) {
      stream = streamResponse(options.signal);
      return stream.response;
    }
    if (url.includes('/messages/')) {
      return json(native(decodeURIComponent(url.split('/messages/')[1])));
    }
    if (url.includes('/contacts/')) {
      return json({ displayName: 'Alice' });
    }
    throw new Error(`unexpected request ${url}`);
  });
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1' });
  t.after(async () => { await adapter.stop(); });
  await adapter.start((incoming) => received.push(incoming));
  await waitFor(() => stream !== undefined, 'event stream');

  // Small irrelevant frames total well over the per-line limit in one chunk.
  let chunk = '';
  let expected = '0';
  for (let index = 1; index <= 10_000; index++) {
    expected = String(index);
    chunk += frame(expected, 'thread.updated', { threadId: 'wxid_alice' });
  }
  assert.ok(chunk.length > 1_100_000, `chunk size ${chunk.length}`);
  stream.push(chunk);
  await waitFor(() => adapter.after === expected, 'every small frame in a large chunk');
  assert.equal(adapter.getStatus().consecutiveFailures, 0, 'many small frames are not a line limit');
});

test('a single frame exceeding the data bound fails the attempt, not the buffer', async (t) => {
  const streams = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1', true, 'wxid_bot'));
    }
    if (url.includes('/threads?')) {
      return json({ items: [], nextCursor: null, asOfEventCursor: '70' });
    }
    if (url.includes('/events/stream')) {
      streams.push(String(url));
      const channel = streamResponse(options.signal);
      if (streams.length === 1) {
        // Each line is short; the accumulated frame data is not.
        const line = `data: ${'y'.repeat(4_000)}\n`;
        channel.push(line.repeat(300));
      }
      return channel.response;
    }
    throw new Error(`unexpected request ${url}`);
  });
  t.mock.method(console, 'error', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1', reconnectIntervalMs: 5 });
  t.after(async () => { await adapter.stop(); });
  await adapter.start(() => {});
  await waitFor(() => streams.length >= 2, 'reconnect after an oversized frame', 4000);
  assert.match(adapter.getStatus().lastError, /frame exceeded its size limit/);
  assert.ok(streams.every((url) => url.endsWith('after=70')), streams.join(','));
});

test('a slow error body is bounded by the stream deadline and never blocks stop', async (t) => {
  let streams = 0;
  let bodyCancelled = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1', true, 'wxid_bot'));
    }
    if (url.includes('/threads?')) {
      return json({ items: [], nextCursor: null, asOfEventCursor: '80' });
    }
    if (url.includes('/events/stream')) {
      streams += 1;
      // An error body that trickles forever: the deadline must end every read.
      let bodyController;
      const body = new ReadableStream({
        start(controller) {
          bodyController = controller;
          controller.enqueue(encoder.encode('{"error":'));
        },
        cancel() { bodyCancelled += 1; }
      });
      options.signal?.addEventListener('abort', () => {
        try { bodyController.error(new Error('aborted')); } catch { /* closed */ }
      }, { once: true });
      return new Response(body, { status: 429 });
    }
    throw new Error(`unexpected request ${url}`);
  });
  t.mock.method(console, 'error', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1',
    reconnectIntervalMs: 5, timeoutMs: 120 });
  t.after(async () => { await adapter.stop(); });
  await adapter.start(() => {});
  await waitFor(() => streams >= 2 && adapter.getStatus().lastError !== undefined,
    'repeated bounded error bodies', 5000);
  assert.match(adapter.getStatus().lastError, /HTTP 429/);
  assert.ok(bodyCancelled >= 1, 'the error body reader is cancelled');
  // A still-trickling body must not delay shutdown.
  const started = Date.now();
  await adapter.stop();
  assert.ok(Date.now() - started < 1000, 'stop never waits on an error body');
});

test('startup retries revalidate the account and reset the cutoff only on a real change', async (t) => {
  const attempts = [];
  let accountReads = 0;
  let threadFails = 2;
  const opened = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      accountReads += 1;
      // The signed-in username changes on the third read, as after a re-login.
      return json(account('acct-1', true, accountReads < 3 ? 'wxid_bot' : 'wxid_new_login'));
    }
    if (url.includes('/threads?')) {
      attempts.push(Date.now());
      if (threadFails-- > 0) {
        return new Response('{}', { status: 500 });
      }
      return json({ items: [], nextCursor: null, asOfEventCursor: '90' });
    }
    if (url.includes('/events/stream')) {
      opened.push(String(url));
      return streamResponse(options.signal).response;
    }
    throw new Error(`unexpected request ${url}`);
  });
  t.mock.method(console, 'error', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1', reconnectIntervalMs: 5 });
  t.after(async () => { await adapter.stop(); });
  await adapter.start(() => {});
  const startedAt = adapter.startedAt;
  await waitFor(() => opened.length === 1, 'stream after startup retries', 5000);
  assert.ok(accountReads >= 3, 'every startup retry revalidates the account');
  assert.equal(adapter.selfUsername, 'wxid_new_login', 'a re-login during startup is adopted');
  assert.ok(adapter.startedAt >= startedAt, 'an identity change resets the startup cutoff');
  assert.match(opened[0], /after=90$/, 'the fresh snapshot high-water is used');
  const gaps = attempts.slice(1).map((time, index) => time - attempts[index]);
  // Scheduling jitter dominates single-digit millisecond waits, so require a gap beyond
  // one base interval instead of pairwise ordering of two adjacent measurements.
  assert.ok(Math.max(...gaps) >= 8, `startup retries back off: ${gaps.join(',')}`);
  assert.ok(adapter.getStatus().consecutiveFailures >= 2);
});

test('an unauthenticated retry backs off instead of spinning', async (t) => {
  let accountReads = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      accountReads += 1;
      return json(account('acct-1', accountReads === 1));
    }
    if (url.includes('/threads?')) {
      return json({ items: [], nextCursor: null, asOfEventCursor: '0' });
    }
    if (url.includes('/events/stream')) {
      // Immediate EOF, so every attempt revalidates the account.
      return new Response('', { headers: { 'Content-Type': 'text/event-stream' } });
    }
    throw new Error(`unexpected request ${url}`);
  });
  t.mock.method(console, 'error', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1', reconnectIntervalMs: 30 });
  t.after(async () => { await adapter.stop(); });
  await adapter.start(() => {});
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(accountReads < 10, `revalidation is bounded, saw ${accountReads} reads`);
  assert.match(adapter.getStatus().lastError, /not authenticated/);
  const started = Date.now();
  await adapter.stop();
  assert.ok(Date.now() - started < 1000, 'stop is prompt during account backoff');
});

test('an oversized stream error body is consumed only up to its cap', async (t) => {
  const streams = [];
  let released = 0;
  let cancelled = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1', true, 'wxid_bot'));
    }
    if (url.includes('/threads?')) {
      return json({ items: [], nextCursor: null, asOfEventCursor: '60' });
    }
    if (url.includes('/events/stream')) {
      streams.push(String(url));
      if (streams.length === 1) {
        // A far larger body than the cap, produced only as the consumer pulls.
        const chunk = new Uint8Array(8_192).fill(0x78);
        const body = new ReadableStream({
          pull(controller) {
            if (released > 400_000) {
              controller.close();
              return;
            }
            released += chunk.byteLength;
            controller.enqueue(chunk);
          },
          cancel() { cancelled += 1; }
        });
        options.signal?.addEventListener('abort', () => {}, { once: true });
        return new Response(body, { status: 500 });
      }
      return streamResponse(options.signal).response;
    }
    throw new Error(`unexpected request ${url}`);
  });
  t.mock.method(console, 'error', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1', reconnectIntervalMs: 5 });
  t.after(async () => { await adapter.stop(); });
  await adapter.start(() => {});
  await waitFor(() => streams.length >= 2, 'reconnect after the oversized error body', 4000);
  assert.equal(cancelled, 1, 'the error body reader is cancelled');
  assert.ok(released > 0 && released < 65_536,
    `consumption stops at the cap, released ${released} bytes of 400,000`);
  assert.ok(streams.every((url) => url.endsWith('after=60')),
    `the checkpoint is unchanged: ${streams.join(',')}`);
  assert.match(adapter.getStatus().lastError, /HTTP 500/);
});

test('stop during a stalled stream error body completes promptly', async (t) => {
  let streams = 0;
  let cancelled = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1', true, 'wxid_bot'));
    }
    if (url.includes('/threads?')) {
      return json({ items: [], nextCursor: null, asOfEventCursor: '65' });
    }
    if (url.includes('/events/stream')) {
      streams += 1;
      // One byte, then nothing forever: neither the body nor its cancel can finish.
      const body = new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode('{')); },
        cancel() { cancelled += 1; }
      });
      options.signal?.addEventListener('abort', () => {}, { once: true });
      return new Response(body, { status: 503 });
    }
    throw new Error(`unexpected request ${url}`);
  });
  t.mock.method(console, 'error', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1',
    reconnectIntervalMs: 5, timeoutMs: 60_000 });
  await adapter.start(() => {});
  await waitFor(() => streams === 1, 'stalled error body', 4000);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const started = Date.now();
  await adapter.stop();
  assert.ok(Date.now() - started < 1000,
    'stop never waits on the error body deadline or its cancel');
  assert.equal(cancelled, 1, 'the stalled reader is still cancelled');
  assert.equal(streams, 1, 'no reconnect after stop');
});

test('a bare CR ends a frame at the end of a chunk without another chunk', async (t) => {
  const received = [];
  let stream;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1', true, 'wxid_bot'));
    }
    if (url.includes('/threads?')) {
      return json({ items: [], nextCursor: null, asOfEventCursor: '40' });
    }
    if (url.includes('/events/stream')) {
      stream = streamResponse(options.signal);
      return stream.response;
    }
    if (url.includes('/messages/')) {
      return json(native(decodeURIComponent(url.split('/messages/')[1])));
    }
    if (url.includes('/contacts/')) {
      return json({ displayName: 'Alice' });
    }
    throw new Error(`unexpected request ${url}`);
  });
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1' });
  t.after(async () => { await adapter.stop(); });
  await adapter.start((incoming) => received.push(incoming));
  await waitFor(() => stream !== undefined, 'event stream');

  const payload = JSON.stringify({ cursor: '41', kind: 'message.committed',
    data: { messageId: 'm-crlf', threadId: 'wxid_alice' }, createdAt: new Date().toISOString() });
  // The blank line that dispatches the frame is a lone CR at the chunk end.
  stream.push(`id: 41\r\ndata: ${payload}\r\n\r`);

  await waitFor(() => adapter.after === '41' && received.length === 1,
    'bare CR terminated a complete frame', 2000);
  assert.equal(received[0].messages[0].id, 'message:m-crlf');

  // A following LF (the second half of that CRLF) must not corrupt the next frame.
  stream.push(`\nid: 42\ndata: ${JSON.stringify({ cursor: '42', kind: 'thread.updated',
    data: { threadId: 'wxid_alice' }, createdAt: new Date().toISOString() })}\n\n`);
  await waitFor(() => adapter.after === '42', 'next frame after a split CRLF');
  assert.equal(received.length, 1, 'an irrelevant event still checkpoints');
});

test('a response for a different daemon account is rejected by the captured origin', async (t) => {
  const adapter = send(new WechatMessagerAdapter('token', { accountId: 'acct-1' }));
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify(intent('accepted', { accountId: 'acct-2' }))));
  await assert.rejects(adapter.reply(message, { text: 'Hi' }), /Unexpected WeChat send response/);
});
test('a committed event whose row is gone is skipped without stalling later events', async (t) => {
  const received = [];
  const reads = [];
  const recent = new Date(Date.now() + 60_000).toISOString();
  let opens = 0;
  let stream;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1', true, 'wxid_bot'));
    }
    if (url.includes('/threads?')) {
      return json({ items: [], nextCursor: null, asOfEventCursor: '10' });
    }
    if (url.includes('/events/stream')) {
      opens += 1;
      stream = streamResponse(options.signal);
      return stream.response;
    }
    if (url.includes('/messages/')) {
      const id = decodeURIComponent(url.split('/messages/')[1]);
      reads.push(id);
      if (id === 'm-404') {
        return new Response('{}', { status: 404 });
      }
      if (id === 'm-410') {
        return new Response('{}', { status: 410 });
      }
      return json(native(id, { createdAt: recent }));
    }
    if (url.includes('/contacts/')) {
      return json({ displayName: 'Alice' });
    }
    throw new Error(`unexpected request ${url}`);
  });
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1', reconnectIntervalMs: 5 });
  t.after(() => adapter.stop());
  await adapter.start((incoming) => received.push(incoming));
  await waitFor(() => opens === 1 && adapter.after === '10', 'event stream');

  // All three events arrive in one chunk; the deleted rows cannot block the healthy one.
  stream.push(frame('11', 'message.committed', { messageId: 'm-404', threadId: 'wxid_alice' }) +
    frame('12', 'message.committed', { messageId: 'm-ok', threadId: 'wxid_alice' }) +
    frame('13', 'message.committed', { messageId: 'm-410', threadId: 'wxid_alice' }));
  await waitFor(() => adapter.after === '13' && received.length === 1, 'later events after skips');
  assert.deepEqual(received[0].messages.map((entry) => entry.id), ['message:m-ok']);
  assert.equal(adapter.getStatus().consecutiveFailures, 0,
    'an intentional skip is not a stream failure');
  assert.ok(adapter.getStatus().lastEventAt, 'the skipped events still count as handled');

  // The deleted IDs are remembered, so a replay with a newer cursor is not read again.
  stream.push(frame('14', 'message.committed', { messageId: 'm-404', threadId: 'wxid_alice' }));
  await waitFor(() => adapter.after === '14', 'replayed deleted event');
  assert.deepEqual(reads, ['m-404', 'm-ok', 'm-410'], 'a handled skip is not read twice');
  assert.equal(opens, 1, 'the stream never reconnected');
});
