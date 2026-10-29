const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ModelRegistry } = require('../src/models/runtime');
const modelStore = require('../src/models/model-store');
const credentials = require('../src/models/credentials');
const { MAX_MODEL_TOOL_CALLS } = require('../src/limit');
const { createResponse, extractCitations } = require('../src/models/responses-client');
const { ModelReplier } = require('../src/repliers/model');
const { ModelFilter } = require('../src/filters/model');
const { FilterOutcome } = require('../src/filters/interface');
const { countTokens } = require('../src/models/tokens');
const { ChatServer } = require('../src/server');
const { registerMessager } = require('../src/messagers/registry');

const apiTools = [{ type: 'web_search', filters: { allowed_domains: ['example.com'] } }];
const message = { id: 'message:1', text: 'What happened today?', senderId: 'sender' };
const reply = JSON.stringify({ reply: true, text: 'An update.', memoryUpdates: { notes: [], forget: [] } });
const textItem = (text, annotations = []) => ({ type: 'message', content: [{ type: 'output_text', text, annotations }] });
const functionCall = (id) => ({ type: 'function_call', call_id: id, name: 'calculate', arguments: '{}' });

async function fixture(t, respond, timeoutMs = 1000) {
  t.mock.method(modelStore, 'loadModels', async () => ({ version: 1, providers: [{
    provider: 'fixture', baseUrl: 'http://fixture.local/v1', timeoutMs, models: [{ id: 'model', name: 'model' }]
  }] }));
  t.mock.method(credentials, 'getModelApiKey', async () => 'fixture-key');
  const requests = [];
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'http://fixture.local/v1/responses');
    const request = JSON.parse(options.body);
    requests.push(request);
    const output = await respond(request, requests.length, options.signal);
    return new Response(JSON.stringify(output), { status: 200 });
  });
  const model = (await ModelRegistry.load('/unused', ['fixture/model'])).get('fixture/model');
  let localCalls = 0;
  const localTool = {
    definition: { type: 'function', name: 'calculate', description: 'Fixture',
      parameters: { type: 'object', properties: {}, additionalProperties: false }, strict: true },
    execute: async () => { localCalls += 1; return 42; }
  };
  return { model, requests, fetch, localTool, localCalls: () => localCalls };
}

test('both empty tool lists omit tools and hosted-only requests forward definitions', async (t) => {
  const f = await fixture(t, () => ({ output: [textItem('Done')] }));
  assert.equal(await f.model.generate('Hi', 'Answer', undefined, { localTools: [], apiTools: [] }), 'Done');
  assert.equal(f.requests[0].tools, undefined);
  assert.equal(f.requests[0].max_tool_calls, undefined);
  assert.equal(await f.model.generate('Hi', 'Answer', undefined, { localTools: [], apiTools }), 'Done');
  assert.deepEqual(f.requests[1].tools, apiTools);
  assert.equal(f.requests[1].tool_choice, 'auto');
  assert.equal(f.requests[1].max_tool_calls, MAX_MODEL_TOOL_CALLS);
  assert.equal(f.requests[1].store, false);
  assert.deepEqual(f.requests[1].include, ['reasoning.encrypted_content']);
});

test('hosted type strings expand to objects while explicit provider options are preserved', async (t) => {
  const f = await fixture(t, () => ({ output: [textItem('Done')] }));
  const selections = ['web_search', { type: 'file_search', vector_store_ids: ['vs-fixture'] }];
  const original = structuredClone(selections);
  assert.equal(await f.model.generate('Hi', 'Answer', undefined, { apiTools: selections }), 'Done');
  assert.deepEqual(f.requests[0].tools, [
    { type: 'web_search' }, { type: 'file_search', vector_store_ids: ['vs-fixture'] }
  ]);
  assert.deepEqual(selections, original);
});

test('mixed tool rounds preserve reasoning and hosted calls and execute only local functions', async (t) => {
  const hosted = { type: 'web_search_call', id: 'search-1', status: 'completed', action: { type: 'search' } };
  const reasoning = { type: 'reasoning', id: 'reason-1', encrypted_content: 'encrypted' };
  const initialOutput = [reasoning, hosted, functionCall('local-1')];
  const f = await fixture(t, (_request, round) => ({ output: round === 1 ? initialOutput : [textItem('42')] }));
  assert.equal(await f.model.generate('Hi', 'Answer', undefined, { localTools: [f.localTool], apiTools }), '42');
  assert.equal(f.localCalls(), 1);
  assert.deepEqual(f.requests[0].tools, [f.localTool.definition, ...apiTools]);
  assert.deepEqual(f.requests[1].input.slice(1, 4), initialOutput);
  assert.deepEqual(f.requests[1].input[4], { type: 'function_call_output', call_id: 'local-1',
    output: JSON.stringify({ ok: true, result: 42 }) });
  assert.equal(f.requests[1].max_tool_calls, MAX_MODEL_TOOL_CALLS - 1);
});

test('local-only requests keep function calling without the hosted request parameter', async (t) => {
  const f = await fixture(t, (_request, round) => ({ output: round === 1 ? [functionCall('local-1')] : [textItem('42')] }));
  assert.equal(await f.model.generate('Hi', 'Answer', undefined, { localTools: [f.localTool] }), '42');
  assert.equal(f.localCalls(), 1);
  assert.ok(f.requests.every((request) => request.max_tool_calls === undefined));
});

test('exhausted hosted budget removes hosted tools while local calls can continue', async (t) => {
  const hosted = Array.from({ length: MAX_MODEL_TOOL_CALLS }, (_, index) => ({
    type: 'web_search_call', id: `search-${index}`, status: 'completed'
  }));
  const f = await fixture(t, (_request, round) => ({ output: round === 1
    ? [...hosted, functionCall('local-1')] : [textItem('Done')] }));
  await f.model.generate('Hi', 'Answer', undefined, { localTools: [f.localTool], apiTools });
  assert.deepEqual(f.requests[1].tools, [f.localTool.definition]);
  assert.equal(f.requests[1].max_tool_calls, undefined);
  assert.equal(f.requests[1].tool_choice, 'auto');
});

test('exhausted local budget still permits hosted tools on the final round', async (t) => {
  const f = await fixture(t, (_request, round) => ({ output: round <= MAX_MODEL_TOOL_CALLS
    ? [functionCall(`local-${round}`)] : [{ type: 'web_search_call', id: 'search-final' }, textItem('Done')] }));
  assert.equal(await f.model.generate('Hi', 'Answer', undefined, { localTools: [f.localTool], apiTools }), 'Done');
  assert.equal(f.localCalls(), MAX_MODEL_TOOL_CALLS);
  assert.deepEqual(f.requests.at(-1).tools, apiTools);
});

test('a provider exceeding the hosted budget fails without executing local calls', async (t) => {
  const f = await fixture(t, () => ({ output: [
    ...Array.from({ length: MAX_MODEL_TOOL_CALLS + 1 }, (_, index) => ({ type: 'web_search_call', id: `search-${index}` })),
    functionCall('local-1')
  ] }));
  await assert.rejects(f.model.generate('Hi', 'Answer', undefined, { localTools: [f.localTool], apiTools }), /hosted tool call budget/);
  assert.equal(f.localCalls(), 0);
  assert.equal(f.fetch.mock.callCount(), 1);
});

test('hosted responses requiring client execution or approval fail explicitly', async (t) => {
  for (const item of [{ type: 'mcp_approval_request', id: 'approval-1' },
    { type: 'computer_call' }, { type: 'custom_tool_call' },
    { type: 'tool_search_call', execution: 'client' }]) {
    const f = await fixture(t, () => ({ output: [item, textItem('Waiting for your action')] }));
    await assert.rejects(f.model.generate('Hi', 'Answer', undefined, { apiTools }), /unsupported client execution or approval/);
    assert.equal(f.fetch.mock.callCount(), 1);
  }
});

test('hosted definitions count toward the input budget before making a request', async (t) => {
  const f = await fixture(t, () => assert.fail('No request expected'));
  await assert.rejects(f.model.generate('Hi', 'Answer', undefined, {
    apiTools: [{ type: 'web_search', description: 'tool options '.repeat(70000) }]
  }), /input exceeds/);
  assert.equal(f.fetch.mock.callCount(), 0);
});

test('programmatic function definitions cannot be smuggled through apiTools', async (t) => {
  const f = await fixture(t, () => assert.fail('No request expected'));
  await assert.rejects(f.model.generate('Hi', 'Answer', undefined, { apiTools: [{ type: 'function' }] }), /use registered localTools/);
  assert.equal(f.fetch.mock.callCount(), 0);
});

test('provider validation failures propagate without falling back to local tools', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('Unsupported hosted tool', { status: 400 }));
  await assert.rejects(createResponse({ baseUrl: 'http://fixture.local/v1', model: 'fixture', apiKey: 'key',
    input: 'Hi', tools: apiTools }), (error) => error.status === 400 && error.body === 'Unsupported hosted tool');
  assert.equal(fetch.mock.callCount(), 1);
});

test('cancellation aborts a hosted-only generation without retries', async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, (_request, _round, signal) => {
    controller.abort();
    signal.throwIfAborted();
  });
  await assert.rejects(f.model.generate('Hi', 'Answer', controller.signal, { apiTools }), /cancelled/);
  assert.equal(f.fetch.mock.callCount(), 1);
});

test('URL citation annotations are deduplicated and unsafe or malformed links are skipped', () => {
  assert.deepEqual(extractCitations({ output: [textItem('Answer', [
    { type: 'url_citation', url: 'https://example.com/source' },
    { type: 'url_citation', url: 'https://example.com/source' },
    { type: 'url_citation', url: 'javascript:alert(1)' },
    { type: 'url_citation', url: 'https://user:secret@example.com/' },
    { type: 'url_citation', url: 'invalid' },
    { type: 'file_citation', file_id: 'file-1' }
  ])] }), [{ url: 'https://example.com/source' }]);
});

test('hosted citation links reach outgoing replies, including after tool-free formatting repair', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const repair of [false, true]) {
    const f = await fixture(t, (_request, round) => ({ output: [textItem(
      repair && round === 1 ? 'malformed reply' : reply,
      round === 1 ? [{ type: 'url_citation', url: 'https://example.com/source' }] : []
    )] }));
    const replier = new ModelReplier(f.model, [], undefined, undefined, false, apiTools);
    const result = await replier.replyTo(message, FilterOutcome.Optional);
    assert.match(result.reply.text, /An update\. https:\/\/example.com\/source$/);
    assert.ok(countTokens(result.reply.text) <= 200);
    assert.deepEqual(f.requests[0].tools, apiTools);
    assert.match(f.requests[0].instructions, /Preserve any citations required by provider-hosted tools/);
    if (repair) {
      assert.equal(f.requests[1].tools, undefined);
      assert.equal(f.requests[1].max_tool_calls, undefined);
    }
  }
});

test('citations from a hosted search survive subsequent local tool rounds', async (t) => {
  const f = await fixture(t, (_request, round) => ({ output: round === 1 ? [
    { type: 'web_search_call', id: 'search-1' },
    textItem('A sourced observation', [{ type: 'url_citation', url: 'https://example.com/source' }]),
    functionCall('local-1')
  ] : [textItem(reply)] }));
  const result = await new ModelReplier(f.model, [f.localTool], undefined, undefined, false, apiTools)
    .replyTo(message, FilterOutcome.Optional);
  assert.match(result.reply.text, /https:\/\/example.com\/source$/);
  assert.equal(f.localCalls(), 1);
});

test('chat construction passes independent local and hosted settings to the replier', async (t) => {
  registerMessager('api-tools-fixture', () => ({ name: 'fixture', start() {}, reply() {} }));
  const f = await fixture(t, () => ({ output: [textItem(reply)] }));
  const server = new ChatServer({ chats: [{
    messager: { name: 'api-tools-fixture', replier: 'fixture/model',
      localTools: [{ type: 'calculate' }, 'calculate'], apiTools: ['web_search'] }, filters: []
  }] }, '/unused');
  const [chat] = server.buildChats({ get: () => f.model });
  await chat.replier.replyTo(message, FilterOutcome.Optional);
  assert.equal(f.requests[0].tools[0].type, 'function');
  assert.equal(f.requests[0].tools[0].name, 'calculate');
  assert.deepEqual(f.requests[0].tools.slice(1), [{ type: 'web_search' }]);
});

test('filters sharing the reply model receive neither local nor hosted tools', async (t) => {
  const f = await fixture(t, (_request, round) => ({ output: [textItem(round === 1 ? reply : 'allowed')] }));
  await new ModelReplier(f.model, [], undefined, undefined, false, apiTools).replyTo(message, FilterOutcome.Optional);
  assert.equal(await new ModelFilter(f.model).shouldReply(message), FilterOutcome.Allowed);
  assert.equal(f.requests[1].tools, undefined);
  assert.deepEqual(f.requests[1].reasoning, { effort: 'none' });
});

test('citation links survive local truncation and excessively long citations stop delivery', async () => {
  const makeReplier = (url) => new ModelReplier({ generate: async (_input, _instructions, _signal, options) => {
    options.onCitations([{ url }]);
    return JSON.stringify({ reply: true, text: 'A detailed answer. '.repeat(200), memoryUpdates: { notes: [], forget: [] } });
  } }, [], undefined, undefined, false, apiTools);
  const result = await makeReplier('https://example.com/source').replyTo(message, FilterOutcome.Optional);
  assert.ok(result.reply.text.endsWith('https://example.com/source'));
  assert.ok(countTokens(result.reply.text) <= 200);
  await assert.rejects(makeReplier('https://example.com/' + 'source/'.repeat(500)).replyTo(message, FilterOutcome.Optional),
    /citations exceed the reply token budget/);
});
