const assert = require('node:assert/strict');
const { test } = require('node:test');
const { WechatMessagerAdapter } = require('../src/messagers/wechat');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');
const encoder = new TextEncoder();
const account = (id, ownUsername = 'wxid_bot') => ({ id, authenticated: true, ownUsername });
const incoming = {
  senderId: 'wxid_alice',
  channel: 'wxid_alice',
  text: 'Hello',
  metadata: { wechatAccount: 'acct-1', wechatUsername: 'wxid_bot' }
};
const intent = (state, extra = {}) => ({
  id: 'send-1', accountId: 'acct-1', destination: 'wxid_alice', state,
  errorCode: null, createdAt: new Date().toISOString(), ...extra
});
const job = (state, extra = {}) => ({
  id: 'job-1', jobId: 'job-1', accountId: 'acct-1', kind: 'send', state, phase: 'transfer',
  attempts: 1, cancelRequested: false, retryable: true, reason: null, assetId: 'asset-1',
  sourceId: 'source-1', threadId: 'wxid_alice', ...extra
});

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' }
});

const frame = (cursor, kind, data) => `id: ${cursor}\ndata: ${JSON.stringify({
  cursor, kind, data, createdAt: new Date().toISOString()
})}\n\n`;

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

/** Starts a real adapter over one mocked stream and records every request URL. */
async function start(t, { cursor = '10', send = async () => json(intent('queued')),
  readSend, readJob } = {}) {
  const calls = [];
  const streams = [];
  const counters = { cursors: 0, sendReads: 0, jobReads: 0, cancels: 0, posts: 0, uploads: 0 };
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method ?? 'GET' });
    if (href.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1'));
    }
    if (href.includes('/threads?limit=1')) {
      counters.cursors += 1;
      return json({ items: [], nextCursor: null, asOfEventCursor: cursor });
    }
    if (href.includes('/events/stream')) {
      const channel = streamResponse(options.signal);
      streams.push({ href, channel });
      return channel.response;
    }
    if (href.includes('/uploads')) {
      counters.uploads += 1;
      return json({ id: 'source-1', mediaType: 'image', name: 'image.png' });
    }
    if (href.endsWith('/sends') && (options.method ?? 'GET') === 'POST') {
      counters.posts += 1;
      return send(href, options, counters);
    }
    if (href.includes('/sends/send-1')) {
      if (href.endsWith('/cancel')) {
        counters.cancels += 1;
        return json({});
      }
      counters.sendReads += 1;
      return readSend === undefined ? json(intent('queued')) : readSend(counters);
    }
    if (href.includes('/jobs/job-1')) {
      if (href.endsWith('/cancel')) {
        counters.cancels += 1;
        return json({});
      }
      counters.jobReads += 1;
      return readJob === undefined ? json(job('queued')) : readJob(counters);
    }
    throw new Error(`unexpected request ${href}`);
  });
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1', reconnectIntervalMs: 5 });
  t.after(async () => { await adapter.stop(); });
  await adapter.start(() => {});
  await waitFor(() => streams.length === 1, 'initial event stream');
  return { adapter, calls, streams, counters };
}

test('startup reads one current cursor and never pages message history', async (t) => {
  const { streams, counters, calls } = await start(t);
  await waitFor(() => streams.length === 1, 'stream');
  assert.equal(counters.cursors, 1);
  assert.ok(streams[0].href.endsWith('after=10'), streams[0].href);
  assert.equal(calls.filter((call) => call.href.includes('/messages')).length, 0);
  assert.equal(calls.filter((call) => call.href.includes('/threads?') && call.href.includes('cursor=')).length, 0);
});

test('a queued text send completes on send.updated with one reconcile read and no polling', async (t) => {
  const { adapter, streams, counters } = await start(t);
  const reply = adapter.reply(incoming, { text: 'hello' });
  await waitFor(() => counters.posts === 1, 'text submission');
  await waitFor(() => counters.sendReads === 1, 'submission-race reconcile');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(counters.sendReads, 1, 'no interval polling');
  streams[0].channel.push(frame('11', 'send.updated', intent('accepted')));
  await reply;
  assert.equal(counters.cancels, 0);
});

test('a queued media send completes on job.updated and ignores media send.updated', async (t) => {
  const { adapter, streams, counters } = await start(t, { send: async () => json(job('queued')) });
  const reply = adapter.reply(incoming, {
    text: '',
    images: [{ data: png, filename: 'image.png', mimeType: 'image/png' }]
  });
  await waitFor(() => counters.posts === 1, 'media submission');
  await waitFor(() => counters.jobReads === 1, 'media reconcile');
  // The media send.updated payload is not a text SendIntent and must not settle a job.
  streams[0].channel.push(frame('11', 'send.updated', job('failed', { reason: 'wrong family' })));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(counters.cancels, 0);
  streams[0].channel.push(frame('12', 'job.updated', job('accepted')));
  await reply;
  assert.equal(counters.cancels, 0);
});

test('an event that races the POST response is reconciled by one status read', async (t) => {
  let release;
  const submitted = new Promise((resolve) => { release = resolve; });
  const { adapter, streams, counters } = await start(t, {
    send: async () => {
      await submitted;
      return json(intent('queued'));
    },
    readSend: () => json(intent('accepted'))
  });
  const reply = adapter.reply(incoming, { text: 'hello' });
  await waitFor(() => counters.posts === 1, 'text submission');
  // The terminal update arrives before the POST response exposes the send ID.
  streams[0].channel.push(frame('11', 'send.updated', intent('accepted')));
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  await reply;
  assert.equal(counters.sendReads, 1);
  assert.equal(counters.cancels, 0);
});

test('a stale status read cannot override a terminal SSE update', async (t) => {
  let release;
  let reading;
  const started = new Promise((resolve) => { reading = resolve; });
  const { adapter, streams, counters } = await start(t, {
    readSend: async () => {
      reading();
      await new Promise((resolve) => { release = resolve; });
      return json(intent('failed', { errorCode: 'stale' }));
    }
  });
  const reply = adapter.reply(incoming, { text: 'hello' });
  await waitFor(() => counters.sendReads === 1, 'status read started');
  await started;
  streams[0].channel.push(frame('11', 'send.updated', intent('accepted')));
  await reply;
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(counters.sendReads, 1);
  assert.equal(counters.cancels, 0, 'a latched acceptance is not cancelled');
});

test('unrelated IDs, accounts, threads, families, and media payloads never settle a text waiter', async (t) => {
  const { adapter, streams } = await start(t);
  const reply = adapter.reply(incoming, { text: 'hello' });
  await waitFor(() => streams.length === 1, 'stream');
  let settled = false;
  reply.then(() => { settled = true; }, () => { settled = true; });
  const events = [
    frame('11', 'send.updated', intent('accepted', { id: 'send-2' })),
    frame('12', 'send.updated', intent('accepted', { accountId: 'acct-2' })),
    frame('13', 'send.updated', intent('accepted', { destination: 'wxid_bob' })),
    frame('14', 'send.updated', job('accepted')),
    frame('15', 'job.updated', job('accepted', { id: 'send-1' })),
    frame('16', 'message.updated', { id: 'send-1' })
  ];
  streams[0].channel.push(events.join(''));
  await waitFor(() => adapter.after === '16', 'unrelated events checkpointed');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(settled, false, 'no unrelated event resolves the waiter');
  streams[0].channel.push(frame('17', 'send.updated', intent('accepted')));
  await reply;
});

test('terminal POST responses resolve or reject immediately without a status read', async (t) => {
  let response = intent('accepted');
  const { adapter, counters } = await start(t, { send: async () => json(response) });
  await adapter.reply(incoming, { text: 'accepted' });
  assert.equal(counters.sendReads, 0);
  response = intent('needs_review', { errorCode: 'review' });
  await assert.rejects(adapter.reply(incoming, { text: 'review' }), /needs_review/);
  assert.equal(counters.sendReads, 0);
  assert.equal(counters.cancels, 0);
});

test('caller abort and stop settle a pending waiter, cancel once, and never resend', async (t) => {
  const { adapter, counters } = await start(t);
  const controller = new AbortController();
  const aborted = adapter.reply(incoming, { text: 'hello' }, controller.signal);
  await waitFor(() => counters.sendReads === 1, 'reconcile read');
  controller.abort();
  await assert.rejects(aborted, /cancelled or exceeded/);
  assert.equal(counters.cancels, 1);
  assert.equal(counters.posts, 1);

  const stopped = adapter.reply(incoming, { text: 'stopped' });
  await waitFor(() => counters.posts === 2, 'second submission');
  await adapter.stop();
  await assert.rejects(stopped, /stopped|cancelled|confirmed/);
  assert.equal(counters.posts, 2, 'no automatic resend');
});

test('an account switch rejects pending senders without retrying them', async (t) => {
  let accountReads = 0;
  const calls = [];
  const streams = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const href = String(url);
    calls.push(href);
    if (href.endsWith('/v1/accounts/acct-1')) {
      accountReads += 1;
      return json(account('acct-1', accountReads === 1 ? 'wxid_bot' : 'wxid_new'));
    }
    if (href.includes('/threads?limit=1')) {
      return json({ items: [], nextCursor: null, asOfEventCursor: '10' });
    }
    if (href.includes('/events/stream')) {
      const channel = streamResponse(options.signal);
      streams.push(channel);
      return channel.response;
    }
    if (href.endsWith('/sends') && (options.method ?? 'GET') === 'POST') {
      return json(intent('queued'));
    }
    if (href.includes('/sends/send-1/cancel')) {
      return json({});
    }
    if (href.includes('/sends/send-1')) {
      return json(intent('queued'));
    }
    throw new Error(`unexpected request ${href}`);
  });
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1', reconnectIntervalMs: 5 });
  t.after(async () => { await adapter.stop(); });
  await adapter.start(() => {});
  await waitFor(() => streams.length === 1, 'stream');
  const reply = adapter.reply(incoming, { text: 'hello' });
  await waitFor(() => calls.some((href) => href.includes('/sends/send-1')), 'reconcile');
  streams[0].push(frame('11', 'account.updated', {}));
  await assert.rejects(reply, /account changed/);
  await waitFor(() => accountReads >= 2, 'account revalidation');
  assert.equal(calls.filter((href) => href.endsWith('/sends')).length, 1,
    'the POST is never repeated');
});

test('expired cursor rebases once at the current tail and reconciles pending once', async (t) => {
  let cursorReads = 0;
  let sendReads = 0;
  const opens = [];
  const streams = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const href = String(url);
    if (href.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1'));
    }
    if (href.includes('/threads?limit=1')) {
      cursorReads += 1;
      return json({ items: [], nextCursor: null, asOfEventCursor: cursorReads === 1 ? '10' : '20' });
    }
    if (href.includes('/events/stream')) {
      opens.push(href);
      const channel = streamResponse(options.signal);
      streams.push(channel);
      return channel.response;
    }
    if (href.endsWith('/sends') && (options.method ?? 'GET') === 'POST') {
      return json(intent('queued'));
    }
    if (href.includes('/sends/send-1/cancel')) {
      return json({});
    }
    if (href.includes('/sends/send-1')) {
      sendReads += 1;
      return json(intent('queued'));
    }
    throw new Error(`unexpected request ${href}`);
  });
  t.mock.method(console, 'warn', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1', reconnectIntervalMs: 5 });
  t.after(async () => { await adapter.stop(); });
  await adapter.start(() => {});
  await waitFor(() => streams.length === 1, 'initial stream');
  const reply = adapter.reply(incoming, { text: 'hello' });
  await waitFor(() => sendReads === 1, 'first reconcile');
  streams[0].push('event: error\ndata: {"error":{"code":"event_cursor_expired"}}\n\n');
  await waitFor(() => opens.length === 2, 'reconnect at the current tail');
  await waitFor(() => sendReads === 2, 'one reconcile on reconnect');
  assert.equal(cursorReads, 2, 'one tail lookup at startup and one after expiry');
  assert.ok(opens[0].endsWith('after=10'));
  assert.ok(opens[1].endsWith('after=20'));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(sendReads, 2, 'no interval polling');
  streams[1].push(frame('21', 'send.updated', intent('accepted')));
  await reply;
});

test('a reconnect supersedes a held status read so a skipped confirmation cannot strand the send', { timeout: 8000 }, async (t) => {
  let cursorReads = 0;
  let sendReads = 0;
  let releaseHeld;
  const counters = { cancels: 0 };
  const opens = [];
  const streams = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const href = String(url);
    if (href.endsWith('/v1/accounts/acct-1')) {
      return json(account('acct-1'));
    }
    if (href.includes('/threads?limit=1')) {
      cursorReads += 1;
      return json({ items: [], nextCursor: null, asOfEventCursor: cursorReads === 1 ? '10' : '20' });
    }
    if (href.includes('/events/stream')) {
      opens.push(href);
      const channel = streamResponse(options.signal);
      streams.push(channel);
      return channel.response;
    }
    if (href.endsWith('/sends') && (options.method ?? 'GET') === 'POST') {
      return json(intent('queued'));
    }
    if (href.includes('/sends/send-1/cancel')) {
      counters.cancels += 1;
      return json({});
    }
    if (href.includes('/sends/send-1')) {
      sendReads += 1;
      if (sendReads === 1) {
        // Held across the disconnect and ignores abort, like a stalled socket read. It
        // finishes only after the send is confirmed, with a stale terminal state.
        return new Promise((resolve) => {
          releaseHeld = () => resolve(json(intent('failed', { errorCode: 'stale' })));
        });
      }
      return json(intent('accepted'));
    }
    throw new Error(`unexpected request ${href}`);
  });
  t.mock.method(console, 'warn', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1', reconnectIntervalMs: 5 });
  t.after(async () => { await adapter.stop(); });
  await adapter.start(() => {});
  await waitFor(() => streams.length === 1, 'initial stream');
  const reply = adapter.reply(incoming, { text: 'hello' });
  await waitFor(() => sendReads === 1, 'held status read');
  // The accepted update falls into the window the daemon no longer retains.
  streams[0].push('event: error\ndata: {"error":{"code":"event_cursor_expired"}}\n\n');
  await waitFor(() => opens.length === 2, 'reconnect at the current tail');
  // The fresh read supersedes the held one and observes the acceptance.
  await reply;
  assert.equal(sendReads, 2, 'exactly one fresh read on reconnect');
  assert.ok(opens[1].endsWith('after=20'), opens[1]);
  // The abandoned read finishes last with a stale terminal state. It must not clobber
  // the latched acceptance or trigger a cancel of a delivered send.
  releaseHeld();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(counters.cancels, 0, 'the superseded read cannot cancel a delivered send');
  assert.equal(sendReads, 2, 'the superseded read issues no further request');
});

test('an identity change mid-stream drops queued old-login frames and tail-bootstraps', { timeout: 8000 }, async (t) => {
  let accountReads = 0;
  let cursorReads = 0;
  const opens = [];
  const streams = [];
  const messages = [];
  const received = [];
  const counters = { posts: 0, sendReads: 0, cancels: 0 };
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const href = String(url);
    if (href.endsWith('/v1/accounts/acct-1')) {
      accountReads += 1;
      // The account.updated frame reports a re-login on this same daemon account, and
      // every later revalidation keeps that new login.
      return json(account('acct-1', accountReads >= 2 ? 'wxid_new' : 'wxid_bot'));
    }
    if (href.includes('/threads?limit=1')) {
      cursorReads += 1;
      return json({ items: [], nextCursor: null, asOfEventCursor: cursorReads === 1 ? '10' : '30' });
    }
    if (href.includes('/events/stream')) {
      opens.push(href);
      const channel = streamResponse(options.signal);
      streams.push(channel);
      return channel.response;
    }
    if (href.includes('/messages/')) {
      messages.push(href);
      throw new Error('old-login frames must not be read');
    }
    if (href.endsWith('/sends') && (options.method ?? 'GET') === 'POST') {
      counters.posts += 1;
      return json(intent('queued'));
    }
    if (href.includes('/sends/send-1/cancel')) {
      counters.cancels += 1;
      return json({});
    }
    if (href.includes('/sends/send-1')) {
      counters.sendReads += 1;
      return json(intent('queued'));
    }
    throw new Error(`unexpected request ${href}`);
  });
  t.mock.method(console, 'error', () => {});
  const adapter = new WechatMessagerAdapter('token', { accountId: 'acct-1', reconnectIntervalMs: 5 });
  t.after(async () => { await adapter.stop(); });
  await adapter.start((message) => received.push(message));
  await waitFor(() => streams.length === 1, 'initial stream');
  // A send queued under the old login must be settled, never carried into the new one.
  const pendingSend = adapter.reply(incoming, { text: 'hello' });
  const rejected = assert.rejects(pendingSend, /account changed/);
  await waitFor(() => counters.posts === 1 && counters.sendReads === 1, 'old-login send waiting');
  // A message queued behind the account.updated frame on the old connection must not be
  // handed off under the new identity or become its checkpoint.
  streams[0].push(frame('11', 'account.updated', {}) +
    frame('12', 'message.committed', { messageId: 'm-old', threadId: 'wxid_alice' }));
  await waitFor(() => opens.length === 2, 'reconnect under the new login');
  assert.equal(adapter.selfUsername, 'wxid_new');
  assert.ok(opens[1].endsWith('after=30'), opens[1]);
  assert.equal(cursorReads, 2, 'the new login tail-bootstraps');
  assert.deepEqual(messages, [], 'no frame from the old reader is read');
  assert.deepEqual(received, []);
  await rejected;
  assert.equal(counters.posts, 1, 'the old login send is never resent under the new one');
  assert.equal(counters.cancels, 1, 'the abandoned send is cancelled exactly once');
});
