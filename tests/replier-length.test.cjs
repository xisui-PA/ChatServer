const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ModelReplier } = require('../src/repliers/model');
const { FilterOutcome } = require('../src/filters/interface');
const { countTokens } = require('../src/models/tokens');
const { limitReplyText } = require('../src/repliers/limits');

const message = { id: 'message:1', text: 'Explain the answer.', senderId: 'sender', channel: 'chat' };
const memoryUpdates = { notes: [{ kind: 'question', text: 'The sender asked for an explanation.', sourceIds: ['message:1'] }], forget: [] };
const longText = 'This detailed explanation includes background, examples, qualifications, and repeated advice. '.repeat(100);

/** Fails if the replier requests a second generation to shorten its answer. */
function fixture(text, reply = true, tools = []) {
  const calls = [];
  const model = { generate: async (...args) => {
    calls.push(args);
    assert.equal(calls.length, 1);
    return JSON.stringify({ reply, text, memoryUpdates });
  } };
  return { calls, replier: new ModelReplier(model, tools) };
}

test('a reply within the hard limit is preserved with one generation', async () => {
  const text = limitReplyText(longText);
  assert.ok(countTokens(text) > 150);
  const { calls, replier } = fixture(text);
  const result = await replier.replyTo(message, FilterOutcome.Optional);
  assert.equal(result.reply.text, text);
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /Plan a complete answer that fits within 150 tokens/);
});

test('oversized English, Chinese, and emoji replies are capped locally without another generation', async () => {
  const tools = [{ definition: { name: 'fixture' } }];
  for (const text of [longText, '这是一个包含太多细节的中文解释，仍然需要缩短。'.repeat(100), '👨‍👩‍👧‍👦 👍🏽 🧑🏿‍💻 '.repeat(100)]) {
    const { calls, replier } = fixture(text, true, tools);
    const result = await replier.replyTo(message, FilterOutcome.Optional);
    assert.equal(result.reply.text, limitReplyText(text));
    assert.ok(countTokens(result.reply.text) <= 200);
    assert.equal(result.reply.channel, 'chat');
    assert.deepEqual(result.memoryUpdates, memoryUpdates);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][3].localTools, tools);
  }
});

test('a declined reply preserves memory without another generation', async () => {
  const { calls, replier } = fixture(longText, false);
  const result = await replier.replyTo(message, FilterOutcome.Optional);
  assert.equal(result.reply, undefined);
  assert.deepEqual(result.memoryUpdates, memoryUpdates);
  assert.equal(calls.length, 1);
});

test('a denied message makes no model request', async () => {
  const { calls, replier } = fixture(longText);
  const result = await replier.replyTo(message, FilterOutcome.Denied);
  assert.equal(result.reply, undefined);
  assert.equal(calls.length, 0);
});

test('existing plain and Markdown citation links are preserved without duplicate URLs', () => {
  const url = 'https://example.com/source';
  for (const text of [`An update. ${url}`, `An update. [Source](${url})`, `An update. <${url}>`]) {
    assert.equal(limitReplyText(text, [url, url]), text);
  }
  const other = 'https://example.org/reference';
  assert.equal(limitReplyText(`An update. ${url}`, [url, other]), `An update. ${url} ${other}`);
  assert.equal(limitReplyText('See https://example.com', ['https://example.com/']), 'See https://example.com');
});

test('citation detection distinguishes a source from a longer URL with the same prefix', () => {
  const source = 'https://example.com/source';
  assert.equal(limitReplyText(`See ${source}-other`, [source]), `See ${source}-other ${source}`);
  assert.equal(limitReplyText(`See ${source}?other=true`, [source]), `See ${source}?other=true ${source}`);
});

test('oversized replies move existing citations outside the truncated text without breaking or duplicating links', () => {
  const urls = ['https://example.com/source_(details)?a=1&b=2', 'https://example.org/reference'];
  const text = `${longText} [Source](${urls[0]}) <${urls[1]}>`;
  const result = limitReplyText(text, urls);
  assert.ok(countTokens(result) <= 200);
  assert.ok(result.endsWith(urls.join(' ')));
  for (const url of urls) {
    assert.equal(result.split(url).length - 1, 1);
  }
  assert.ok(!result.includes('[Source]('));
});
