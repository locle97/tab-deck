// AI summaries: settings, page text extraction, saved tab insights (one-sentence summary + status),
// the on-device engines (Chrome's built-in Prompt API, falling back to the Summarizer API; both Gemini Nano)
// and the optional cloud engine (Gemini API with the user's key).
// Runs in the Tab Desk page only: the built-in AI APIs aren't available in service workers.

import {
  DEFAULT_SETTINGS, normalizeSettings, instructionsFor, chooseEngine, cleanText, langCode,
  isReadableUrl, tabPrompt, groupPrompt, localContext, geminiRequest, parseSse, geminiError, userInstructionBlock,
  cacheKey, fnv, pruneCache, ON_DEVICE_LANGS, MAX_GROUP_TABS, INSIGHT_SCHEMA, parseInsight, oneSentence,
  insightKey, groupKey, normalizeStatus, INSIGHT_TTL, INSIGHT_MAX,
} from './ai-core.js';

const SETTINGS_KEY = 'aiSettings';
const API_KEY = 'aiGeminiKey';
const CACHE_KEY = 'aiCache';
const INSIGHTS_KEY = 'aiTabInsights';
const GROUP_INSIGHTS_KEY = 'aiGroupInsights';
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

/* ---------- saved insights ---------- */
// Tab insights are keyed by URL (without #hash) so a summary shows again for the same page after a
// restart. Group insights are keyed by group name, like group instructions.

let insights = null, groupInsights = null;
const listeners = new Set();
export function onInsightsChanged(cb) { listeners.add(cb); }
const emit = () => listeners.forEach(cb => { try { cb(); } catch {} });

export async function loadInsights() {
  if (!insights) {
    const r = await chrome.storage.local.get([INSIGHTS_KEY, GROUP_INSIGHTS_KEY]);
    insights = r[INSIGHTS_KEY] || {};
    groupInsights = r[GROUP_INSIGHTS_KEY] || {};
  }
  return { insights, groupInsights };
}
export const tabInsight = url => insights?.[insightKey(url)] || null;
export const groupInsight = name => groupInsights?.[groupKey(name)] || null;

// Write right away (a page can close at any moment), but never more than one write at a time.
let saving = false, dirty = false;
async function scheduleSave() {
  if (saving) { dirty = true; return; }
  saving = true;
  try {
    do {
      dirty = false;
      insights = pruneCache(insights, Date.now(), INSIGHT_TTL, INSIGHT_MAX);
      await chrome.storage.local.set({ [INSIGHTS_KEY]: insights, [GROUP_INSIGHTS_KEY]: groupInsights });
    } while (dirty);
  } finally { saving = false; }
}
function putInsight(url, data) {
  const k = insightKey(url);
  const prev = insights[k] || {};
  insights[k] = { ...prev, ...data, at: Date.now() };
  scheduleSave();
  emit();
  return insights[k];
}
/** Set (or clear, with null) the status of a page by hand. A hand-set status wins over the AI's. */
export async function setManualStatus(url, status) {
  await loadInsights();
  const k = insightKey(url);
  const prev = insights[k] || { at: Date.now() };
  insights[k] = { ...prev, manual: normalizeStatus(status) || undefined };
  if (!insights[k].manual) delete insights[k].manual;
  scheduleSave();
  emit();
}
export async function clearGroupInsight(name) {
  await loadInsights();
  delete groupInsights[groupKey(name)];
  scheduleSave();
  emit();
}
export async function clearInsights() {
  insights = {}; groupInsights = {};
  await chrome.storage.local.remove([INSIGHTS_KEY, GROUP_INSIGHTS_KEY, CACHE_KEY]);
  emit();
}
export async function insightCount() { await loadInsights(); return Object.keys(insights).length; }

/* ---------- on-device engines ---------- */

const uiLang = () => langCode(chrome.i18n?.getUILanguage?.() || navigator.language) || 'en';
const localOut = () => (ON_DEVICE_LANGS.includes(uiLang()) ? uiLang() : 'en');
const lmIO = () => ({ expectedInputs: [{ type: 'text', languages: ['en', localOut()].filter((v, i, a) => a.indexOf(v) === i) }], expectedOutputs: [{ type: 'text', languages: [localOut()] }] });

function sumOptions({ type = 'tldr', length = 'short', lang, sharedContext } = {}) {
  const o = { type, format: 'plain-text', length, outputLanguage: localOut() };
  if (lang && ON_DEVICE_LANGS.includes(lang)) o.expectedInputLanguages = [lang];
  if (sharedContext) o.sharedContext = sharedContext;
  return o;
}

async function lmAvailability() {
  if (!('LanguageModel' in self)) return 'unavailable';
  try { return await self.LanguageModel.availability(lmIO()); } catch { return 'unavailable'; }
}
async function sumAvailability() {
  if (!('Summarizer' in self)) return 'unavailable';
  try { return await self.Summarizer.availability(sumOptions()); } catch { return 'unavailable'; }
}
const RANK = { available: 0, downloading: 1, downloadable: 2, unavailable: 3 };

/** Best on-device option. Prefers the Prompt API, which can also judge a status. */
export async function localAvailability() {
  const [lm, sum] = await Promise.all([lmAvailability(), sumAvailability()]);
  const api = lm !== 'unavailable' && RANK[lm] <= RANK[sum] ? 'prompt' : sum !== 'unavailable' ? 'summarizer' : lm !== 'unavailable' ? 'prompt' : null;
  return { state: api === 'prompt' ? lm : api === 'summarizer' ? sum : 'unavailable', api };
}

const gestureError = e => (e?.name === 'NotAllowedError'
  ? new AiError('Chrome needs a click to start downloading the on-device model. Press the summarize button again.', 'gesture')
  : new AiError(`The on-device model couldn’t start: ${e?.message || e}`, 'local'));

let baseSession = null; // Prompt API session with the tab system prompt; cloned for each tab
let idleTimer = null;
function touchIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(dropSessions, 5 * 60 * 1000);
}
function dropSessions() {
  baseSession?.then(s => s.destroy?.()).catch(() => {});
  baseSession = null;
  for (const s of sumPool.values()) s.then(x => x.destroy?.()).catch(() => {});
  sumPool.clear();
}
addEventListener('pagehide', dropSessions);

function getBaseSession(onProgress) {
  touchIdle();
  if (!baseSession) {
    const { system } = tabPrompt({ title: '', url: '', text: '', instructions: '', lang: localOut() });
    baseSession = self.LanguageModel.create({
      ...lmIO(),
      initialPrompts: [{ role: 'system', content: system }],
      monitor(m) { m.addEventListener('downloadprogress', e => onProgress?.(e.total ? e.loaded / e.total : e.loaded)); },
    });
    baseSession.catch(() => { baseSession = null; });
  }
  return baseSession.catch(e => { throw gestureError(e); });
}

const sumPool = new Map();
function getSummarizer(opts, onProgress) {
  touchIdle();
  const k = JSON.stringify(opts);
  if (!sumPool.has(k)) {
    const p = self.Summarizer.create({ ...opts, monitor(m) { m.addEventListener('downloadprogress', e => onProgress?.(e.total ? e.loaded / e.total : e.loaded)); } });
    sumPool.set(k, p);
    p.catch(() => sumPool.delete(k));
  }
  return sumPool.get(k).catch(e => { throw gestureError(e); });
}

async function localInsight(page, instructions, { api, signal, onProgress }) {
  const text = page.text ? page.text.slice(0, 6000) : '';
  if (api === 'prompt') {
    const base = await getBaseSession(onProgress);
    const s = await base.clone({ signal });
    try {
      const user = `${userInstructionBlock(instructions).trim()}\n\nTitle: ${page.title}\nURL: ${page.url}\n<page>\n${text || '(The page text could not be read. Work from the title and URL only.)'}\n</page>`;
      const out = await s.prompt(user, { responseConstraint: INSIGHT_SCHEMA, signal });
      return parseInsight(out);
    } finally { s.destroy?.(); }
  }
  const sum = await getSummarizer(sumOptions({ lang: page.lang, sharedContext: localContext('tab', { instructions }) }), onProgress);
  const out = await sum.summarize(text || `${page.title}\n${page.url}`, { context: `Page title: ${page.title}`, signal });
  return { summary: oneSentence(out), status: null };
}

async function localGroupSentence(name, lines, instructions, { api, signal, onProgress, onChunk }) {
  const input = lines.join('\n').slice(0, 6000);
  if (api === 'prompt') {
    const s = await self.LanguageModel.create({
      ...lmIO(),
      initialPrompts: [{ role: 'system', content: groupPrompt({ name, tabs: [], instructions, lang: localOut() }).system }],
      monitor(m) { m.addEventListener('downloadprogress', e => onProgress?.(e.total ? e.loaded / e.total : e.loaded)); },
    }).catch(e => { throw gestureError(e); });
    try {
      const out = await s.prompt(`Tabs in "${name}":\n${input}`, { signal });
      onChunk?.(out);
      return out;
    } finally { s.destroy?.(); }
  }
  const sum = await getSummarizer(sumOptions({ sharedContext: localContext('group', { groupName: name, instructions }) }), onProgress);
  const out = await sum.summarize(input, { context: `Group name: ${name}`, signal });
  onChunk?.(out);
  return out;
}

/* ---------- cloud engine ---------- */

async function streamGemini({ key, model, system, user, signal, onChunk, json = false }, retried = false) {
  const { url, body } = geminiRequest({ model, system, user, json });
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
      return streamGemini({ key, model, system, user, signal, onChunk, json }, true);
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
  return { settings, hasKey: !!key, local: local.state, localApi: local.api };
}

function pickEngine(kind, settings, local, hasKey) {
  const e = chooseEngine({ kind, setting: settings.engine, local, hasKey });
  if (e) return e;
  if (settings.engine === 'cloud') throw new AiError('Add a Gemini API key in AI settings to use the cloud engine.', 'no-engine');
  if (settings.engine === 'local') throw new AiError('On-device AI isn’t available on this device. Add a Gemini API key in AI settings to use the cloud instead.', 'no-engine');
  throw new AiError('On-device AI isn’t available here (it needs desktop Chrome 138+ with enough memory and disk). Add a Gemini API key in AI settings to use Gemini instead.', 'no-engine');
}

/** Which engine a summary would use. Returns 'local' | 'cloud' (throws AiError when neither works). */
export async function plannedEngine(kind) {
  const { settings, hasKey, local } = await engineState();
  return pickEngine(kind, settings, local, hasKey);
}

/**
 * Summarize one tab in one sentence and judge its status. The result is saved by URL.
 * opts: { groupName, force, signal, onProgress(fraction), access, engine? }
 * Skips the model when the page text and instructions haven't changed since the last summary.
 * Returns the saved insight: { summary, status, manual?, engine, at, reason, readable }.
 */
export async function summarizeTab(tab, opts = {}) {
  await loadInsights();
  const st = await engineState();
  const engine = opts.engine || pickEngine('tab', st.settings, st.local, st.hasKey);
  const page = await extractTab(tab, { access: opts.access });
  const instructions = instructionsFor(st.settings, opts.groupName, page.url);
  const sig = cacheKey([engine, engine === 'cloud' ? st.settings.model : st.localApi, instructions, fnv(page.text), page.title]);
  const prev = tabInsight(page.url);
  if (!opts.force && prev?.sig === sig && prev.summary) return putInsight(page.url, {});
  let r;
  if (engine === 'cloud') {
    const { system, user } = tabPrompt({ ...page, instructions, lang: uiLang() });
    r = parseInsight(await streamGemini({ key: await getApiKey(), model: st.settings.model, system, user, json: true, signal: opts.signal }));
  } else {
    r = await localInsight(page, instructions, { api: st.localApi, signal: opts.signal, onProgress: opts.onProgress });
  }
  if (!r.summary) throw new AiError('The AI returned an empty summary.', 'empty');
  return putInsight(page.url, { summary: r.summary, status: r.status, engine, sig, reason: page.reason, readable: page.readable, title: page.title });
}

/**
 * One sentence about what a group is about. Uses the saved tab summaries where there are any.
 * group: { name, tabs }. opts: { force, signal, onChunk, onProgress, onStatus, access }
 * Returns the saved group insight: { summary, engine, at, unreadable, skipped }.
 */
export async function summarizeGroup(group, opts = {}) {
  const { force, signal, onChunk, onProgress, onStatus } = opts;
  await loadInsights();
  const st = await engineState();
  const engine = pickEngine('group', st.settings, st.local, st.hasKey);
  const instructions = instructionsFor(st.settings, group.name);
  const sorted = [...group.tabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const picked = sorted.slice(0, MAX_GROUP_TABS);
  const skipped = sorted.length - picked.length;

  const pages = [];
  for (let i = 0; i < picked.length; i++) {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    const t = picked[i];
    const ins = tabInsight(t.url || t.pendingUrl);
    if (ins?.summary && engine === 'local') { pages.push({ title: t.title, url: t.url, summary: ins.summary, readable: true }); continue; }
    onStatus?.(`Reading tab ${i + 1} of ${picked.length}…`);
    const p = await extractTab(t, { access: opts.access });
    pages.push({ ...p, summary: ins?.summary || '' });
  }
  const unreadable = pages.filter(p => !p.readable && !p.summary).map(p => ({ title: p.title, url: p.url, reason: p.reason }));
  const sig = cacheKey(['group', engine, engine === 'cloud' ? st.settings.model : st.localApi, instructions, group.name, pages.map(p => [p.url, p.summary, fnv(p.text || '')])]);
  const prev = groupInsight(group.name);
  if (!force && prev?.sig === sig && prev.summary) { onChunk?.(prev.summary); return prev; }

  let text;
  if (engine === 'cloud') {
    onStatus?.('Asking Gemini…');
    const { system, user } = groupPrompt({ name: group.name, tabs: pages, instructions, lang: uiLang() });
    text = await streamGemini({ key: await getApiKey(), model: st.settings.model, system, user, signal, onChunk });
  } else {
    onStatus?.('Summarizing on this device…');
    const lines = pages.map(p => `- ${p.title}${p.summary ? `: ${p.summary}` : ''}`);
    text = await localGroupSentence(group.name, lines, instructions, { api: st.localApi, signal, onProgress, onChunk });
  }
  const summary = oneSentence(text, 300);
  if (!summary) throw new AiError('The AI returned an empty summary.', 'empty');
  groupInsights[groupKey(group.name)] = { summary, engine, sig, unreadable, skipped, at: Date.now() };
  scheduleSave();
  emit();
  return groupInsights[groupKey(group.name)];
}

/** Start the on-device model download. Call from a click. */
export async function downloadLocalModel(onProgress) {
  const { api } = await localAvailability();
  if (api === 'prompt') await getBaseSession(onProgress);
  else if (api === 'summarizer') await getSummarizer(sumOptions(), onProgress);
  else throw new AiError('On-device AI isn’t available on this device.', 'local');
  return true;
}
