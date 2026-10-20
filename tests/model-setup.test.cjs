const assert = require('node:assert/strict');
const { test } = require('node:test');
const cli = require('../src/models/cli-support');
const credentials = require('../src/models/credentials');
const store = require('../src/models/model-store');
const { runAdd } = require('../src/models/add');
const { runUpdate } = require('../src/models/update');
const { setupBaseUrl } = require('../src/models/setup');

function fixture(t, { terminal = true, answers = [], secret = '', file } = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: terminal });
  const previousKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    if (descriptor === undefined) {
      delete process.stdin.isTTY;
    } else {
      Object.defineProperty(process.stdin, 'isTTY', descriptor);
    }
    if (previousKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousKey;
    }
  });
  const data = structuredClone(file ?? { version: 1, providers: [{
    provider: 'local', baseUrl: 'http://fixture.local:1234/v1', timeoutMs: 180000,
    models: [{ id: 'old-id', name: 'old' }, { id: 'other-id', name: 'other' }]
  }] });
  const writes = [];
  const sets = [];
  const prompts = [];
  const output = [];
  const keys = new Map([['local', 'saved-key']]);
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  t.mock.method(console, 'error', () => {});
  t.mock.method(store, 'loadModels', async () => data);
  t.mock.method(store, 'saveModels', async (dir, contents) => {
    writes.push(structuredClone(contents));
    return `${dir}/models.json`;
  });
  t.mock.method(credentials, 'createCredentialStore', () => ({
    name: 'test keyring',
    get: async (name) => keys.get(name),
    set: async (...args) => sets.push(args)
  }));
  const input = t.mock.method(cli, 'promptLine', async (question) => {
    prompts.push(question);
    assert.ok(answers.length, `Unexpected prompt: ${question}`);
    return answers.shift();
  });
  const hidden = t.mock.method(cli, 'promptHidden', async (question) => {
    prompts.push(question);
    return secret;
  });
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Model listing unavailable in fixture');
  });
  return { data, writes, sets, keys, prompts, output, input, hidden, fetch };
}

test('guided add selects a provider and advertised model while reusing its saved key', async (t) => {
  const f = fixture(t, { answers: ['1', '2', ''] });
  f.fetch.mock.mockImplementation(async (url, options) => {
    assert.equal(url, 'http://fixture.local:1234/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer saved-key');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ data: [{ id: 'z-model' }, { id: 'a-model' }, { id: 'a-model' }] }));
  });
  await runAdd([]);
  assert.deepEqual(f.writes[0].providers[0].models.at(-1), { id: 'z-model', name: 'z-model' });
  assert.deepEqual(f.sets, []);
  assert.equal(f.hidden.mock.callCount(), 0);
  assert.equal(f.fetch.mock.callCount(), 1);
  assert.ok(f.output.some((line) => line.includes('Config reference: local/z-model')));
});

test('guided add creates a provider with a hidden key and falls back to manual model entry', async (t) => {
  const f = fixture(t, { answers: ['new-local', 'not a URL', 'http://new.local:1234/v1/', 'org/model', 'alias'], secret: 'new-key' });
  await runAdd([]);
  const provider = f.writes[0].providers.at(-1);
  assert.equal(provider.baseUrl, 'http://new.local:1234/v1');
  assert.equal(provider.timeoutMs, 180000);
  assert.deepEqual(provider.models, [{ id: 'org/model', name: 'alias' }]);
  assert.deepEqual(f.sets, [['new-local', 'new-key']]);
  assert.equal(f.hidden.mock.callCount(), 1);
  assert.ok(!JSON.stringify(f.writes).includes('new-key'));
});

test('noninteractive add reuses a saved key even when OPENAI_API_KEY is set', async (t) => {
  const f = fixture(t, { terminal: false });
  process.env.OPENAI_API_KEY = 'unrelated-key';
  await runAdd(['--provider', 'local', '--model', 'new-id']);
  assert.deepEqual(f.sets, []);
  assert.equal(f.fetch.mock.callCount(), 0);
  assert.equal(f.input.mock.callCount(), 0);
  assert.equal(f.writes.length, 1);
});

test('explicit API key replacement still works when adding a model', async (t) => {
  const f = fixture(t, { terminal: false });
  await runAdd(['--provider', 'local', '--model', 'new-id', '--api-key', 'replacement']);
  assert.deepEqual(f.sets, [['local', 'replacement']]);
});

test('cancelled overwrite leaves both config and credentials untouched', async (t) => {
  const f = fixture(t, { answers: ['n'] });
  await runAdd(['--provider', 'local', '--model', 'new-id', '--name', 'old', '--api-key', 'replacement']);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.sets, []);
});

test('guided update selects a model and preserves fields on Enter', async (t) => {
  const f = fixture(t, { answers: ['1', '2', '', 'renamed'] });
  await runUpdate([]);
  assert.deepEqual(f.writes[0].providers[0].models[0], { id: 'old-id', name: 'renamed' });
  assert.equal(f.hidden.mock.callCount(), 0);
  assert.equal(f.fetch.mock.callCount(), 0);
});

test('guided model selection accepts the displayed model name', async (t) => {
  const f = fixture(t, { answers: ['local', 'old', 'new-id', ''] });
  await runUpdate([]);
  assert.equal(f.writes[0].providers[0].models[0].id, 'new-id');
});

for (const body of [{ data: [] }, { models: [] }, { data: [{ id: 42 }] }]) {
  test(`an unsupported or empty model list allows manual ID entry: ${JSON.stringify(body)}`, async (t) => {
    const f = fixture(t, { answers: ['local', 'manual-id', ''] });
    f.fetch.mock.mockImplementation(async () => new Response(JSON.stringify(body)));
    await runAdd([]);
    assert.equal(f.writes[0].providers[0].models.at(-1).id, 'manual-id');
  });
}

test('a cancelled prompt does not save configuration or rotate credentials', async (t) => {
  const f = fixture(t);
  f.input.mock.mockImplementation(async () => { throw new cli.CliError('Cancelled.'); });
  await assert.rejects(runAdd(['--provider', 'new', '--api-key', 'replacement']), /Cancelled/);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.sets, []);
});

test('guided provider update preserves the secret and changes URL and timeout', async (t) => {
  const f = fixture(t, { answers: ['1', '1', 'http://new.local/v1', '300000'] });
  await runUpdate([]);
  const provider = f.writes[0].providers[0];
  assert.equal(provider.baseUrl, 'http://new.local/v1');
  assert.equal(provider.timeoutMs, 300000);
  assert.deepEqual(f.sets, []);
  assert.equal(f.hidden.mock.callCount(), 1);
});

test('guided provider update rotates a key only when one is entered', async (t) => {
  const f = fixture(t, { answers: ['1', '1', '', ''], secret: 'replacement' });
  await runUpdate([]);
  assert.deepEqual(f.sets, [['local', 'replacement']]);
  assert.equal(f.writes.length, 1);
});

test('an unchanged guided edit does not rewrite the config or key', async (t) => {
  const f = fixture(t, { answers: ['1', '1', '', ''] });
  await runUpdate([]);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.sets, []);
  assert.ok(f.output.includes('No changes.'));
});

test('flags can update provider and model together without prompting', async (t) => {
  const f = fixture(t, { terminal: false });
  await runUpdate(['--provider', 'local', '--name', 'old', '--model', 'new-id', '--base-url', 'http://new.local/v1']);
  const provider = f.writes[0].providers[0];
  assert.equal(provider.models[0].id, 'new-id');
  assert.equal(provider.baseUrl, 'http://new.local/v1');
  assert.equal(f.input.mock.callCount(), 0);
  assert.ok(f.output.some((line) => line.includes('Update config.json references from local/old-id to local/new-id')));
});

test('an invalid model rename never rotates credentials', async (t) => {
  const f = fixture(t, { terminal: false });
  await assert.rejects(runUpdate(['--provider', 'local', '--name', 'old', '--new-name', 'other', '--api-key', 'replacement']), /already exists/);
  assert.deepEqual(f.sets, []);
  assert.deepEqual(f.writes, []);
});

test('a missing model selector never rotates credentials', async (t) => {
  const f = fixture(t, { terminal: false });
  await assert.rejects(runUpdate(['--provider', 'local', '--model', 'new-id', '--api-key', 'replacement']), /--name is required/);
  assert.deepEqual(f.sets, []);
  assert.deepEqual(f.writes, []);
});

test('missing arguments and forced interactive mode fail promptly without a terminal', async (t) => {
  const f = fixture(t, { terminal: false });
  await assert.rejects(runAdd([]), /--provider is required/);
  await assert.rejects(runAdd(['--provider', 'local']), /--model is required/);
  await assert.rejects(runAdd(['--provider', 'new', '--model', 'id']), /--base-url is required/);
  await assert.rejects(runUpdate(['--provider', 'local']), /Nothing to update/);
  await assert.rejects(runUpdate(['--interactive']), /requires a terminal/);
  assert.equal(f.input.mock.callCount(), 0);
  assert.equal(f.hidden.mock.callCount(), 0);
  assert.equal(f.fetch.mock.callCount(), 0);
  assert.deepEqual(f.writes, []);
});

test('invalid URLs and empty values fail before any credential mutation', async (t) => {
  const f = fixture(t, { terminal: false });
  await assert.rejects(runAdd(['--provider', 'local', '--model', '  ']), /must not be empty/);
  await assert.rejects(runUpdate(['--provider', 'local', '--api-key', 'replacement', '--model', '  ']), /must not be empty/);
  await assert.rejects(runAdd(['--provider', 'new', '--model', 'id', '--base-url', 'oops']), /absolute/);
  assert.deepEqual(f.sets, []);
  assert.deepEqual(f.writes, []);
});

test('base URL validation accepts LAN endpoints and rejects response URLs or embedded secrets', () => {
  assert.equal(setupBaseUrl('http://fixture.local:1234/v1/'), 'http://fixture.local:1234/v1');
  for (const value of ['file:///tmp/test', 'https://api.example/v1/responses', 'http://user:secret@host/v1', 'http://host/v1?key=secret']) {
    assert.throws(() => setupBaseUrl(value));
  }
});
