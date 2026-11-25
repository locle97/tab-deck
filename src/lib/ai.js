// AI summaries: settings, page text extraction, the on-device engine (Chrome's built-in
// Summarizer API, Gemini Nano) and the optional cloud engine (Gemini API with the user's key).
// Runs in the Tab Desk page only: the Summarizer API isn't available in service workers.

import {
  DEFAULT_SETTINGS, normalizeSettings, instructionsFor, chooseEngine, cleanText, chunkText, langCode,
  isReadableUrl, tabPrompt, groupPrompt, localContext, geminiRequest, parseSse, geminiError,
  cacheKey, fnv, pruneCache, ON_DEVICE_LANGS, MAX_GROUP_TABS, MAX_LOCAL_GROUP_TABS,
} from './ai-core.js';

const SETTINGS_KEY = 'aiSettings';
const API_KEY = 'aiGeminiKey';
const CACHE_KEY = 'aiCache';
export const PAGE_ORIGINS = ['<all_urls>'];

export class AiError extends Error {
  constructor(message, code = 'other') { super(message); this.code = code; }
}

/* ---------- settings + key ---------- */

export async function getSettings() {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(r[SETTINGS_KEY]);
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = normalizeSettings({ ...cur, ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** The Gemini key is kept in storage.local only, never storage.sync, so it stays on this device. */
export async function getApiKey() {
  const r = await chrome.storage.local.get(API_KEY);
  return typeof r[API_KEY] === 'string' ? r[API_KEY] : '';
}

export async function setApiKey(key) {
  key = String(key || '').trim();
  if (key) await chrome.storage.local.set({ [API_KEY]: key });
  else {
    await chrome.storage.local.remove(API_KEY);
    await saveSettings({ cloudConsentAt: 0 });
  }
}

export function onSettingsChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes[SETTINGS_KEY] || changes[API_KEY])) cb();
  });
}

export { DEFAULT_SETTINGS, instructionsFor };

/* ---------- page access ---------- */

export const hasPageAccess = () => chrome.permissions.contains({ origins: PAGE_ORIGINS });

/**
 * Ask for permission to read page text. Chrome only shows the prompt during a user gesture,
 * so call this first thing in a click handler, before any other await.
 */
export const requestPageAccess = () => chrome.permissions.request({ origins: PAGE_ORIGINS }).catch(() => false);

export const revokePageAccess = () => chrome.permissions.remove({ origins: PAGE_ORIGINS }).catch(() => false);

/* ---------- extraction ---------- */

// Runs inside the page. Must be self-contained.
function extractInPage() {
  const pick = document.querySelector('article, main, [role=main]') || document.body;
  let text = '';
  if (pick) {
    const clone = pick.cloneNode(true);
    clone.querySelectorAll('nav, header, footer, aside, script, style, noscript, form, svg, iframe, [aria-hidden=true], [hidden]').forEach(n => n.remove());
    // innerText needs layout; a detached clone has none, so fall back to textContent with block breaks.
    clone.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, br, div, section, tr').forEach(n => n.append('\n'));
    text = clone.textContent || '';
    if (text.trim().length < 50 && document.body) text = document.body.innerText || text;
  }
  const desc = document.querySelector('meta[name=description], meta[property="og:description"]')?.content || '';
  return { title: document.title, lang: document.documentElement.lang || '', desc, text: text.slice(0, 120000) };
}

/**
 * Read a tab's text. Never reloads sleeping tabs. Returns {title, url, lang, text, readable, reason}.
 */
export async function extractTab(tab, { access }) {
  const url = tab.url || tab.pendingUrl || '';
  const base = { title: tab.title || url, url, lang: '', text: '', readable: false, reason: '' };
  if (tab.incognito) return { ...base, reason: 'incognito' };
  if (!isReadableUrl(url)) return { ...base, reason: 'restricted' };
  if (tab.discarded || tab.frozen) return { ...base, reason: 'sleeping' };
  if (!access) return { ...base, reason: 'no-access' };
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractInPage });
    const r = res?.result;
    if (!r) return { ...base, reason: 'failed' };
    const text = cleanText([r.desc, r.text].filter(Boolean).join('\n\n')).slice(0, 100000);
    return { ...base, title: r.title || base.title, lang: langCode(r.lang), text, readable: text.length > 0, reason: text ? '' : 'empty' };
  } catch {
    return { ...base, reason: 'restricted' };
  }
}

/* ---------- cache ---------- */

let memCache = null;
async function loadCache() {
  if (!memCache) memCache = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
  return memCache;
}
async function cacheGet(key) { return (await loadCache())[key] || null; }
async function cachePut(key, value) {
  const c = await loadCache();
  c[key] = { ...value, at: Date.now() };
  memCache = pruneCache(c);
  await chrome.storage.local.set({ [CACHE_KEY]: memCache });
}
export async function clearCache() { memCache = {}; await chrome.storage.local.remove(CACHE_KEY); }
export async function cacheSize() { return Object.keys(await loadCache()).length; }

/* ---------- on-device engine ---------- */

const uiLang = () => langCode(chrome.i18n?.getUILanguage?.() || navigator.language) || 'en';
const localOut = () => (ON_DEVICE_LANGS.includes(uiLang()) ? uiLang() : 'en');

function localOptions({ type, length, lang, sharedContext }) {
  const o = { type, format: 'markdown', length, outputLanguage: localOut() };
  if (lang && ON_DEVICE_LANGS.includes(lang)) o.expectedInputLanguages = [lang];
  if (sharedContext) o.sharedContext = sharedContext;
  return o;
}

export async function localAvailability(opts = { type: 'key-points', format: 'markdown', length: 'short', outputLanguage: localOut() }) {
  if (!('Summarizer' in self)) return 'unavailable';
  try { return await self.Summarizer.availability(opts); } catch { return 'unavailable'; }
}

const pool = new Map();
let idleTimer = null;
function touchPool() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { for (const s of pool.values()) s.then(x => x.destroy?.()).catch(() => {}); pool.clear(); }, 5 * 60 * 1000);
}
addEventListener('pagehide', () => { for (const s of pool.values()) s.then(x => x.destroy?.()).catch(() => {}); pool.clear(); });

async function getSummarizer(opts, onProgress) {
  const k = JSON.stringify(opts);
  touchPool();
  if (!pool.has(k)) {
    const p = self.Summarizer.create({
      ...opts,
      monitor(m) { m.addEventListener('downloadprogress', e => onProgress?.(e.total ? e.loaded / e.total : e.loaded)); },
    });
    pool.set(k, p);
    p.catch(() => pool.delete(k));
  }
  try {
    return await pool.get(k);
  } catch (e) {
    if (e?.name === 'NotAllowedError') throw new AiError('Chrome needs a click to start downloading the on-device model. Press Summarize again.', 'gesture');
    throw new AiError(`The on-device model couldn’t start: ${e?.message || e}`, 'local');
  }
}

async function streamLocal(s, text, context, signal, onChunk) {
  let acc = '';
  if (typeof s.summarizeStreaming !== 'function') {
    acc = await s.summarize(text, { context, signal });
    onChunk?.(acc);
    return acc;
  }
  for await (const chunk of s.summarizeStreaming(text, { context, signal })) {
    // Older Chrome builds sent the whole text so far; newer ones send deltas.
    acc = chunk.startsWith(acc) && acc ? chunk : acc + chunk;
    onChunk?.(acc);
  }
  return acc;
}

async function fits(s, text) {
  if (typeof s.measureInputUsage === 'function' && Number.isFinite(s.inputQuota)) {
    try { return (await s.measureInputUsage(text)) <= s.inputQuota; } catch {}
  }
  return text.length <= 4000;
}

/** Summarize text on-device, splitting long text and summarizing the parts first. */
async function summarizeLocal(text, { type, length, lang, sharedContext, context, signal, onChunk, onProgress }) {
  const s = await getSummarizer(localOptions({ type, length, lang, sharedContext }), onProgress);
  if (await fits(s, text)) return { text: await streamLocal(s, text, context, signal, onChunk), partial: false };
  const { chunks, truncated } = chunkText(text, 3000, 6);
  const tl = await getSummarizer(localOptions({ type: 'tldr', length: 'short', lang, sharedContext }), onProgress);
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    onChunk?.(`_Reading part ${i + 1} of ${chunks.length}…_`);
    parts.push(await tl.summarize(chunks[i], { context, signal }));
  }
  return { text: await streamLocal(s, parts.join('\n\n'), context, signal, onChunk), partial: truncated };
}

/* ---------- cloud engine ---------- */

async function streamGemini({ key, model, system, user, signal, onChunk }, retried = false) {
  const { url, body } = geminiRequest({ model, system, user });
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new AiError('Couldn’t reach Gemini. Check your connection.', 'network');
  }
  if (!res.ok) {
    const err = geminiError(res.status, await res.text().catch(() => ''));
    if (err.code === 'rate' && !retried && err.retry > 0 && err.retry <= 10) {
      await new Promise(r => setTimeout(r, err.retry * 1000));
      return streamGemini({ key, model, system, user, signal, onChunk }, true);
    }
    throw new AiError(err.message, err.code);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', acc = '', blocked = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const r = parseSse(buf + dec.decode(value, { stream: true }));
    buf = r.rest;
    blocked ||= r.blocked;
    if (r.texts.length) { acc += r.texts.join(''); onChunk?.(acc); }
  }
  if (buf) { const r = parseSse(buf + '\n'); blocked ||= r.blocked; if (r.texts.length) { acc += r.texts.join(''); onChunk?.(acc); } }
  if (!acc.trim()) throw new AiError(blocked ? 'Gemini declined to summarize this.' : 'Gemini returned an empty summary.', blocked ? 'blocked' : 'empty');
  return acc;
}

export async function testApiKey(key) {
  let res;
  try {
    res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key } });
  } catch {
    throw new AiError('Couldn’t reach Gemini. Check your connection.', 'network');
  }
  if (!res.ok) throw new AiError(geminiError(res.status, await res.text().catch(() => '')).message, 'key');
  return true;
}

/* ---------- public entry points ---------- */

/** What each engine can do right now. */
export async function engineState() {
  const [settings, key, local] = await Promise.all([getSettings(), getApiKey(), localAvailability()]);
  return { settings, hasKey: !!key, local };
}

function pickEngine(kind, settings, local, hasKey) {
  const e = chooseEngine({ kind, setting: settings.engine, local, hasKey });
  if (e) return e;
  if (settings.engine === 'cloud') throw new AiError('Add a Gemini API key in AI settings to use the cloud engine.', 'no-engine');
  if (settings.engine === 'local') throw new AiError('On-device AI isn’t available on this device or for this language. Add a Gemini API key in AI settings to use the cloud instead.', 'no-engine');
  throw new AiError('On-device AI isn’t available here (it needs desktop Chrome 138+ with enough memory and disk). Add a Gemini API key in AI settings to use Gemini instead.', 'no-engine');
}

/**
 * Which engine a summary would use, so the page can ask for cloud consent before starting.
 * Returns 'local' | 'cloud' (throws AiError when neither works).
 */
export async function plannedEngine(kind) {
  const { settings, hasKey, local } = await engineState();
  return pickEngine(kind, settings, local, hasKey);
}

/**
 * Summarize one tab.
 * opts: { groupName, force, signal, onChunk(text), onProgress(fraction), onStatus(text), access }
 * Returns { text, engine, at, readable, reason, cached, partial }.
 */
export async function summarizeTab(tab, opts = {}) {
  const { settings, hasKey, local } = await engineState();
  const engine = pickEngine('tab', settings, local, hasKey);
  return summarizeTabWith(engine, tab, settings, opts);
}

async function summarizeTabWith(engine, tab, settings, opts, type) {
  const { groupName, force, signal, onChunk, onProgress } = opts;
  const page = await extractTab(tab, { access: opts.access });
  const instructions = instructionsFor(settings, groupName);
  const kind = type || 'key-points';
  const key = cacheKey(['tab', engine, engine === 'cloud' ? settings.model : '', kind, settings.length, instructions, page.url, fnv(page.text)]);
  if (!force) {
    const hit = await cacheGet(key);
    if (hit) { onChunk?.(hit.text); return { ...hit, readable: page.readable, reason: page.reason, cached: true }; }
  }
  let text, partial = false;
  if (engine === 'cloud') {
    const apiKey = await getApiKey();
    const { system, user } = tabPrompt({ ...page, length: settings.length, instructions, lang: uiLang() });
    text = await streamGemini({ key: apiKey, model: settings.model, system, user, signal, onChunk });
  } else {
    const input = page.text || `${page.title}\n${page.url}`;
    const r = await summarizeLocal(input, {
      type: kind, length: settings.length, lang: page.lang,
      sharedContext: localContext('tab', { instructions }),
      context: `Page title: ${page.title}`, signal, onChunk, onProgress,
    });
    text = r.text; partial = r.partial;
  }
  const out = { text: text.trim(), engine, partial };
  await cachePut(key, out);
  return { ...out, at: Date.now(), readable: page.readable, reason: page.reason, cached: false };
}

/**
 * Summarize a group: "what is this group about".
 * group: { name, tabs: chrome.tabs.Tab[] }
 * opts as summarizeTab, plus onStatus(text) for "Reading 3 of 9 tabs…".
 * Returns { text, engine, at, cached, unreadable: [{title, url, reason}], skipped }.
 */
export async function summarizeGroup(group, opts = {}) {
  const { force, signal, onChunk, onProgress, onStatus } = opts;
  const { settings, hasKey, local } = await engineState();
  const engine = pickEngine('group', settings, local, hasKey);
  const instructions = instructionsFor(settings, group.name);
  const cap = engine === 'cloud' ? MAX_GROUP_TABS : MAX_LOCAL_GROUP_TABS;
  const sorted = [...group.tabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const picked = sorted.slice(0, cap);
  const skipped = sorted.length - picked.length;

  const pages = [];
  for (let i = 0; i < picked.length; i++) {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    onStatus?.(`Reading tab ${i + 1} of ${picked.length}…`);
    pages.push(await extractTab(picked[i], { access: opts.access }));
  }
  const unreadable = pages.filter(p => !p.readable).map(p => ({ title: p.title, url: p.url, reason: p.reason }));
  const key = cacheKey(['group', engine, engine === 'cloud' ? settings.model : '', settings.length, instructions, group.name, pages.map(p => [p.url, fnv(p.text)])]);
  if (!force) {
    const hit = await cacheGet(key);
    if (hit) { onChunk?.(hit.text); return { ...hit, cached: true, unreadable, skipped }; }
  }

  let text;
  if (engine === 'cloud') {
    onStatus?.('Asking Gemini…');
    const apiKey = await getApiKey();
    const { system, user } = groupPrompt({ name: group.name, tabs: pages, instructions, lang: uiLang() });
    text = await streamGemini({ key: apiKey, model: settings.model, system, user, signal, onChunk });
  } else {
    // Gemini Nano works best on one document at a time: summarize each tab briefly, then summarize those.
    const lines = [];
    for (let i = 0; i < picked.length; i++) {
      if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
      onStatus?.(`Summarizing tab ${i + 1} of ${picked.length} on this device…`);
      const p = pages[i];
      if (!p.readable) { lines.push(`- ${p.title} (${p.url})`); continue; }
      const r = await summarizeTabWith('local', picked[i], { ...settings, length: 'short' }, { groupName: group.name, signal, onProgress, access: opts.access }, 'tldr');
      lines.push(`- ${p.title}: ${r.text.replace(/\s+/g, ' ')}`);
    }
    onStatus?.('Putting it together…');
    const r = await summarizeLocal(lines.join('\n'), {
      type: 'tldr', length: 'medium', lang: '',
      sharedContext: localContext('group', { groupName: group.name, instructions }),
      context: `Group name: ${group.name}`, signal, onChunk, onProgress,
    });
    text = r.text;
  }
  const out = { text: text.trim(), engine };
  await cachePut(key, out);
  return { ...out, at: Date.now(), cached: false, unreadable, skipped };
}

/** Start the on-device model download. Call from a click. */
export async function downloadLocalModel(onProgress) {
  const s = await getSummarizer(localOptions({ type: 'key-points', length: 'short' }), onProgress);
  return !!s;
}
