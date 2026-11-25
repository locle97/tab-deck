// AI summaries: settings, page text extraction, saved tab insights (one-sentence summary + status),
// the on-device engines (Chrome's built-in Prompt API, falling back to the Summarizer API; both Gemini Nano)
// and the optional cloud engine (Gemini API with the user's key).
// Runs in the Tab Desk page only: the built-in AI APIs aren't available in service workers.

import {
  DEFAULT_SETTINGS, normalizeSettings, instructionsFor, chooseEngine, cleanText, langCode,
  isReadableUrl, tabPrompt, groupPrompt, localContext, geminiRequest, parseSse, geminiError,
  baseTabPrompt, tabInstructionBlock, draftPrompt, cleanDraft, pickInstructions, INSTRUCTION_TEMPLATE, DEFAULT_TAB_INSTRUCTIONS,
  cacheKey, fnv, pruneCache, ON_DEVICE_LANGS, MAX_GROUP_TABS, INSIGHT_SCHEMA, parseInsight, oneSentence,
  insightKey, groupKey, normalizeStatus, INSIGHT_TTL, INSIGHT_MAX, headTail, PROMPT_VERSION,
  sentencePrompt, SENTENCE_SCHEMA, templateSentence, STATUSES,
} from './ai-core.js';
import { fieldPlanFor, decideStatus, foundAny, factsLine, fieldsBlock } from './fields.js';

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

export { DEFAULT_SETTINGS, instructionsFor, pickInstructions, baseTabPrompt, INSTRUCTION_TEMPLATE, DEFAULT_TAB_INSTRUCTIONS };

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
  // Prefer the page's main area. (Not the first <article>: on apps like GitHub that can be a single
  // comment, which hides the pull request's own state.)
  const pick = document.querySelector('main, [role=main]') || document.querySelector('article') || document.body;
  let text = '';
  if (pick) {
    const clone = pick.cloneNode(true);
    // Icons carry state that text alone misses (a green check next to a reviewer, a yellow dot on a
    // running check). Turn each icon into a short text label before anything is removed: its own
    // label or tooltip if it has one, else what its icon name and color mean.
    const ICON_MEANING = { 'check': 'passed/approved', 'check-circle': 'passed/approved', 'check-circle-fill': 'passed/approved',
      'x': 'failed', 'x-circle': 'failed', 'x-circle-fill': 'failed', 'stop': 'failed', 'dot-fill': 'pending', 'dot': 'pending',
      'clock': 'waiting', 'hourglass': 'waiting', 'sync': 'in progress', 'skip': 'skipped', 'skip-fill': 'skipped',
      'file-diff': 'changes requested', 'request-changes': 'changes requested', 'eye': 'review requested', 'comment': 'commented',
      'git-merge': 'merged', 'git-pull-request': 'open pull request', 'git-pull-request-closed': 'closed pull request',
      'git-pull-request-draft': 'draft pull request', 'issue-opened': 'open issue', 'issue-closed': 'closed issue',
      'alert': 'warning', 'alert-fill': 'warning', 'blocked': 'blocked', 'circle-slash': 'blocked', 'lock': 'locked' };
    const COLOR = { success: 'green', danger: 'red', attention: 'yellow', severe: 'orange', done: 'purple', accent: 'blue', open: 'green', closed: 'red' };
    const iconText = el => {
      const own = (el.getAttribute('aria-label') || el.querySelector?.('title')?.textContent || el.getAttribute('title') || el.getAttribute('alt') || '').replace(/\s+/g, ' ').trim();
      const cls = `${el.getAttribute('class') || ''} ${el.parentElement?.getAttribute('class') || ''}`;
      const name = /octicon-([a-z0-9-]+?)(?:-\d+)?(?=\s|$)/.exec(cls)?.[1] || '';
      const color = Object.entries(COLOR).find(([k]) => new RegExp(`(color-fg-|fgColor-|text-|-)${k}\\b`).test(cls))?.[1] || '';
      const spinning = /anim-rotate|spinner|animate-spin/.test(cls);
      const meaning = own || ICON_MEANING[name] || (spinning ? 'in progress' : '');
      if (!meaning || meaning.length > 80) return '';
      return ` [icon: ${meaning}${color && !own ? `, ${color}` : ''}] `;
    };
    // Short labels on elements with no visible text (icon buttons, status links).
    clone.querySelectorAll('[aria-label]:not(svg):not(img)').forEach(el => {
      if (!el.textContent.trim()) { const v = el.getAttribute('aria-label').trim(); if (v && v.length <= 80) el.append(` [${v}] `); }
    });
    clone.querySelectorAll('svg, img, [role=img]').forEach(el => {
      if (el.closest('svg') && el.closest('svg') !== el) return;
      // An icon on a button that has its own text or label is decoration ("Close pull request",
      // the check on a "Copy" button), and reading it as state would mislead the AI.
      const btn = el.parentElement?.closest('button, [role=button], a[role=menuitem], clipboard-copy, summary');
      if (btn && (btn.getAttribute('aria-label') || btn.textContent.trim())) { el.remove(); return; }
      const t = el.tagName === 'IMG' && !el.getAttribute('alt') ? '' : iconText(el);
      el.replaceWith(document.createTextNode(t));
    });
    // Drop page chrome, but keep <form> and in-page <header>: apps put real state in them
    // (GitHub's merge box and review status, a PR's title and Open/Merged badge).
    clone.querySelectorAll('nav, footer, aside, script, style, noscript, template, svg, iframe, textarea, select, dialog, [role=navigation], [role=contentinfo], [role=dialog], [role=menu], [popover]:not(tool-tip), [aria-hidden=true], [hidden]').forEach(n => n.remove());
    // innerText needs layout; a detached clone has none, so fall back to textContent with block breaks.
    clone.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, br, div, section, tr, header, form').forEach(n => n.append('\n'));
    text = clone.textContent || '';
    if (text.trim().length < 50 && document.body) text = document.body.innerText || text;
  }
  // Short status signals the page shows on badges and in status areas, e.g. GitHub's
  // "Status: Merged", "Review required", "All checks have passed". Put first so they're never cut off.
  const seen = new Set();
  const states = [];
  const sel = '[title^="Status:" i], .State, [class*="StateLabel"], [data-testid*="state" i], [data-status], [aria-label^="Status" i], .merge-status-list .status-heading, .mergeability-details .status-heading, .branch-action-item .status-heading, [class*="MergeBox"] h3, [class*="mergeBox"] h3';
  for (const el of document.querySelectorAll(sel)) {
    const v = (el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (v && v.length <= 120 && !seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); states.push(v); }
    if (states.length >= 8) break;
  }
  const desc = document.querySelector('meta[name=description], meta[property="og:description"]')?.content || '';
  return { title: document.title, lang: document.documentElement.lang || '', desc, states, text: text.slice(0, 120000) };
}

// Runs inside the page. Must be self-contained. Reads the page fields of a rule (see fields.js) from the
// live page, so text needs no clean-up: innerText of a live element is what the person sees.
function extractFieldsInPage(fields) {
  const MAXV = 200, MAXL = 20;
  const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, MAXV);
  const textOf = el => clean(el.innerText ?? el.textContent);
  const visible = el => !!(el.offsetParent || el.getClientRects?.().length) || el.tagName === 'META' || el.tagName === 'LINK';
  const byLabel = label => {
    const want = label.trim().toLowerCase().replace(/:$/, '');
    const out = [];
    const all = document.querySelectorAll('dt, th, label, span, div, p, strong, b, h1, h2, h3, h4, h5, h6, td, li');
    for (const el of all) {
      if (el.childElementCount > 2) continue;
      const own = clean(el.textContent).toLowerCase().replace(/:$/, '');
      if (own !== want || !visible(el)) continue;
      // The value is the next element (a <dd>, the next cell, the next span), else the rest of the parent's text.
      let v = '';
      let sib = el.nextElementSibling;
      while (sib && !v) { v = textOf(sib); sib = sib.nextElementSibling; }
      if (!v && el.parentElement) {
        const whole = textOf(el.parentElement);
        v = clean(whole.slice(whole.toLowerCase().indexOf(want) + want.length).replace(/^\s*:?\s*/, ''));
      }
      if (v) out.push(v);
      if (out.length >= MAXL) break;
    }
    return out;
  };
  const values = {};
  for (const f of fields || []) {
    let found = [];
    try {
      if (f.kind === 'label') found = byLabel(f.label);
      else {
        for (const el of document.querySelectorAll(f.selector)) {
          if (!f.attr && !visible(el)) continue;
          const v = f.attr ? clean(el.getAttribute(f.attr)) : textOf(el);
          if (v && !found.includes(v)) found.push(v);
          if (found.length >= (f.list ? MAXL : 1)) break;
        }
      }
    } catch {}
    values[f.name] = f.list ? found : (found[0] || '');
  }
  return values;
}

/** Read a rule's page fields from an open tab, for the "Test" button in Settings. */
export async function readFields(tab, fields) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractFieldsInPage, args: [fields] });
  return { title: tab.title || '', url: tab.url || '', ...(res?.result || {}) };
}

/**
 * Read a tab's text. Never reloads sleeping tabs. Returns {title, url, lang, text, readable, reason}.
 */
export async function extractTab(tab, { access, fields = null }) {
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
    const states = Array.isArray(r.states) && r.states.length ? `Page state: ${r.states.join(' · ')}` : '';
    const text = cleanText([states, r.desc, r.text].filter(Boolean).join('\n\n')).slice(0, 100000);
    let values = null;
    if (fields?.length) {
      try {
        const [fr] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractFieldsInPage, args: [fields] });
        values = fr?.result || null;
      } catch {}
    }
    return { ...base, title: r.title || base.title, lang: langCode(r.lang), text, readable: text.length > 0, reason: text ? '' : 'empty', ...(values ? { fields: values } : {}) };
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
    const system = baseTabPrompt(localOut());
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

/* ---------- prompt log (for debugging) ---------- */
// Every prompt sent to a model, with its answer, is kept in chrome.storage.local (last LOG_MAX) and
// printed with console.debug. In Tab Desk's DevTools console: tabDeskAiLog() shows them,
// tabDeskAiLog.clear() empties the log. There is no UI for it on purpose.
const LOG_KEY = 'aiPromptLog';
const LOG_MAX = 30;
const LOG_TEXT_MAX = 30000;
let logChain = Promise.resolve();
const clipLog = t => (typeof t === 'string' && t.length > LOG_TEXT_MAX ? `${t.slice(0, LOG_TEXT_MAX)}\n…[${t.length - LOG_TEXT_MAX} more characters not logged]` : t);

/** Runs one model call and logs what was sent and what came back. entry: { kind, engine, api?, model?, title?, url?, group?, system, user } */
async function logged(entry, run) {
  const t0 = Date.now();
  let output, error;
  try {
    output = await run();
    return output;
  } catch (e) {
    error = e?.name === 'AbortError' ? 'Stopped' : (e?.message || String(e));
    throw e;
  } finally {
    const rec = {
      at: new Date(t0).toISOString(), ms: Date.now() - t0, ...entry,
      system: clipLog(entry.system || ''), user: clipLog(entry.user || ''),
      output: typeof output === 'string' ? output : output == null ? '' : JSON.stringify(output),
      ...(error ? { error } : {}),
    };
    try { console.debug(`[Tab Desk AI] ${rec.kind} · ${rec.engine}${rec.model ? ` (${rec.model})` : rec.api ? ` (${rec.api})` : ''}${rec.title || rec.group ? ` · ${rec.title || rec.group}` : ''}`, rec); } catch {}
    logChain = logChain.then(async () => {
      const { [LOG_KEY]: list = [] } = await chrome.storage.local.get(LOG_KEY);
      list.push(rec);
      await chrome.storage.local.set({ [LOG_KEY]: list.slice(-LOG_MAX) });
    }).catch(() => {});
  }
}

/** The logged prompts, oldest first. */
export async function promptLog() {
  await logChain;
  return (await chrome.storage.local.get(LOG_KEY))[LOG_KEY] || [];
}
export async function clearPromptLog() {
  await logChain;
  await chrome.storage.local.remove(LOG_KEY);
}

async function localInsight(page, instructions, { api, signal, onProgress }) {
  const text = page.text ? headTail(page.text, 6000) : '';
  if (api === 'prompt') {
    const base = await getBaseSession(onProgress);
    const s = await base.clone({ signal });
    try {
      const user = `${tabInstructionBlock(instructions)}\n\nTitle: ${page.title}\nURL: ${page.url}\n<page>\n${text || '(The page text could not be read. Work from the title and URL only.)'}\n</page>`;
      const out = await logged({ kind: 'tab', engine: 'local', api: 'prompt', title: page.title, url: page.url, system: baseTabPrompt(localOut()), user },
        () => s.prompt(user, { responseConstraint: INSIGHT_SCHEMA, signal }));
      return parseInsight(out);
    } finally { s.destroy?.(); }
  }
  const sharedContext = localContext('tab', { instructions });
  const sum = await getSummarizer(sumOptions({ lang: page.lang, sharedContext }), onProgress);
  const input = text || `${page.title}\n${page.url}`;
  const out = await logged({ kind: 'tab', engine: 'local', api: 'summarizer', title: page.title, url: page.url, system: `${sharedContext}\nContext: Page title: ${page.title}`, user: input },
    () => sum.summarize(input, { context: `Page title: ${page.title}`, signal }));
  return { summary: oneSentence(out), status: null };
}

async function localGroupSentence(name, lines, instructions, { api, signal, onProgress, onChunk }) {
  const input = lines.join('\n').slice(0, 6000);
  if (api === 'prompt') {
    const system = groupPrompt({ name, tabs: [], instructions, lang: localOut() }).system;
    const s = await self.LanguageModel.create({
      ...lmIO(),
      initialPrompts: [{ role: 'system', content: system }],
      monitor(m) { m.addEventListener('downloadprogress', e => onProgress?.(e.total ? e.loaded / e.total : e.loaded)); },
    }).catch(e => { throw gestureError(e); });
    try {
      const user = `Tabs in "${name}":\n${input}`;
      const out = await logged({ kind: 'group', engine: 'local', api: 'prompt', group: name, system, user }, () => s.prompt(user, { signal }));
      onChunk?.(out);
      return out;
    } finally { s.destroy?.(); }
  }
  const sharedContext = localContext('group', { groupName: name, instructions });
  const sum = await getSummarizer(sumOptions({ sharedContext }), onProgress);
  const out = await logged({ kind: 'group', engine: 'local', api: 'summarizer', group: name, system: `${sharedContext}\nContext: Group name: ${name}`, user: input },
    () => sum.summarize(input, { context: `Group name: ${name}`, signal }));
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
  if (settings.engine === 'cloud') throw new AiError('Add a Gemini API key in Settings to use the cloud engine.', 'no-engine');
  if (settings.engine === 'local') throw new AiError('On-device AI isn’t available on this device. Add a Gemini API key in Settings to use the cloud instead.', 'no-engine');
  throw new AiError('On-device AI isn’t available here (it needs desktop Chrome 138+ with enough memory and disk). Add a Gemini API key in Settings to use Gemini instead.', 'no-engine');
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
  // Page fields and status rules (fields.js): when a rule or preset has them, read those values from the
  // page and let the status rules decide the status in code. The AI then only writes the sentence.
  const plan = opts.access ? fieldPlanFor(st.settings, tab.url || tab.pendingUrl || '') : null;
  let engine = null, engineErr = null;
  try { engine = opts.engine || pickEngine('tab', st.settings, st.local, st.hasKey); } catch (e) { engineErr = e; }
  const page = await extractTab(tab, { access: opts.access, fields: plan?.fields });
  const instructions = instructionsFor(st.settings, opts.groupName, page.url);
  let fieldInfo = null;
  if (plan && page.fields && foundAny(plan.fields, page.fields)) {
    const values = { title: page.title, url: page.url, ...page.fields };
    const decided = decideStatus(plan.rules, values);
    fieldInfo = {
      values: page.fields, facts: factsLine(plan.fields, page.fields), pattern: plan.pattern, source: plan.source,
      status: decided && decided.status !== 'unknown' ? decided.status : null, ruleIndex: decided ? decided.index : -1,
    };
  }
  if (!engine && !fieldInfo?.status) throw engineErr;
  const sig = cacheKey([PROMPT_VERSION, engine, engine === 'cloud' ? st.settings.model : st.localApi, instructions, fnv(page.text), page.title,
    fieldInfo ? [fieldInfo.values, fieldInfo.pattern, plan.rules] : null]);
  const prev = tabInsight(page.url);
  if (!opts.force && prev?.sig === sig && prev.summary) return putInsight(page.url, {});
  let r;
  if (fieldInfo?.status) {
    r = await fieldSentence(page, fieldInfo, instructions, engine, st, opts);
    r.status = fieldInfo.status;
    r.facts = fieldInfo.facts;
  } else {
    // No status from the fields: the AI decides as before, with the fields it could read put first.
    const ai = fieldInfo ? { ...page, text: `Page fields (read from the page by code, trust these):\n${fieldsBlock(plan.fields, fieldInfo.values)}\n\n${page.text}` } : page;
    if (engine === 'cloud') {
      const { system, user } = tabPrompt({ ...ai, instructions, lang: uiLang() });
      const key = await getApiKey();
      r = parseInsight(await logged({ kind: 'tab', engine: 'cloud', model: st.settings.model, title: page.title, url: page.url, system, user },
        () => streamGemini({ key, model: st.settings.model, system, user, json: true, signal: opts.signal })));
    } else {
      r = await localInsight(ai, instructions, { api: st.localApi, signal: opts.signal, onProgress: opts.onProgress });
    }
  }
  if (!r.summary) throw new AiError('The AI returned an empty summary.', 'empty');
  // A status set by hand was about the page as it was. The page has changed, so the new analysis wins:
  // otherwise a stale "Needs you" sits next to a summary that says the PR is merged.
  const textSig = fnv(page.text + (fieldInfo ? JSON.stringify(fieldInfo.values) : ''));
  const changed = prev && prev.textSig && prev.textSig !== textSig;
  return putInsight(page.url, {
    summary: r.summary, status: r.status, facts: r.facts || '', engine: r.engine || engine, sig, textSig,
    reason: page.reason, readable: page.readable, title: page.title,
    statusFrom: fieldInfo?.status ? 'fields' : 'ai',
    fieldRule: fieldInfo ? (plan.preset || plan.pattern) : undefined,
    ...(changed || opts.force ? { manual: undefined } : {}),
  });
}

/** The sentence for a tab whose status the page fields decided. Falls back to a template without a model. */
async function fieldSentence(page, info, instructions, engine, st, opts) {
  const excerpt = page.text || '';
  const facts = info.facts;
  const status = info.status;
  const meta = { kind: 'tab', title: page.title, url: page.url, fields: info.values, status, statusFrom: 'fields' };
  try {
    if (engine === 'cloud') {
      const { system, user } = sentencePrompt({ ...page, facts, status, excerpt, instructions, lang: uiLang(), max: 3000 });
      const key = await getApiKey();
      return parseInsight(await logged({ ...meta, engine: 'cloud', model: st.settings.model, system, user },
        () => streamGemini({ key, model: st.settings.model, system, user, json: 'sentence', signal: opts.signal })));
    }
    if (engine === 'local' && st.localApi === 'prompt') {
      const { system, user } = sentencePrompt({ ...page, facts, status, excerpt, instructions, lang: localOut() });
      const s = await self.LanguageModel.create({ ...lmIO(), initialPrompts: [{ role: 'system', content: system }],
        monitor(m) { m.addEventListener('downloadprogress', e => opts.onProgress?.(e.total ? e.loaded / e.total : e.loaded)); } }).catch(e => { throw gestureError(e); });
      try {
        return parseInsight(await logged({ ...meta, engine: 'local', api: 'prompt', system, user },
          () => s.prompt(user, { responseConstraint: SENTENCE_SCHEMA, signal: opts.signal })));
      } finally { s.destroy?.(); }
    }
    if (engine === 'local') {
      const sharedContext = localContext('tab', { instructions });
      const sum = await getSummarizer(sumOptions({ lang: page.lang, sharedContext }), opts.onProgress);
      const input = `State: ${facts}\n\n${headTail(excerpt, 3000)}`;
      const out = await logged({ ...meta, engine: 'local', api: 'summarizer', system: sharedContext, user: input },
        () => sum.summarize(input, { context: `Page title: ${page.title}`, signal: opts.signal }));
      return { summary: oneSentence(out) };
    }
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    // The status is known; don't lose it because the sentence failed. Use the template instead.
    return { summary: templateSentence({ title: page.title, facts }), engine: 'none' };
  }
  return { summary: templateSentence({ title: page.title, facts }), engine: 'none' };
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
    const key = await getApiKey();
    text = await logged({ kind: 'group', engine: 'cloud', model: st.settings.model, group: group.name, system, user },
      () => streamGemini({ key, model: st.settings.model, system, user, signal, onChunk }));
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
/**
 * Drafts instructions for a page rule by filling in INSTRUCTION_TEMPLATE from one example page.
 * opts: { pattern, tab (an open tab matching the pattern, or null), access, signal }
 * Only the title and address are sent to Gemini unless the user has agreed to send page content.
 */
export async function draftInstructions({ pattern, tab = null, access = false, signal } = {}) {
  const st = await engineState();
  const engine = pickEngine('tab', st.settings, st.local, st.hasKey);
  const cloudOk = engine !== 'cloud' || !!st.settings.cloudConsentAt;
  const page = tab ? await extractTab(tab, { access: access && cloudOk }) : { title: '', url: '', text: '' };
  let out;
  if (engine === 'cloud') {
    const { system, user } = draftPrompt({ pattern, ...page, lang: uiLang() });
    const key = await getApiKey();
    out = await logged({ kind: 'draft', engine: 'cloud', model: st.settings.model, title: page.title, url: page.url, pattern, system, user },
      () => streamGemini({ key, model: st.settings.model, system, user, signal }));
  } else {
    if (st.localApi !== 'prompt') throw new AiError('Drafting needs Chrome’s Prompt API or a Gemini key.', 'no-engine');
    const { system, user } = draftPrompt({ pattern, ...page, lang: localOut(), max: 5000 });
    const s = await self.LanguageModel.create({ ...lmIO(), initialPrompts: [{ role: 'system', content: system }] }).catch(e => { throw gestureError(e); });
    try { out = await logged({ kind: 'draft', engine: 'local', api: 'prompt', title: page.title, url: page.url, pattern, system, user }, () => s.prompt(user, { signal })); } finally { s.destroy?.(); }
  }
  const text = cleanDraft(out);
  if (!text) throw new AiError('The AI returned an empty draft.', 'empty');
  return text;
}

export async function downloadLocalModel(onProgress) {
  const { api } = await localAvailability();
  if (api === 'prompt') await getBaseSession(onProgress);
  else if (api === 'summarizer') await getSummarizer(sumOptions(), onProgress);
  else throw new AiError('On-device AI isn’t available on this device.', 'local');
  return true;
}
