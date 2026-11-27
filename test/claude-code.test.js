import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeSettings, cloudModel, consentKey, cloudConsent, cloudReady, CLOUDS, cloudOf, chooseEngine,
  claudeCodeRequest, claudeCodeError, claudeCodeInstallCommand, CLAUDE_CODE_HOST, DEFAULT_CLAUDE_CODE_MODEL,
} from '../src/lib/ai-core.js';
import { encode, decode, classify, claudeArgs, usageOf } from '../native-host/tab-desk-claude-host.mjs';

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..', 'native-host', 'tab-desk-claude-host.mjs');

test('settings: Claude Code is a cloud choice with its own model and consent, and needs no key', () => {
  const s = normalizeSettings({ cloud: 'claudecode' });
  assert.equal(s.cloud, 'claudecode');
  assert.equal(s.claudeCodeModel, DEFAULT_CLAUDE_CODE_MODEL);
  assert.equal(cloudModel(s), 'haiku');
  assert.equal(normalizeSettings({ claudeCodeModel: ' sonnet ' }).claudeCodeModel, 'sonnet');
  assert.equal(normalizeSettings({ claudeCodeModel: 'claude-haiku-5-5[1m]' }).claudeCodeModel, 'claude-haiku-5-5[1m]');
  assert.equal(normalizeSettings({ claudeCodeModel: 'haiku; rm -rf /' }).claudeCodeModel, 'haiku', 'only plain model names');
  assert.equal(consentKey('claudecode'), 'claudeCodeConsentAt');
  assert.equal(cloudConsent(normalizeSettings({ cloud: 'claudecode', claudeConsentAt: 9 })), 0, 'agreeing to the Claude API is not agreeing to Claude Code');
  assert.equal(cloudReady('claudecode', ''), true);
  assert.equal(cloudReady('claude', ''), false);
  assert.equal(cloudReady('claude', 'k'), true);
  assert.equal(CLOUDS[cloudOf({ engine: 'cloud', cloud: 'claudecode' })].badge, 'Claude Code');
  // Ready without a key, so Auto uses it for groups and Cloud only uses it for everything.
  assert.equal(chooseEngine({ kind: 'group', setting: 'auto', local: 'available', hasKey: cloudReady('claudecode', '') }), 'cloud');
  assert.equal(chooseEngine({ kind: 'tab', setting: 'cloud', local: 'available', hasKey: cloudReady('claudecode', '') }), 'cloud');
});

test('claudeCodeRequest and errors: Chrome errors and helper replies become plain messages', () => {
  assert.deepEqual(claudeCodeRequest({ model: 'haiku', system: 's', user: 'u' }), { type: 'prompt', model: 'haiku', system: 's', user: 'u' });
  assert.equal(CLAUDE_CODE_HOST, 'com.tabdesk.claude_code');
  let e = claudeCodeError({ chromeError: 'Specified native messaging host not found.' });
  assert.equal(e.code, 'host');
  assert.match(e.message, /helper isn’t installed/);
  assert.match(claudeCodeError({ chromeError: 'Access to the specified native messaging host is forbidden.' }).message, /different copy of Tab Desk/);
  assert.match(claudeCodeError({ chromeError: 'Native host has exited.' }).message, /stopped before it answered/);
  e = claudeCodeError({ reply: { ok: false, code: 'auth', message: 'Claude Code isn’t signed in.' } });
  assert.deepEqual(e, { code: 'key', message: 'Claude Code isn’t signed in.' });
  assert.equal(claudeCodeError({ reply: { ok: false, code: 'no-cli', message: 'x' } }).code, 'host');
  assert.equal(claudeCodeError({ reply: { ok: false, code: 'weird', message: 'x' } }).code, 'other');
  assert.equal(claudeCodeError({}).code, 'other');
});

test('install command names this copy of the extension, per OS', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  assert.equal(claudeCodeInstallCommand('mac', id), `./native-host/install.sh ${id}`);
  assert.equal(claudeCodeInstallCommand('linux', id), `./native-host/install.sh ${id}`);
  assert.equal(claudeCodeInstallCommand('win', id), `powershell -ExecutionPolicy Bypass -File native-host\\install.ps1 -ExtensionId ${id}`);
});

test('host: native messaging framing round-trips, including split chunks and unicode', () => {
  const a = encode({ id: 1, text: 'héllo ✓' }), b = encode({ id: 2 });
  const all = Buffer.concat([a, b]);
  let r = decode(all.subarray(0, a.length + 3));
  assert.deepEqual(r.messages, [{ id: 1, text: 'héllo ✓' }]);
  r = decode(Buffer.concat([r.rest, all.subarray(a.length + 3)]));
  assert.deepEqual(r.messages, [{ id: 2 }]);
  assert.equal(r.rest.length, 0);
  assert.equal(a.readUInt32LE(0), a.length - 4);
});

test('host: runs claude with no tools, no MCP servers, no saved session and the system prompt in a file', () => {
  const args = claudeArgs({ model: 'haiku', systemFile: '/tmp/s.txt' });
  assert.deepEqual(args.slice(0, 7), ['-p', '--model', 'haiku', '--effort', 'low', '--output-format', 'json']);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.ok(args.includes('--strict-mcp-config') && args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--system-prompt-file') + 1], '/tmp/s.txt');
  assert.ok(!args.includes('--dangerously-skip-permissions'));
});

test('host: classify turns Claude Code output into a reason', () => {
  assert.equal(classify('Not logged in · Please run /login').code, 'auth');
  assert.equal(classify('Invalid API key · Please run /login').code, 'auth');
  assert.equal(classify('There’s an issue with the selected model (x).', 404).code, 'model');
  assert.equal(classify('Claude usage limit reached. Your limit will reset at 5pm').code, 'rate');
  assert.equal(classify('', 529).code, 'rate');
  const o = classify('Something odd happened');
  assert.equal(o.code, 'other');
  assert.match(o.message, /Something odd happened/);
});

/** Start the real host with a fake `claude` and send it messages over stdin, like Chrome does. */
function talk(messages, env) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [HOST], { env: { ...process.env, ...env } });
    let buf = Buffer.alloc(0);
    const got = [];
    c.stdout.on('data', d => {
      const r = decode(Buffer.concat([buf, d]));
      buf = r.rest;
      got.push(...r.messages);
      if (got.length === messages.length) c.stdin.end();
    });
    c.on('error', reject);
    c.on('close', () => resolve(got.sort((x, y) => x.id - y.id)));
    for (const m of messages) c.stdin.write(encode(m));
  });
}

test('host end to end with a fake claude: ping, prompt, sign-in error, missing claude', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tabdesk-cc-'));
  const fake = join(dir, 'claude');
  const seen = join(dir, 'seen.json');
  // Records its arguments, the system prompt file and stdin, then answers like `claude -p --output-format json`.
  writeFileSync(fake, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
let input = '';
process.stdin.on('data', d => input += d).on('end', () => {
  const sys = fs.readFileSync(args[args.indexOf('--system-prompt-file') + 1], 'utf8');
  fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args, sys, input, cwd: process.cwd() }));
  if (/signed-out/.test(input)) { console.log(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' })); return; }
  console.log(JSON.stringify({ type: 'result', is_error: false, result: '{"summary":"Fake answer."}', modelUsage: { 'claude-haiku-5-5': {} },
    usage: { input_tokens: 5, output_tokens: 40, cache_read_input_tokens: 600, cache_creation_input_tokens: 2700 }, total_cost_usd: 0.0006, duration_ms: 3100 }));
});
`);
  chmodSync(fake, 0o755);
  const res = await talk([
    { id: 1, type: 'ping' },
    { id: 2, type: 'prompt', model: 'haiku', system: 'Reply with JSON only.', user: 'Title: Page\npurple-otter' },
    { id: 3, type: 'prompt', model: 'bad name!', user: 'x' },
    { id: 4, type: 'bogus' },
  ], { TABDESK_CLAUDE: fake });
  assert.deepEqual(res[0], { id: 1, ok: true, version: '1.0.0', claude: { path: fake, version: '9.9.9 (Claude Code)' } });
  assert.deepEqual(res[1], { id: 2, ok: true, text: '{"summary":"Fake answer."}', model: 'claude-haiku-5-5',
    usage: { input: 5, output: 40, cacheRead: 600, cacheWrite: 2700, costUsd: 0.0006, ms: 3100 } });
  assert.equal(res[2].code, 'model');
  assert.equal(res[3].code, 'bad-request');
  const s = JSON.parse(readFileSync(seen, 'utf8'));
  assert.equal(s.sys, 'Reply with JSON only.');
  assert.equal(s.input, 'Title: Page\npurple-otter', 'the page text goes on stdin, not the command line');
  assert.ok(!s.args.some(a => a.includes('purple-otter')));
  assert.match(s.cwd, /tab-desk-claude$/, 'runs in an empty folder, away from any project');

  const [out] = await talk([{ id: 1, type: 'prompt', user: 'signed-out' }], { TABDESK_CLAUDE: fake });
  assert.equal(out.code, 'auth');
  assert.match(out.message, /isn’t signed in/);

  const empty = mkdtempSync(join(tmpdir(), 'tabdesk-cc-empty-'));
  const [none] = await talk([{ id: 1, type: 'ping' }], { TABDESK_CLAUDE: join(dir, 'nope'), PATH: empty, HOME: empty });
  // The host also looks in /usr/local/bin and /opt/homebrew/bin; skip when this machine has claude there.
  if (none.ok) return;
  assert.equal(none.code, 'no-cli');
  assert.match(none.message, /can’t find Claude Code/);
});

test('host: usageOf reads tokens, cost and time from claude -p JSON, and tolerates missing fields', () => {
  assert.deepEqual(usageOf({}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, ms: 0 });
  assert.deepEqual(usageOf({ usage: { input_tokens: 2, output_tokens: 9 }, total_cost_usd: 0.001, duration_ms: 1200.4 }),
    { input: 2, output: 9, cacheRead: 0, cacheWrite: 0, costUsd: 0.001, ms: 1200 });
});
