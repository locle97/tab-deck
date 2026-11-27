#!/usr/bin/env node
// Tab Desk's Claude Code helper: a Chrome native messaging host.
//
// Chrome starts this script when Tab Desk asks for it and talks to it over stdin/stdout (each message
// is a 4-byte little-endian length followed by UTF-8 JSON). For each prompt it runs the Claude Code
// CLI once, non-interactively (`claude -p`), with the user's existing Claude Code sign-in, and sends
// back the answer. It never reads Claude Code's credentials; it only runs the `claude` command.
//
// Requests:  { id, type: 'ping' }
//            { id, type: 'prompt', model, system, user }
// Responses: { id, ok: true, version, claude: { path, version } }        (ping)
//            { id, ok: true, text, model }                                 (prompt)
//            { id, ok: false, code, message }   code: no-cli | auth | model | rate | timeout | bad-request | other
//
// No dependencies beyond Node.js 18+.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, statSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const VERSION = '1.0.0';
const HERE = dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';
const TIMEOUT_MS = Number(process.env.TABDESK_CLAUDE_TIMEOUT_MS) || 120000;
const MAX_TEXT = 200000;            // characters of prompt text we accept
const MAX_REPLY = 512 * 1024;       // Chrome refuses host messages over 1 MB
const MODEL_RE = /^[A-Za-z0-9._:\[\]-]{1,80}$/;
const children = new Set();

/* ---------- finding claude ---------- */

function readConfig() {
  try { return JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8')) || {}; } catch { return {}; }
}

const isFile = p => { try { return statSync(p).isFile(); } catch { return false; } };

/** Where `claude` is: $TABDESK_CLAUDE, then the path the installer saved, then PATH and the usual install folders. */
export function findClaude(env = process.env, config = readConfig()) {
  for (const p of [env.TABDESK_CLAUDE, config.claude]) if (p && isFile(p)) return p;
  const names = WIN ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
  for (const dir of searchDirs(env)) for (const n of names) { const p = join(dir, n); if (isFile(p)) return p; }
  return null;
}

/** PATH plus the folders Claude Code and Node usually live in. Chrome starts hosts with a short PATH, mostly on macOS. */
function searchDirs(env) {
  const home = homedir();
  const extra = WIN
    ? [join(home, '.local', 'bin'), join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'npm'), join(home, '.claude', 'local')]
    : [join(home, '.local', 'bin'), join(home, '.claude', 'local'), join(home, '.npm-global', 'bin'), join(home, '.volta', 'bin'),
      join(home, '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  return [...String(env.PATH || env.Path || '').split(delimiter).filter(Boolean), ...extra];
}

/** The environment for claude: ours, with this Node's folder and the usual folders on PATH (the npm `claude` needs `node`). */
function childEnv() {
  const env = { ...process.env };
  const key = WIN ? Object.keys(env).find(k => k.toLowerCase() === 'path') || 'Path' : 'PATH';
  const dirs = [dirname(process.execPath), ...searchDirs(env)];
  env[key] = [...new Set(dirs)].join(delimiter);
  return env;
}

/* ---------- running claude ---------- */

// cmd.exe quoting for a .cmd/.bat shim (Node can only start those through a shell). Our arguments are
// flags, a checked model name and a temp file path, so double quotes around each are enough.
const winQuote = a => `"${String(a).replace(/"/g, '')}"`;

function run(cmd, args, { input = '', timeout = TIMEOUT_MS, cwd } = {}) {
  return new Promise(resolve => {
    const shell = WIN && /\.(cmd|bat)$/i.test(cmd);
    let child;
    try {
      child = shell
        ? spawn(winQuote(cmd), args.map(winQuote), { cwd, env: childEnv(), shell: true, windowsHide: true })
        : spawn(cmd, args, { cwd, env: childEnv(), windowsHide: true });
    } catch (e) {
      resolve({ error: e });
      return;
    }
    children.add(child);
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on('data', d => { if (out.length < 4 * MAX_REPLY) out += d; });
    child.stderr.on('data', d => { if (err.length < 64 * 1024) err += d; });
    child.on('error', e => { clearTimeout(timer); children.delete(child); resolve({ error: e }); });
    child.on('close', code => { clearTimeout(timer); children.delete(child); resolve({ code, out, err, timedOut }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Turn what claude printed into a short, plain error. */
export function classify(text, status) {
  const t = String(text || '');
  if (status === 401 || status === 403 || /not logged in|please run \/login|\/login|invalid api key|authenticat|oauth|credentials?/i.test(t)) {
    return { code: 'auth', message: 'Claude Code isn’t signed in on this computer. Run `claude` in a terminal, sign in, then try again.' };
  }
  if (status === 404 || /issue with the selected model|model.*(not exist|not found|access)|unrecognized_model/i.test(t)) {
    return { code: 'model', message: 'Claude Code doesn’t know that model, or your account can’t use it. Try “haiku” in Settings.' };
  }
  if (status === 429 || /usage limit|rate limit|limit reached|too many requests/i.test(t)) {
    return { code: 'rate', message: 'Claude Code hit a usage or rate limit. Try again later.' };
  }
  if (status === 529 || /overloaded/i.test(t)) return { code: 'rate', message: 'Claude is busy right now. Try again in a moment.' };
  const line = t.replace(/\s+/g, ' ').trim().slice(0, 300);
  return { code: 'other', message: line ? `Claude Code: ${line}` : 'Claude Code failed without saying why.' };
}

/** The `claude -p` arguments for one prompt. No tools, no MCP servers, no saved session: just an answer. */
export function claudeArgs({ model, systemFile }) {
  return ['-p', '--model', model, '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--no-session-persistence',
    '--system-prompt-file', systemFile];
}

const workDir = () => {
  // An empty folder, so no project's CLAUDE.md or files are in reach.
  const d = join(tmpdir(), 'tab-desk-claude');
  mkdirSync(d, { recursive: true });
  return d;
};

const NO_CLI = { code: 'no-cli', message: 'The helper can’t find Claude Code (the `claude` command). Install Claude Code, then run the helper’s install script again.' };

async function ping() {
  const claude = findClaude();
  if (!claude) return { ok: false, ...NO_CLI };
  const r = await run(claude, ['--version'], { timeout: 30000, cwd: workDir() });
  if (r.error) return { ok: false, ...NO_CLI, message: `${NO_CLI.message} (${r.error.code || r.error.message})` };
  if (r.timedOut) return { ok: false, code: 'timeout', message: 'Claude Code didn’t answer `claude --version` in time.' };
  if (r.code !== 0) return { ok: false, ...classify(r.err || r.out) };
  return { ok: true, version: VERSION, claude: { path: claude, version: r.out.trim().split('\n')[0] } };
}

async function prompt(msg) {
  const model = String(msg.model || 'haiku').trim();
  if (!MODEL_RE.test(model)) return { ok: false, code: 'model', message: 'That model name isn’t valid. Try “haiku”.' };
  const system = String(msg.system || '');
  const user = String(msg.user || '');
  if (!user.trim()) return { ok: false, code: 'bad-request', message: 'Nothing to send.' };
  if (system.length + user.length > MAX_TEXT) return { ok: false, code: 'bad-request', message: 'The page text is too long.' };
  const claude = findClaude();
  if (!claude) return { ok: false, ...NO_CLI };
  const cwd = workDir();
  // The system prompt goes in a file, not on the command line: it can be long, and Windows limits command lines.
  const systemFile = join(cwd, `system-${randomUUID()}.txt`);
  writeFileSync(systemFile, system || 'Follow the instructions in the message.', 'utf8');
  try {
    const r = await run(claude, claudeArgs({ model, systemFile }), { input: user, cwd });
    if (r.error) return { ok: false, ...NO_CLI, message: `${NO_CLI.message} (${r.error.code || r.error.message})` };
    if (r.timedOut) return { ok: false, code: 'timeout', message: `Claude Code took longer than ${Math.round(TIMEOUT_MS / 1000)} seconds.` };
    let j = null;
    try { j = JSON.parse(r.out.trim().split('\n').filter(Boolean).at(-1)); } catch {}
    if (!j) return { ok: false, ...classify(r.err || r.out) };
    if (j.is_error) return { ok: false, ...classify(j.result || r.err, j.api_error_status) };
    const text = String(j.result ?? '');
    if (!text.trim()) return { ok: false, code: 'other', message: 'Claude Code returned an empty answer.' };
    const used = Object.keys(j.modelUsage || {})[0];
    return { ok: true, text: text.slice(0, MAX_REPLY / 2), model: used || model };
  } finally {
    try { rmSync(systemFile, { force: true }); } catch {}
  }
}

export async function handle(msg) {
  const id = msg && typeof msg === 'object' ? msg.id : undefined;
  let res;
  try {
    if (!msg || typeof msg !== 'object') res = { ok: false, code: 'bad-request', message: 'Bad request.' };
    else if (msg.type === 'ping') res = await ping();
    else if (msg.type === 'prompt') res = await prompt(msg);
    else res = { ok: false, code: 'bad-request', message: `Unknown request “${String(msg.type).slice(0, 40)}”.` };
  } catch (e) {
    res = { ok: false, code: 'other', message: `The helper failed: ${e?.message || e}` };
  }
  return id === undefined ? res : { id, ...res };
}

/* ---------- native messaging framing ---------- */

export function encode(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Split stdin bytes into messages. Returns { messages, rest }. */
export function decode(buf) {
  const messages = [];
  let off = 0;
  while (buf.length - off >= 4) {
    const len = buf.readUInt32LE(off);
    if (buf.length - off - 4 < len) break;
    const raw = buf.subarray(off + 4, off + 4 + len).toString('utf8');
    off += 4 + len;
    try { messages.push(JSON.parse(raw)); } catch { messages.push(null); }
  }
  return { messages, rest: buf.subarray(off) };
}

function main() {
  process.stdout.on('error', () => process.exit(0)); // Chrome went away
  let buf = Buffer.alloc(0);
  let pending = 0, ended = false;
  const done = () => { if (ended && pending === 0) process.exit(0); };
  process.stdin.on('data', chunk => {
    const r = decode(Buffer.concat([buf, chunk]));
    buf = r.rest;
    for (const m of r.messages) {
      pending++;
      handle(m).then(res => process.stdout.write(encode(res))).finally(() => { pending--; done(); });
    }
  });
  // Chrome closes stdin when Tab Desk disconnects (the summary was stopped, or the page closed): stop claude too.
  process.stdin.on('end', () => {
    ended = true;
    for (const c of children) { try { c.kill(); } catch {} }
    done();
  });
}

const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) main();
