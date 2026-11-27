import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSettings, claudeRequest, claudeHeaders, parseClaudeSse, claudeError, cloudOf, cloudModel, cloudConsent, consentKey,
  DEFAULT_CLAUDE_MODEL, DEFAULT_MODEL, CLOUDS, parseInsight,
} from '../src/lib/ai-core.js';

test('normalizeSettings: cloud defaults to Gemini, Claude Haiku is the default Claude model', () => {
  const s = normalizeSettings({});
  assert.equal(s.cloud, 'gemini');
  assert.equal(s.claudeModel, DEFAULT_CLAUDE_MODEL);
  assert.equal(DEFAULT_CLAUDE_MODEL, 'claude-haiku-5-5');
  assert.equal(normalizeSettings({ cloud: 'claude' }).cloud, 'claude');
  assert.equal(normalizeSettings({ cloud: 'openai' }).cloud, 'gemini');
  assert.equal(normalizeSettings({ cloud: 'toString' }).cloud, 'gemini');
  assert.equal(normalizeSettings({ claudeModel: '  ' }).claudeModel, DEFAULT_CLAUDE_MODEL);
  assert.equal(normalizeSettings({ claudeModel: ' claude-sonnet-5-5 ' }).claudeModel, 'claude-sonnet-5-5');
});

test('cloud helpers pick the model and consent of the selected cloud', () => {
  const s = normalizeSettings({ cloudConsentAt: 5, claudeConsentAt: 0 });
  assert.equal(cloudModel(s), DEFAULT_MODEL);
  assert.equal(cloudConsent(s), 5);
  const c = normalizeSettings({ cloud: 'claude', cloudConsentAt: 5 });
  assert.equal(cloudModel(c), DEFAULT_CLAUDE_MODEL);
  assert.equal(cloudConsent(c), 0, 'agreeing to Gemini is not agreeing to Anthropic');
  assert.equal(consentKey('claude'), 'claudeConsentAt');
  assert.equal(consentKey('gemini'), 'cloudConsentAt');
  assert.equal(cloudOf({ engine: 'cloud' }), 'gemini', 'older cloud summaries came from Gemini');
  assert.equal(cloudOf({ engine: 'cloud', cloud: 'claude' }), 'claude');
  assert.equal(CLOUDS[cloudOf({ cloud: 'claude' })].badge, 'Claude · cloud');
});

test('claudeHeaders: key in a header, API version, and the browser-access header', () => {
  const h = claudeHeaders('k');
  assert.equal(h['x-api-key'], 'k');
  assert.equal(h['anthropic-version'], '2026-10-21');
  assert.equal(h['anthropic-dangerous-direct-browser-access'], 'true');
});

test('claudeRequest streams with thinking off and asks for JSON with a closed schema', () => {
  const r = claudeRequest({ model: 'claude-haiku-5-5', system: 's', user: 'u', json: true });
  assert.equal(r.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(r.body.model, 'claude-haiku-5-5');
  assert.equal(r.body.stream, true);
  assert.equal(r.body.system, 's');
  assert.deepEqual(r.body.messages, [{ role: 'user', content: 'u' }]);
  assert.deepEqual(r.body.thinking, { type: 'disabled' });
  assert.equal(r.body.output_config.effort, 'low');
  const f = r.body.output_config.format;
  assert.equal(f.type, 'json_schema');
  assert.equal(f.schema.additionalProperties, false);
  assert.deepEqual(f.schema.required, ['facts', 'summary', 'status']);
  assert.ok(f.schema.properties.status.enum.includes('unknown'));
  assert.equal(r.body.temperature, undefined, 'API version 2026-10-21 rejects sampling parameters');
  const s = claudeRequest({ model: 'm', system: 's', user: 'u', json: 'sentence' }).body.output_config.format.schema;
  assert.deepEqual(s.required, ['summary']);
  assert.equal(s.additionalProperties, false);
  assert.equal(claudeRequest({ model: 'm', system: 's', user: 'u' }).body.output_config.format, undefined);
});

test('parseClaudeSse collects text deltas across chunks and spots refusals and errors', () => {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const all = ev('message_start', { message: {} }) + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '{"facts": "", "summary": "A Claude' } })
    + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: ' sentence.", "status": "done"}' } })
    + ev('content_block_stop', { index: 0 }) + ev('message_delta', { delta: { stop_reason: 'end_turn' } }) + ev('message_stop', {});
  const cut = all.length - 120;
  const a = parseClaudeSse(all.slice(0, cut));
  const b = parseClaudeSse(a.rest + all.slice(cut));
  const text = [...a.texts, ...b.texts].join('');
  assert.deepEqual(parseInsight(text), { summary: 'A Claude sentence.', status: 'done' });
  assert.equal(a.blocked || b.blocked, null);
  assert.equal(parseClaudeSse(ev('message_delta', { delta: { stop_reason: 'refusal' } })).blocked, 'refusal');
  assert.deepEqual(parseClaudeSse(ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } })).error, { type: 'overloaded_error', message: 'Overloaded' });
  // Thinking deltas, if any, are not part of the answer.
  assert.deepEqual(parseClaudeSse(ev('content_block_delta', { delta: { type: 'thinking_delta', thinking: 'hmm' } })).texts, []);
});

test('claudeError maps statuses to friendly messages', () => {
  assert.equal(claudeError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }).code, 'key');
  assert.equal(claudeError(403, '').code, 'key');
  assert.equal(claudeError(404, { error: { type: 'not_found_error', message: 'model: nope' } }).code, 'model');
  const r = claudeError(429, '', '7');
  assert.equal(r.code, 'rate');
  assert.equal(r.retry, 7);
  assert.equal(claudeError(529, '').code, 'server');
  assert.equal(claudeError(500, '').code, 'server');
  assert.equal(claudeError(400, { error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } }).code, 'key');
  assert.match(claudeError(400, { error: { message: 'Bad thing' } }).message, /^Claude: Bad thing/);
  assert.match(claudeError(400, 'not json').message, /\(400\)/);
});
