const assert = require('node:assert/strict');
const { test } = require('node:test');
const timers = require('node:timers/promises');
const { ResponsesApiError, createResponse } = require('../src/models/responses-client');
const { withModelRetries } = require('../src/models/retry');
const { ModelRegistry } = require('../src/models/runtime');
const modelStore = require('../src/models/model-store');
const credentials = require('../src/models/credentials');

/** Records waits without sleeping or contacting any real server. */
function recordWaits(t) {
  const waits = [];
  t.mock.method(timers, 'setTimeout', async (ms) => { waits.push(ms); });
  return waits;
}

test('a generation can recover on the third retry, with ten-second waits', async (t) => {
  const waits = recordWaits(t);
  let attempts = 0;
  const result = await withModelRetries(async () => {
    attempts += 1;
    if (attempts < 4) {
      throw new ResponsesApiError('Temporary failure', 503);
    }
    return 'Recovered';
  });
  assert.equal(result, 'Recovered');
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [10000, 10000, 10000]);
});

test('exhausted retries return the final error after four total attempts', async (t) => {
  const waits = recordWaits(t);
  const error = new ResponsesApiError('Network failure');
  let attempts = 0;
  await assert.rejects(withModelRetries(async () => {
    attempts += 1;
    throw error;
  }), (failure) => failure === error);
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [10000, 10000, 10000]);
});

test('permanent HTTP errors and malformed results do not retry', async (t) => {
  const waits = recordWaits(t);
  for (const error of [new ResponsesApiError('Unauthorized', 401), new ResponsesApiError('Invalid JSON', 200), new Error('Invalid output')]) {
    let attempts = 0;
    await assert.rejects(withModelRetries(async () => {
      attempts += 1;
      throw error;
    }), (failure) => failure === error);
    assert.equal(attempts, 1);
  }
  assert.deepEqual(waits, []);
});

test('cancellation during the retry wait stops further attempts', async (t) => {
  const controller = new AbortController();
  let attempts = 0;
  t.mock.method(timers, 'setTimeout', async (ms, _value, options) => {
    assert.equal(ms, 10000);
    assert.equal(options.signal, controller.signal);
    controller.abort();
    options.signal.throwIfAborted();
  });
  await assert.rejects(withModelRetries(async () => {
    attempts += 1;
    throw new ResponsesApiError('Temporary failure');
  }, controller.signal), { name: 'AbortError' });
  assert.equal(attempts, 1);
});

test('an already cancelled generation makes no attempt', async () => {
  const controller = new AbortController();
  controller.abort();
  let attempts = 0;
  await assert.rejects(withModelRetries(async () => { attempts += 1; }, controller.signal), { name: 'AbortError' });
  assert.equal(attempts, 0);
});

test('individual HTTP calls use native fetch with no separate retry loop', async (t) => {
  const waits = recordWaits(t);
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.dispatcher, undefined);
    assert.equal(options.headers.Connection, undefined);
    throw new TypeError('fetch failed');
  });
  await assert.rejects(createResponse({
    baseUrl: 'http://fixture.local/v1', model: 'fixture', apiKey: 'fixture-key', input: 'Hello'
  }), /fetch failed/);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(waits, []);
});

test('a failed tool round restarts the complete generation rather than retrying that HTTP round', async (t) => {
  const waits = recordWaits(t);
  t.mock.method(modelStore, 'loadModels', async () => ({
    version: 1,
    providers: [{ provider: 'fixture', baseUrl: 'http://fixture.local/v1', timeoutMs: 1000, models: [{ id: 'model', name: 'model' }] }]
  }));
  t.mock.method(credentials, 'getModelApiKey', async () => 'fixture-key');
  const inputs = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    inputs.push(JSON.parse(options.body).input);
    if (inputs.length === 2) {
      throw new TypeError('fetch failed');
    }
    return new Response(JSON.stringify(inputs.length === 1 ? {
      output: [{ type: 'function_call', call_id: 'call-1', name: 'fixture_tool', arguments: '{}' }]
    } : {
      output_text: 'Recovered', output: []
    }), { status: 200 });
  });
  let toolCalls = 0;
  const registry = await ModelRegistry.load('/unused', ['fixture/model']);
  const result = await registry.get('fixture/model').generate('Hello', 'Reply briefly', undefined, { localTools: [{
    definition: { type: 'function', name: 'fixture_tool', description: 'Fixture tool', parameters: { type: 'object', properties: {} }, strict: true },
    execute: async () => { toolCalls += 1; return 'Fixture result'; }
  }] });
  assert.equal(result, 'Recovered');
  assert.equal(toolCalls, 1);
  assert.equal(inputs.length, 3);
  assert.equal(inputs[1].some((item) => item.type === 'function_call_output'), true);
  assert.deepEqual(inputs[2], inputs[0]);
  assert.deepEqual(waits, [10000]);
});
