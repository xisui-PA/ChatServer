const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ModelReplier } = require('../src/repliers/model');
const { FilterOutcome } = require('../src/filters/interface');
const { limitReplyText } = require('../src/repliers/limits');

const message = { id: 'message:1', text: 'Hello', senderId: 'sender', channel: 'chat' };
const validReply = { reply: true, text: 'Hello!', memoryUpdates: { notes: [], forget: [] } };
const json = (overrides) => JSON.stringify({ ...validReply, ...overrides });

const malformed = [
  ['invalid JSON', 'plain text'],
  ['empty output', ''],
  ['Markdown fences', '```json\n' + json() + '\n```'],
  ['null output', 'null'],
  ['array output', '[]'],
  ['missing reply fields', '{}'],
  ['invalid reply type', json({ reply: 'true' })],
  ['invalid text type', json({ text: 42 })],
  ['empty reply', json({ text: '' })],
  ['whitespace reply', json({ text: ' \n ' })],
  ['missing memory', JSON.stringify({ reply: true, text: 'Hello!' })],
  ['null memory', json({ memoryUpdates: null })],
  ['missing memory arrays', json({ memoryUpdates: {} })],
  ['invalid forget ID', json({ memoryUpdates: { notes: [], forget: [1] } })],
  ['invalid note', json({ memoryUpdates: { notes: [{ kind: 'summary|fact', text: 'Hello', sourceIds: ['message:1'] }], forget: [] } })],
  ['missing note sources', json({ memoryUpdates: { notes: [{ kind: 'summary', text: 'Hello', sourceIds: [] }], forget: [] } })],
  ['invalid memory on silent reply', json({ reply: false, text: '', memoryUpdates: {} })]
];

for (const [name, output] of malformed) {
  test(`${name} is logged and repaired once without tools`, async (t) => {
    const warnings = t.mock.method(console, 'warn', () => {});
    const calls = [];
    const controller = new AbortController();
    const tools = [{ definition: { name: 'web_search' } }];
    const model = { generate: async (...args) => {
      calls.push(args);
      assert.ok(calls.length <= 2);
      return calls.length === 1 ? output : json();
    } };
    const result = await new ModelReplier(model, tools).replyTo(message, FilterOutcome.Optional, controller.signal);
    assert.deepEqual(result, { reply: { text: 'Hello!', channel: 'chat' }, memoryUpdates: validReply.memoryUpdates });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0][3].tools, tools);
    assert.deepEqual(calls[1][3].tools, []);
    assert.equal(calls[1][2], controller.signal);
    const repair = JSON.parse(calls[1][0]);
    assert.deepEqual(Object.keys(repair), ['output', 'validationError']);
    assert.equal(repair.output, output);
    assert.equal(repair.validationError, warnings.mock.calls[0].arguments[1]);
    assert.match(calls[1][1], /Preserve the intended reply and valid fields/);
    assert.match(calls[1][1], /Return only JSON/);
    assert.match(calls[1][1], /sourceIds/);
    assert.doesNotMatch(calls[1][1], /You are a helpful chat assistant|Use tools for|Filters require|Reply only if useful/);
    assert.equal(warnings.mock.calls.length, 2);
    assert.equal(warnings.mock.calls[1].arguments[1], output);
  });
}

test('a malformed repair is logged and rejected without another attempt', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const outputs = ['first bad output', json({ text: ' ' })];
  let calls = 0;
  const model = { generate: async () => {
    assert.ok(calls < 2);
    return outputs[calls++];
  } };
  await assert.rejects(new ModelReplier(model).replyTo(message, FilterOutcome.Allowed), /empty reply/);
  assert.equal(calls, 2);
  assert.deepEqual(warnings.mock.calls.filter((_, index) => index % 2 === 1).map((call) => call.arguments[1]), outputs);
});

test('a repaired reply retains memory and still respects the local hard limit', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const text = 'A lengthy reply. '.repeat(200);
  const memoryUpdates = { notes: [{ kind: 'fact', text: 'The sender said hello.', sourceIds: ['message:1'] }], forget: [] };
  let calls = 0;
  const model = { generate: async () => ++calls === 1 ? 'bad JSON' : json({ text, memoryUpdates }) };
  const result = await new ModelReplier(model).replyTo(message, FilterOutcome.Optional);
  assert.equal(result.reply.text, limitReplyText(text));
  assert.deepEqual(result.memoryUpdates, memoryUpdates);
  assert.equal(calls, 2);
});

test('a reformat request can return a valid silent result', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  const model = { generate: async () => ++calls === 1 ? 'bad JSON' : json({ reply: false, text: '' }) };
  const result = await new ModelReplier(model).replyTo(message, FilterOutcome.Optional);
  assert.deepEqual(result, { memoryUpdates: validReply.memoryUpdates });
  assert.equal(calls, 2);
});

test('cancellation after malformed output prevents reformatting', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const controller = new AbortController();
  let calls = 0;
  const model = { generate: async () => {
    calls++;
    controller.abort();
    return 'bad JSON';
  } };
  await assert.rejects(new ModelReplier(model).replyTo(message, FilterOutcome.Optional, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.equal(warnings.mock.calls[1].arguments[1], 'bad JSON');
});

test('provider failures are propagated without being treated as malformed replies', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const failure = new Error('provider unavailable');
  let calls = 0;
  const model = { generate: async () => {
    calls++;
    throw failure;
  } };
  await assert.rejects(new ModelReplier(model).replyTo(message, FilterOutcome.Optional), (error) => error === failure);
  assert.equal(calls, 1);
  assert.equal(warnings.mock.calls.length, 0);
});

test('a failed reformat request does not start another repair', async (t) => {
  const warnings = t.mock.method(console, 'warn', () => {});
  const failure = new Error('provider unavailable during repair');
  let calls = 0;
  const model = { generate: async () => {
    if (++calls === 1) {
      return 'bad JSON';
    }
    throw failure;
  } };
  await assert.rejects(new ModelReplier(model).replyTo(message, FilterOutcome.Optional), (error) => error === failure);
  assert.equal(calls, 2);
  assert.equal(warnings.mock.calls[1].arguments[1], 'bad JSON');
});
