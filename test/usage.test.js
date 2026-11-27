import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addUsage, usageSummary, dayKey, USAGE_DAYS, parseSse, parseClaudeSse } from '../src/lib/ai-core.js';

const DAY = 864e5;
const now = new Date(2026, 10, 27, 15, 0).getTime();

test('dayKey is the local calendar day', () => {
  assert.equal(dayKey(now), '2026-11-27');
  assert.equal(dayKey(new Date(2026, 0, 5, 0, 1).getTime()), '2026-01-05');
});

test('addUsage tallies calls, failures, tokens, cost and time per day and provider', () => {
  let s = addUsage({}, { provider: 'claudecode', ok: true, input: 5, output: 40, cacheRead: 600, cacheWrite: 2700, costUsd: 0.0006, ms: 3000 }, now);
  s = addUsage(s, { provider: 'claudecode', ok: false, ms: 1000 }, now);
  s = addUsage(s, { provider: 'local', ok: true, ms: 500 }, now);
  s = addUsage(s, { provider: 'nope', ok: true }, now);
  assert.deepEqual(Object.keys(s), ['2026-11-27']);
  assert.deepEqual(s['2026-11-27'].claudecode, { calls: 2, errors: 1, input: 5, output: 40, cacheRead: 600, cacheWrite: 2700, costUsd: 0.0006, ms: 4000 });
  assert.equal(s['2026-11-27'].local.calls, 1);
  assert.equal(s['2026-11-27'].nope, undefined, 'unknown providers are ignored');
});

test('addUsage drops days older than the retention window', () => {
  const old = addUsage({}, { provider: 'gemini', ok: true }, now - USAGE_DAYS * DAY);
  const s = addUsage(old, { provider: 'gemini', ok: true }, now);
  assert.deepEqual(Object.keys(s), ['2026-11-27']);
});

test('usageSummary totals a period per provider and gives one row per day, oldest first', () => {
  let s = {};
  s = addUsage(s, { provider: 'claude', ok: true, input: 100, output: 20 }, now - 2 * DAY);
  s = addUsage(s, { provider: 'claudecode', ok: true, input: 5, output: 30, cacheRead: 600, costUsd: 0.01 }, now);
  s = addUsage(s, { provider: 'claudecode', ok: true, input: 5, output: 30, cacheRead: 600, costUsd: 0.01 }, now);
  s = addUsage(s, { provider: 'gemini', ok: true, input: 1 }, now - 10 * DAY);
  const week = usageSummary(s, 7, now);
  assert.equal(week.daily.length, 7);
  assert.equal(week.daily.at(-1).day, '2026-11-27');
  assert.deepEqual(week.daily.at(-1), { day: '2026-11-27', calls: 2, tokens: 1270 });
  assert.equal(week.daily.at(-3).calls, 1);
  assert.equal(week.total.calls, 3);
  assert.equal(week.providers.claudecode.costUsd, 0.02);
  assert.equal(week.providers.gemini, undefined, 'outside the period');
  assert.equal(usageSummary(s, 1, now).total.calls, 2);
  assert.equal(usageSummary(s, 30, now).providers.gemini.calls, 1);
  assert.equal(usageSummary({}, 7, now).total.calls, 0);
});

test('stream parsers pick up the token counts the APIs report', () => {
  const g = parseSse(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hi' }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 7, thoughtsTokenCount: 3 } })}\n`);
  assert.deepEqual(g.usage, { input: 50, output: 10, cacheRead: 0 });
  const c = parseClaudeSse([
    `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 80, output_tokens: 1, cache_read_input_tokens: 10 } } })}`,
    `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Yo' } })}`,
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 25 } })}`, ''].join('\n'));
  assert.deepEqual(c.usage, { input: 80, output: 25, cacheRead: 10 });
  assert.deepEqual(c.texts, ['Yo']);
});
