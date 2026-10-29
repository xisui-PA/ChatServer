const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadConfig, ConfigError } = require('../src/config');
const { createTools, DEFAULT_TOOL_NAMES } = require('../src/tools/registry');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'chatserver-tools-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return async (fields) => {
    await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ chats: [{
      messager: { name: 'wechat', replier: 'fixture/model', ...fields }, filters: []
    }] }));
    return (await loadConfig(directory)).values.chats[0].messager;
  };
}

test('omitted localTools keeps built-ins and omitted apiTools enables no hosted tools', async (t) => {
  const load = await fixture(t);
  const config = await load({});
  assert.equal(config.localTools, undefined);
  assert.equal(config.apiTools, undefined);
  assert.deepEqual(createTools(config.localTools).map((tool) => tool.definition.name), DEFAULT_TOOL_NAMES);
  const disabled = await load({ localTools: [], apiTools: [] });
  assert.deepEqual(createTools(disabled.localTools), []);
  assert.deepEqual(disabled.apiTools, []);
});

test('local names are deduplicated and hosted definitions retain provider options', async (t) => {
  const load = await fixture(t);
  const apiTools = [
    { type: 'web_search', filters: { allowed_domains: ['example.com'] }, search_context_size: 'low' },
    { type: 'provider_specific_search', nested: { settings: [1, true, null] } }
  ];
  const config = await load({ localTools: ['calculate', 'calculate', 'current_time'], apiTools });
  assert.deepEqual(config.localTools, ['calculate', 'current_time']);
  assert.deepEqual(config.apiTools, apiTools);
});

test('strings and type objects can be mixed and equivalent local selections are deduplicated', async (t) => {
  const load = await fixture(t);
  const hostedOptions = { type: 'provider_specific_search', nested: { settings: [1, true, null] } };
  const config = await load({
    localTools: ['calculate', { type: 'calculate' }, { type: 'current_time' }, 'current_time'],
    apiTools: ['web_search', hostedOptions]
  });
  assert.deepEqual(config.localTools, ['calculate', 'current_time']);
  assert.deepEqual(config.apiTools, [{ type: 'web_search' }, hostedOptions]);
  assert.deepEqual(createTools(config.localTools).map((tool) => tool.definition.name), ['calculate', 'current_time']);
});

test('the old tools field fails with a migration error, including when localTools is present', async (t) => {
  const load = await fixture(t);
  for (const fields of [{ tools: [] }, { tools: [], localTools: [] }]) {
    await assert.rejects(load(fields), (error) => error instanceof ConfigError &&
      /messager.tools has been replaced by localTools/.test(error.message));
  }
});

test('invalid local and hosted configuration is rejected before startup', async (t) => {
  const load = await fixture(t);
  for (const localTools of [null, 'calculate', [1], ['missing_tool'], [''], [' calculate'],
    [null], [[]], [{}], [{ type: '' }], [{ type: 1 }], [{ type: 'missing_tool' }],
    [{ type: 'calculate', unsupportedOption: true }]]) {
    await assert.rejects(load({ localTools }), (error) => error instanceof ConfigError &&
      /messager.localTools/.test(error.message));
  }
  for (const apiTools of [null, {}, 'web_search', [''], [' web_search'], ['function'], ['custom'], [1], [null], [[]], [{}],
    [{ type: '' }], [{ type: ' ' }], [{ type: ' web_search' }], [{ type: 1 }],
    [{ type: 'function', name: 'run' }], [{ type: 'custom' }]]) {
    await assert.rejects(load({ apiTools }), (error) => error instanceof ConfigError &&
      /messager.apiTools/.test(error.message));
  }
});
