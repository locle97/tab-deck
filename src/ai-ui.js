// AI summaries on the Tab Desk page: a one-sentence summary under every tab, a status for each tab
// (Needs you, In progress, Waiting, Done, Reference) judged by the AI or set by hand, a one-sentence
// summary per group, AI settings, and custom instructions (general, per group, per URL pattern).
// The engines live in lib/ai.js.

import * as AI from './lib/ai.js';
import {
  groupKey, chooseEngine, DEFAULT_MODEL, MAX_INSTRUCTIONS, MAX_RULES, STATUSES, STATUS_ORDER,
  effectiveStatus, rollupStatus, needsInsight, isReadableUrl, compilePattern, suggestPattern, rulesFor,
  INSTRUCTION_TEMPLATE, DEFAULT_TAB_INSTRUCTIONS, baseTabPrompt,
} from './lib/ai-core.js';
import { parseFields, parseStatusRules, decideStatus, factsLine, PRESETS } from './lib/fields.js';

const GEMINI_ORIGINS = ['https://generativelanguage.googleapis.com/*'];
const AI_STUDIO = 'https://aistudio.google.com/apikey';

const IC = {
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3Z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="M13.5 6.5l4 4"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>',
};

let ctx = null;
let state = { settings: AI.DEFAULT_SETTINGS, hasKey: false, local: 'unavailable', localApi: null, access: false };

/* ---------- per-tab work queue ---------- */
const queue = [];            // [{ tabId, force }]
const queued = new Set();    // tab ids waiting
const busy = new Set();      // tab ids running
const tabErrors = new Map(); // tab id -> message
const seen = new Map();      // tab id -> URL already looked at this session (auto mode)
const waiters = new Map();   // tab id -> [resolve]
const groupRuns = new Map(); // group id -> { status, text, statusText, progress, error, code, ctrl }
let workers = 0;

/* ---------- setup ---------- */

export async function initAi(c) {
  ctx = c;
  // Debugging without UI: in Tab Desk's DevTools console, tabDeskAiLog() lists the prompts sent to
  // the AI and its answers (newest last); tabDeskAiLog(n) prints the full text of entry n.
  const log = async n => {
    const list = await AI.promptLog();
    if (n != null) { const e = list.at(n); if (e) console.log(`--- ${e.kind} · ${e.engine} · ${e.at}\n\n[system]\n${e.system}\n\n[user]\n${e.user}\n\n[output]\n${e.output}${e.error ? `\n\n[error]\n${e.error}` : ''}`); return e; }
    console.table(list.map((e, i) => ({ n: i, at: e.at, kind: e.kind, engine: e.engine, model: e.model || e.api || '', page: e.title || e.group || '', ms: e.ms, output: (e.error ? `ERROR: ${e.error}` : e.output).slice(0, 120) })));
    return list;
  };
  log.clear = () => AI.clearPromptLog();
  window.tabDeskAiLog = log;
  await Promise.all([refreshState(), AI.loadInsights()]);
  AI.onSettingsChanged(async () => { await refreshState(); ctx.render(); });
  AI.onInsightsChanged(schedulePaint);
  chrome.permissions.onAdded.addListener(refreshAccess);
  chrome.permissions.onRemoved.addListener(refreshAccess);
  document.getElementById('settingsBtn')?.addEventListener('click', () => openAiSettings());
  paintSideButton();
}

async function refreshState() {
  const [st, access] = await Promise.all([AI.engineState(), AI.hasPageAccess()]);
  state = { ...st, access };
  paintSideButton();
}
async function refreshAccess() { state.access = await AI.hasPageAccess(); }

function paintSideButton() {
  const b = document.getElementById('settingsBtn');
  if (!b) return;
  b.innerHTML = `${IC.gear}<span>Settings</span>`;
}

const esc = s => ctx.esc(s);
export const aiEnabled = () => state.settings.enabled;
const urlOf = t => t.url || t.pendingUrl || '';

/* ---------- markup hooks used by dashboard.js ---------- */

/** Sparkle button on a tab row: summarize this tab again. */
export function tabSumButton(t) {
  if (!aiEnabled()) return '';
  return `<button class="icon-btn" data-act="ai-tab" type="button" title="Summarize tab" aria-label="Summarize ${esc(t.title || 'tab')}">${IC.spark}</button>`;
}

/** Kept for older call sites: tab summaries now show as a line under the title (tabLine). */
export const tabSumRow = () => '';

/** The one-sentence summary under a tab's title. */
export function tabLine(t) {
  if (!aiEnabled() || !state.settings.tabLines) return '';
  return `<span class="ai-line" data-ai-tab="${t.id}">${tabLineInner(t)}</span>`;
}
function tabLineInner(t) {
  if (busy.has(t.id)) return '<span class="ai-spin" aria-hidden="true"></span><span class="ai-dim">Summarizing…</span>';
  if (tabErrors.has(t.id)) return `<span class="ai-bad">${esc(tabErrors.get(t.id))}</span>`;
  const ins = AI.tabInsight(urlOf(t));
  if (ins?.summary) {
    const meta = `${ins.engine === 'cloud' ? 'Gemini · cloud' : ins.engine === 'none' ? 'No AI' : 'On-device'} · ${ago(ins.at)}${ins.readable === false ? ' · from the title only' : ''}${ins.facts ? `\n${ins.facts}` : ''}`;
    return `<span class="ai-sum" title="${esc(ins.summary)}\n${esc(meta)}">${esc(ins.summary)}</span>`;
  }
  if (queued.has(t.id)) return '<span class="ai-dim">Waiting to summarize…</span>';
  return '';
}

/** A tab's status (set by hand or by the AI), or null. How it is worked out stays in here. */
export function tabStatusOf(t) {
  if (!aiEnabled()) return null;
  return effectiveStatus(AI.tabInsight(urlOf(t)));
}

/**
 * Status control for a tab. Default: a pill. `compact`: only the dot. `edge`: a thin colored bar on
 * the row's left edge (dashboard cards), which is also the button that opens the status menu.
 */
export function tabStatus(t, { compact = false, edge = false } = {}) {
  if (!aiEnabled()) return '';
  const mode = edge ? 'edge' : compact ? 'dot' : 'pill';
  return `<span class="ai-st-wrap${edge ? ' edge' : ''}" data-ai-st="${t.id}" data-mode="${mode}">${tabStatusInner(t, mode)}</span>`;
}
function tabStatusInner(t, mode) {
  const compact = mode !== 'pill';
  const ins = AI.tabInsight(urlOf(t));
  const s = effectiveStatus(ins);
  const label = s ? STATUSES[s].label : 'No status';
  if (mode === 'edge') {
    const run = busy.has(t.id) ? ' is-busy' : queued.has(t.id) ? ' is-queued' : '';
    const tip = busy.has(t.id) ? 'Summarizing…' : `${s ? label : 'No status yet'}${s ? (ins?.manual ? ' (set by you)' : ' (from AI)') : ''}. Click to change.`;
    return `<button class="ai-edge st-${s || 'none'}${run}" data-act="ai-status" type="button" title="${esc(tip)}" aria-label="Status: ${esc(label)}"></button>`;
  }
  if (!state.settings.tabLines && busy.has(t.id)) {
    return compact ? '<span class="ai-spin" title="Summarizing…" aria-label="Summarizing"></span>' : '<span class="ai-st st-none static"><span class="ai-spin" aria-hidden="true"></span>Summarizing…</span>';
  }
  if (!state.settings.tabLines && tabErrors.has(t.id) && !compact) return `<button class="ai-st st-none ai-bad" data-act="ai-status" type="button" title="${esc(tabErrors.get(t.id))}">Couldn’t summarize</button>`;
  const sum = !state.settings.tabLines && ins?.summary ? `${ins.summary}\n\n` : '';
  const from = ins?.manual ? ' (set by you)' : ins?.statusFrom === 'fields' ? ' (from page fields)' : ' (from AI)';
  const facts = ins?.facts && !ins?.manual ? `\n${ins.facts}` : '';
  const why = sum + (s ? `${label}${from}.${facts}\nClick to change.` : 'No status yet. Click to set one.');
  if (compact) return `<button class="ai-dot-btn st-${s || 'none'}" data-act="ai-status" type="button" title="${esc(why)}" aria-label="Status: ${esc(label)}"><i></i></button>`;
  if (!s) return `<button class="ai-st st-none" data-act="ai-status" type="button" title="${esc(why)}">Set status</button>`;
  return `<button class="ai-st st-${s}${ins?.manual ? ' manual' : ''}" data-act="ai-status" type="button" title="${esc(why)}"><i></i>${esc(label)}</button>`;
}

/** Most urgent status among a group's tabs. */
export function groupStatus(g) {
  return rollupStatus(g.tabs.map(t => effectiveStatus(AI.tabInsight(urlOf(t)))));
}
export function groupStatusBadge(g) {
  if (!aiEnabled()) return '';
  return `<span class="ai-st-wrap" data-ai-gst="${g.id}">${groupStatusInner(g)}</span>`;
}
function groupStatusInner(g) {
  const s = groupStatus(g);
  if (!s) return '';
  const n = g.tabs.filter(t => effectiveStatus(AI.tabInsight(urlOf(t))) === s).length;
  return `<span class="ai-st st-${s} static" title="Most urgent tab status in this group"><i></i>${esc(STATUSES[s].label)}${n > 1 ? ` · ${n}` : ''}</span>`;
}

/** Summarize several groups, one after another, after one access / consent check. */
export function summarizeAll(ids) {
  if (!aiEnabled() || !ids.length) return;
  const s = state.settings;
  const engine = chooseEngine({ kind: 'group', setting: s.engine, local: state.local, hasKey: state.hasKey });
  if (!state.access && !s.pageAccessDeclined) return explainAccess(() => summarizeAll(ids));
  if (engine === 'cloud' && !s.cloudConsentAt) return askCloudConsent('group', () => summarizeAll(ids));
  (async () => { for (const id of ids) await runGroup(id, false); })();
}
/** Summarize one group and its tabs (call from a click). */
export const summarizeGroup = g => start('group', g.id);
export const sparkIcon = () => IC.spark;
export const anyGroupRunning = () => [...groupRuns.values()].some(r => r.status === 'running');

export function groupSumButtons() {
  if (!aiEnabled()) return '';
  return `<button class="btn" data-act="ai-group" type="button" title="Summarize this group and each of its tabs">${IC.spark} Summarize</button>`;
}

/** Compact Summarize button for a group card on the dashboard. */
export function cardSumButton() {
  if (!aiEnabled()) return '';
  return `<button class="icon-btn ai-card-btn" data-act="ai-group" type="button" title="Summarize this group and each of its tabs" aria-label="Summarize this group">${IC.spark}</button>`;
}

/** The group's one-sentence summary. `detail` also shows the instructions chip when there's no summary. */
export function groupSumCard(g, { detail = false } = {}) {
  if (!aiEnabled()) return '';
  const run = groupRuns.get(g.id);
  const ins = AI.groupInsight(g.name);
  if (!run && !ins) {
    const own = state.settings.groups[groupKey(g.name)];
    return detail && own ? `<div class="ai-instr-chip">${IC.note}<span>This group has its own AI instructions.</span><button class="link" data-act="ai-instr" type="button">Edit</button></div>` : '';
  }
  return `<div data-sum="group:${g.id}"${detail ? '' : ' class="ai-gline-wrap"'}>${detail ? groupSumInner(g, true) : groupLineInner(g)}</div>`;
}

/** On a dashboard card: the group's summary as one muted line, with refresh and edit on hover. */
function groupLineInner(g) {
  const run = groupRuns.get(g.id);
  const ins = AI.groupInsight(g.name);
  if (run?.status === 'running') {
    const text = run.text || run.statusText || 'Working…';
    return `<div class="ai-gline is-running" role="status"><span class="ai-spin" aria-hidden="true"></span><p class="ai-gtext dim">${esc(text)}</p>
      <span class="ai-tools"><button class="icon-btn" data-act="ai-stop" type="button" title="Stop" aria-label="Stop summarizing">${IC.close}</button></span></div>`;
  }
  if (run?.status === 'error') {
    const fix = ['key', 'model', 'no-engine'].includes(run.code) ? 'ai-settings' : 'ai-refresh';
    return `<div class="ai-gline is-error"><p class="ai-gtext ai-bad" title="${esc(run.error)}">${esc(run.error)}</p>
      <span class="ai-tools always"><button class="link" data-act="${fix}" type="button">${fix === 'ai-settings' ? 'Settings' : 'Try again'}</button></span></div>`;
  }
  if (!ins?.summary) return '';
  const meta = `${ins.engine === 'cloud' ? 'Gemini · cloud' : 'On-device'} · ${ago(ins.at)}`;
  return `<div class="ai-gline"><p class="ai-gtext" data-act="ai-expand" title="${esc(ins.summary)}\n${esc(meta)}">${esc(ins.summary)}</p>
    <span class="ai-tools">
      <button class="icon-btn" data-act="ai-refresh" type="button" title="Summarize again" aria-label="Summarize again">${IC.refresh}</button>
      <button class="icon-btn" data-act="ai-instr" type="button" title="AI instructions for this group" aria-label="AI instructions for this group">${IC.note}</button>
    </span></div>`;
}

function groupSumInner(g, detail) {
  const run = groupRuns.get(g.id);
  const ins = AI.groupInsight(g.name);
  const running = run?.status === 'running';
  let body = '';
  if (running) {
    body = run.text ? `<p class="ai-gtext">${esc(run.text)}</p>` : '';
    body += `<div class="ai-status" role="status">${run.progress != null ? `<span class="ai-bar"><i style="width:${Math.round(run.progress * 100)}%"></i></span>` : '<span class="ai-spin" aria-hidden="true"></span>'}${esc(run.statusText || 'Working…')}</div>`;
  } else if (run?.status === 'error') {
    const fix = ['key', 'model', 'no-engine'].includes(run.code) ? '<button class="btn sm" data-act="ai-settings" type="button">Open Settings</button>' : '<button class="btn sm" data-act="ai-refresh" type="button">Try again</button>';
    body = `${ins?.summary ? `<p class="ai-gtext">${esc(ins.summary)}</p>` : ''}<div class="ai-error">${esc(run.error)} ${fix}</div>`;
  } else if (ins?.summary) {
    body = `<p class="ai-gtext">${esc(ins.summary)}</p>`;
  }
  const engine = ins && !running ? `<span class="ai-engine${ins.engine === 'cloud' ? ' cloud' : ''}">${ins.engine === 'cloud' ? 'Gemini · cloud' : 'On-device'}</span><span class="ai-when">${esc(ago(ins.at))}</span>` : '';
  const tools = running
    ? '<button class="btn ghost sm" data-act="ai-stop" type="button">Stop</button>'
    : `<button class="icon-btn" data-act="ai-refresh" type="button" title="Summarize again" aria-label="Summarize again">${IC.refresh}</button>
       <button class="icon-btn" data-act="ai-instr" type="button" title="AI instructions for this group" aria-label="AI instructions for this group">${IC.note}</button>
       <button class="icon-btn" data-act="ai-dismiss" type="button" title="Remove this summary" aria-label="Remove this summary">${IC.close}</button>`;
  const notes = [];
  if (detail && ins && !running) {
    if (ins.unreadable?.length) notes.push(`${ins.unreadable.length === 1 ? '1 tab' : `${ins.unreadable.length} tabs`} couldn’t be read and counted by title only.`);
    if (ins.skipped) notes.push(`Used the 20 most recent tabs; ${ins.skipped} more were left out.`);
  }
  return `<section class="ai-gsum${detail ? ' detail' : ''}" aria-label="Group summary" aria-busy="${running}">
    <div class="ai-ghead"><span class="ai-title">${IC.spark}${detail ? 'What this group is about' : 'Summary'}</span>${engine}<span class="ai-tools">${tools}</span></div>
    ${body}${notes.length ? `<div class="ai-note">${notes.join(' ')}</div>` : ''}</section>`;
}

export function aiCommands(cur) {
  if (!aiEnabled()) return [{ type: 'cmd', label: 'Settings', sub: 'AI summaries are off', ico: IC.gear, run: () => openAiSettings() }];
  const c = [];
  if (cur) {
    c.push({ type: 'cmd', label: `Summarize “${cur.name}”`, sub: 'One sentence for the group and each tab, with statuses', ico: IC.spark, run: () => start('group', cur.id) });
    c.push({ type: 'cmd', label: `AI instructions for “${cur.name}”`, sub: 'Tell the AI how to summarize this group', ico: IC.note, run: () => openGroupInstructions(cur) });
  }
  c.push({ type: 'cmd', label: 'Settings', sub: 'AI engine, Gemini API key, summary instructions', ico: IC.gear, run: () => openAiSettings() });
  return c;
}

/** Extra items for the group "more" menu. */
export function groupMenuItems(g) {
  if (!aiEnabled()) return [];
  const has = !!state.settings.groups[groupKey(g.name)];
  const items = [];
  items.push({ html: `<span>${has ? 'Edit' : 'Add'} AI instructions for this group…</span>`, run: () => openGroupInstructions(g) });
  return items;
}

/** Keep a group's instructions (and summary) when it is renamed. */
export async function onGroupRenamed(oldName, newName) {
  const from = groupKey(oldName), to = groupKey(newName);
  const groups = { ...state.settings.groups };
  if (!groups[from] || from === to || groups[to]) return;
  groups[to] = groups[from];
  delete groups[from];
  await AI.saveSettings({ groups });
}

/** Clicks on data-act="ai-*". Returns true when handled. */
export function handleAiAction(a, el, row, g) {
  const key = el.closest('[data-sum]')?.dataset.sum;
  const tid = row ? +row.dataset.id : null;
  switch (a) {
    case 'ai-tab': start('tab', tid); return true;
    case 'ai-group': if (g) start('group', g.id); return true;
    case 'ai-refresh': if (key) { const [kind, id] = key.split(':'); start(kind, +id, { force: true }); } return true;
    case 'ai-stop': if (key) groupRuns.get(+key.split(':')[1])?.ctrl?.abort(); return true;
    case 'ai-dismiss': if (g) { groupRuns.delete(g.id); AI.clearGroupInsight(g.name); } return true;
    case 'ai-instr': if (g) openGroupInstructions(g); return true;
    case 'ai-settings': openAiSettings(); return true;
    case 'ai-status': if (tid != null) statusMenu(el, tid); return true;
    case 'ai-expand': el.classList.toggle('is-open'); return true;
  }
  return false;
}

/* ---------- status menu ---------- */

function statusMenu(anchor, tabId) {
  const x = ctx.tabById(tabId);
  if (!x) return;
  const url = urlOf(x.t);
  const ins = AI.tabInsight(url);
  const cur = effectiveStatus(ins);
  ctx.openMenu(anchor, m => {
    ctx.menuLabel(m, ins?.status && !ins.manual ? `Status · AI says ${STATUSES[ins.status].label}` : 'Status');
    STATUS_ORDER.forEach(s => ctx.menuItem(m,
      `<span class="ai-st st-${s} static"><i></i>${STATUSES[s].label}</span><span class="ai-menu-hint">${cur === s ? IC.check : ''}</span>`,
      () => AI.setManualStatus(url, s)));
    if (ins?.manual) ctx.menuItem(m, '<span>Let the AI decide</span>', () => AI.setManualStatus(url, null));
    m.append(document.createElement('hr'));
    ctx.menuItem(m, `${IC.refresh}<span>Summarize again</span>`, () => start('tab', tabId, { force: true }));
    if (isReadableUrl(url)) {
      const n = rulesFor(state.settings.rules, url).length;
      ctx.menuItem(m, `${IC.note}<span>AI instructions for pages like this…${n ? ` (${n})` : ''}</span>`, () => openAiSettings({ newRule: suggestPattern(url), rulesFor: url }));
    }
  });
}

/* ---------- running ---------- */

/**
 * Start from a click, so Chrome sees a user gesture (needed for the permission prompt and the first
 * on-device model download).
 */
function start(kind, id, { force = false } = {}) {
  const s = state.settings;
  const engine = chooseEngine({ kind, setting: s.engine, local: state.local, hasKey: state.hasKey });
  if (!state.access && !s.pageAccessDeclined) return explainAccess(() => start(kind, id, { force }));
  if (engine === 'cloud' && !s.cloudConsentAt) return askCloudConsent(kind, () => start(kind, id, { force }));
  if (kind === 'tab') {
    tabErrors.delete(id);
    enqueue(id, true, true);
  } else runGroup(id, force);
}

function enqueue(tabId, force = false, front = false) {
  if (busy.has(tabId)) return new Promise(r => addWaiter(tabId, r));
  const p = new Promise(r => addWaiter(tabId, r));
  if (queued.has(tabId)) {
    const i = queue.findIndex(q => q.tabId === tabId);
    if (force && i >= 0) queue[i].force = true;
    return p;
  }
  queued.add(tabId);
  front ? queue.unshift({ tabId, force }) : queue.push({ tabId, force });
  paintTab(tabId);
  pump();
  return p;
}
function addWaiter(id, r) { (waiters.get(id) || waiters.set(id, []).get(id)).push(r); }
function settle(id) { (waiters.get(id) || []).forEach(r => r()); waiters.delete(id); }

function pump() {
  const cloud = chooseEngine({ kind: 'tab', setting: state.settings.engine, local: state.local, hasKey: state.hasKey }) === 'cloud';
  const max = cloud ? 3 : 1;
  while (workers < max && queue.length) {
    const job = queue.shift();
    queued.delete(job.tabId);
    workers++;
    runTab(job).finally(() => { workers--; pump(); });
  }
}

async function runTab({ tabId, force }) {
  const x = ctx.tabById(tabId);
  if (!x) { settle(tabId); return; }
  busy.add(tabId);
  tabErrors.delete(tabId);
  paintTab(tabId);
  try {
    await AI.summarizeTab(x.t, { force, access: state.access, groupName: x.owner?.name ?? null });
  } catch (e) {
    if (e?.name !== 'AbortError') { console.warn('Summary failed', e); tabErrors.set(tabId, e?.message || String(e)); }
  }
  busy.delete(tabId);
  if (state.local !== 'available') refreshState();
  paintTab(tabId);
  settle(tabId);
}

async function runGroup(id, force) {
  const g = ctx.groupById(id);
  if (!g) return;
  groupRuns.get(id)?.ctrl?.abort();
  const run = { status: 'running', text: '', statusText: 'Summarizing tabs…', progress: null, ctrl: new AbortController() };
  groupRuns.set(id, run);
  ctx.renderMain();
  const paint = () => paintGroup(id);
  try {
    // Every tab first, so the group sentence (and the status roll-up) uses fresh tab summaries.
    let done = 0;
    const tabs = g.tabs.filter(t => isReadableUrl(urlOf(t)) || !state.access);
    run.statusText = `Summarizing tabs: 0 of ${tabs.length}`;
    paint();
    await Promise.all(tabs.map(t => enqueue(t.id, force).then(() => { done++; run.statusText = `Summarizing tabs: ${done} of ${tabs.length}`; paint(); })));
    if (run.ctrl.signal.aborted) throw new DOMException('Stopped', 'AbortError');
    const live = ctx.groupById(id) || g;
    await AI.summarizeGroup({ name: live.name, tabs: live.tabs }, {
      force, signal: run.ctrl.signal, access: state.access,
      onChunk: text => { run.text = text; run.statusText = 'Writing…'; paint(); },
      onProgress: f => { run.progress = f; run.statusText = `Downloading the on-device model… ${Math.round(f * 100)}%`; paint(); },
      onStatus: text => { run.statusText = text; paint(); },
    });
    groupRuns.delete(id);
  } catch (e) {
    if (e?.name === 'AbortError') groupRuns.delete(id);
    else { console.error(e); Object.assign(run, { status: 'error', error: e?.message || String(e), code: e?.code }); }
  }
  if (state.local !== 'available') refreshState();
  paint();
}

/* ---------- automatic summaries ---------- */

/**
 * Called after every refresh with all open tabs. In auto mode, queues tabs that have no
 * recent summary. Never downloads a model or sends anything to the cloud without consent.
 */
export function noticeTabs(items) {
  const s = state.settings;
  if (!s.enabled || s.auto === 'off' || !state.access) return;
  const engine = chooseEngine({ kind: 'tab', setting: s.engine, local: state.local, hasKey: state.hasKey });
  if (!engine) return;
  if (engine === 'local' && state.local !== 'available') return;
  if (engine === 'cloud' && (s.auto !== 'all' || !s.cloudConsentAt)) return;
  for (const { t } of items) {
    const url = urlOf(t);
    if (t.status !== 'complete' || t.discarded || t.frozen || t.incognito || !isReadableUrl(url)) continue;
    if (queued.has(t.id) || busy.has(t.id) || tabErrors.has(t.id)) continue;
    const ins = AI.tabInsight(url);
    if (seen.get(t.id) === url && !needsInsight(ins)) continue;
    seen.set(t.id, url);
    enqueue(t.id, false);
  }
}

/* ---------- painting ---------- */

let paintTimer = null;
function schedulePaint() {
  if (paintTimer) return;
  paintTimer = setTimeout(() => {
    paintTimer = null;
    new Set([...document.querySelectorAll('[data-ai-tab], [data-ai-st]')].map(el => +(el.dataset.aiTab || el.dataset.aiSt))).forEach(paintTab);
    document.querySelectorAll('[data-ai-gst]').forEach(el => { const g = ctx.groupById(+el.dataset.aiGst); if (g) el.innerHTML = groupStatusInner(g); });
    document.querySelectorAll('[data-sum^="group:"]').forEach(el => paintGroup(+el.dataset.sum.split(':')[1]));
    ctx.onPainted?.();
  }, 60);
}

function paintTab(id) {
  const x = ctx.tabById(id);
  if (!x) return;
  document.querySelectorAll(`[data-ai-tab="${id}"]`).forEach(el => { el.innerHTML = tabLineInner(x.t); });
  document.querySelectorAll(`[data-ai-st="${id}"]`).forEach(el => { el.innerHTML = tabStatusInner(x.t, el.dataset.mode); });
  if (x.owner) document.querySelectorAll(`[data-ai-gst="${x.owner.id}"]`).forEach(el => { el.innerHTML = groupStatusInner(x.owner); });
}

function paintGroup(id) {
  const g = ctx.groupById(id);
  const els = document.querySelectorAll(`[data-sum="group:${id}"]`);
  if (!g) return;
  if (!els.length && (groupRuns.has(id) || AI.groupInsight(g.name))) { ctx.renderMain(); return; }
  els.forEach(el => {
    if (!groupRuns.has(id) && !AI.groupInsight(g.name)) { el.remove(); return; }
    el.innerHTML = el.closest('.card') ? groupLineInner(g) : groupSumInner(g, true);
  });
}

function ago(at) {
  if (!at) return '';
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/* ---------- permission + consent dialogs ---------- */

function explainAccess(then) {
  ctx.openModal(`<div class="dialog-head"><h2>Let Tab Desk read the pages you summarize?</h2>
      <p>To summarize a page, Tab Desk reads its text. It never reloads sleeping tabs.</p></div>
    <div class="dialog-body"><p class="ai-muted">Chrome will ask to “read and change your data on all websites”. Tab Desk only reads the text of tabs it summarizes. Without it, summaries use page titles and addresses only, and tabs aren’t summarized automatically.</p></div>
    <div class="dialog-foot"><button class="btn" data-m="titles" type="button">Use titles only</button><button class="btn primary" data-m="ok" type="button">Allow page access</button></div>`,
  box => {
    box.querySelector('[data-m=titles]').onclick = async () => {
      ctx.closeModal();
      state.settings = await AI.saveSettings({ pageAccessDeclined: true });
      then();
    };
    box.querySelector('[data-m=ok]').onclick = () => {
      // Must run inside the click: Chrome only shows the prompt during a user gesture.
      const req = AI.requestPageAccess();
      ctx.closeModal();
      req.then(async ok => {
        state.access = ok;
        if (!ok) state.settings = await AI.saveSettings({ pageAccessDeclined: true });
        then();
      });
    };
  });
}

function askCloudConsent(kind, then) {
  const localOk = state.local !== 'unavailable';
  ctx.openModal(`<div class="dialog-head"><h2>Send page content to Google Gemini?</h2>
      <p>${kind === 'group' ? 'For a group summary, the text of the readable tabs in the group' : 'The text of this page'} will be sent to Google’s Gemini API using your API key.</p></div>
    <div class="dialog-body ai-muted"><p>Google handles it under the Gemini API terms for your key. On the free tier, Google may use what you send to improve its products. Tab Desk has no server of its own and never sees your data.</p>
      <p>Summaries made by Gemini are marked <span class="ai-engine cloud">Gemini · cloud</span>. You’ll only be asked once; you can turn the cloud off any time in Settings.</p></div>
    <div class="dialog-foot">${localOk ? '<button class="btn" data-m="local" type="button">Use on-device instead</button>' : ''}<button class="btn" data-m="cancel" type="button">Cancel</button><button class="btn primary" data-m="ok" type="button">Send to Gemini</button></div>`,
  box => {
    box.querySelector('[data-m=cancel]').onclick = ctx.closeModal;
    box.querySelector('[data-m=local]')?.addEventListener('click', async () => {
      ctx.closeModal();
      state.settings = await AI.saveSettings({ engine: 'local' });
      ctx.toast('Summaries will stay on this device. You can change this in Settings.');
      then();
    });
    box.querySelector('[data-m=ok]').onclick = async () => {
      ctx.closeModal();
      state.settings = await AI.saveSettings({ cloudConsentAt: Date.now() });
      then();
    };
  });
}

/* ---------- group instructions ---------- */

export function openGroupInstructions(g) {
  const s = state.settings;
  const cur = s.groups[groupKey(g.name)] || '';
  ctx.openModal(`<div class="dialog-head"><h2>AI instructions for “${esc(g.name)}”</h2>
      <p>Used for this group’s sentence and its tabs, in place of the general instructions. A matching page rule still wins for its pages. Saved by group name, so it also applies after a restart or when you restore it from Workspaces.</p></div>
    <div class="dialog-body">
      <label class="ai-field"><span>Instructions for this group</span>
        <textarea id="aiGroupInstr" rows="9" maxlength="${MAX_INSTRUCTIONS}" placeholder="${esc(INSTRUCTION_TEMPLATE)}">${esc(cur)}</textarea></label>
      <div class="ai-muted ai-small">${cur ? '' : '<button class="link" data-m="tpl" type="button">Insert template</button> · '}<button class="link" data-m="general" type="button">How instructions are picked</button></div>
    </div>
    <div class="dialog-foot">${cur ? '<button class="btn danger" data-m="clear" type="button" style="margin-right:auto">Remove</button>' : ''}<button class="btn" data-m="cancel" type="button">Cancel</button><button class="btn primary" data-m="ok" type="button">Save</button></div>`,
  box => {
    const ta = box.querySelector('#aiGroupInstr');
    ta.focus();
    const save = async text => {
      const groups = { ...state.settings.groups };
      const k = groupKey(g.name);
      if (text.trim()) groups[k] = text.trim(); else delete groups[k];
      state.settings = await AI.saveSettings({ groups });
      ctx.closeModal();
      ctx.renderMain();
      ctx.toast(text.trim() ? `Saved AI instructions for “${esc(g.name)}”` : `Removed AI instructions for “${esc(g.name)}”`);
    };
    box.querySelector('[data-m=cancel]').onclick = ctx.closeModal;
    box.querySelector('[data-m=ok]').onclick = () => save(ta.value);
    box.querySelector('[data-m=clear]')?.addEventListener('click', () => save(''));
    box.querySelector('[data-m=general]').onclick = () => openAiSettings({ focus: 'general' });
    box.querySelector('[data-m=tpl]')?.addEventListener('click', e => { ta.value = INSTRUCTION_TEMPLATE; e.target.remove(); ta.focus(); });
  });
}

/* ---------- settings ---------- */

const LOCAL_LABEL = {
  available: 'Ready on this device.',
  downloadable: 'Supported. Chrome needs to download the model once (a few GB) before first use.',
  downloading: 'Chrome is downloading the model…',
  unavailable: 'Not available here. It needs desktop Chrome 138 or later with enough memory and free disk space.',
};

const FIELDS_HINT = `# One per line: name: CSS selector (add @attribute to read an attribute)
# name[]: … reads every match as a list. name: label: Status reads the value next to a label.
viewer: meta[name="user-login"] @content
state: .State
reviewers[]: .reviewer .name`;
const STATUS_HINT = `# One per line, first match wins. Statuses: Needs you, In progress, Waiting, Done, Reference, or AI.
done when state matches /merged|closed/
needs you when reviewers has {viewer}
waiting when state is open
ai otherwise`;
const presetOptions = () => PRESETS.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
const rowsFor = t => (t ? Math.min(12, Math.max(3, t.split('\n').length + 1)) : 3);

function ruleRow(r = { pattern: '', instructions: '' }) {
  const hasFields = !!(r.fields || r.statusRules);
  return `<div class="ai-rule">
    <div class="ai-rule-top"><input class="ai-rule-pat" type="text" spellcheck="false" value="${esc(r.pattern)}" placeholder="github.com/*/*/pull/*" aria-label="Page pattern">
      <button class="icon-btn" data-m="rdel" type="button" title="Remove rule" aria-label="Remove rule">${IC.close}</button></div>
    <div class="ai-rule-count ai-small"></div>
    <textarea class="ai-rule-ins" rows="${r.instructions ? Math.min(10, Math.max(3, r.instructions.split('\n').length + 1)) : 3}" maxlength="${MAX_INSTRUCTIONS}" placeholder="${esc(INSTRUCTION_TEMPLATE)}" aria-label="Instructions">${esc(r.instructions)}</textarea>
    <div class="ai-rule-actions"><button class="btn sm" data-m="rdraft" type="button" title="Look at a matching open tab and draft instructions from the template">${IC.spark}<span>Draft with AI</span></button>
      <button class="link ai-small" data-m="rtpl" type="button">Insert template</button>
      <span class="ai-rule-msg ai-small" aria-live="polite"></span>
      <button class="link ai-small" data-m="rundo" type="button" hidden>Undo</button></div>
    <details class="ai-fields"${hasFields ? ' open' : ''}>
      <summary class="ai-small">Page fields and status rules${hasFields ? '' : ' <span class="ai-muted">(optional)</span>'}</summary>
      <p class="ai-muted ai-small">Read only these values from the page, and decide the status from them without the AI. The AI then only writes the sentence. Leave empty to send the whole page to the AI.</p>
      <label class="ai-small ai-muted">Fields</label>
      <textarea class="ai-rule-fields mono" rows="${rowsFor(r.fields)}" maxlength="${MAX_INSTRUCTIONS}" spellcheck="false" placeholder="${esc(FIELDS_HINT)}" aria-label="Page fields">${esc(r.fields || '')}</textarea>
      <label class="ai-small ai-muted">Status rules</label>
      <textarea class="ai-rule-status mono" rows="${rowsFor(r.statusRules)}" maxlength="${MAX_INSTRUCTIONS}" spellcheck="false" placeholder="${esc(STATUS_HINT)}" aria-label="Status rules">${esc(r.statusRules || '')}</textarea>
      <div class="ai-rule-actions">
        <button class="btn sm" data-m="ftest" type="button" title="Read these fields from a matching open tab and show the status they give">Test on an open tab</button>
        <label class="ai-small ai-muted">Start from <select class="ai-preset" aria-label="Start from a preset"><option value="">a preset…</option>${presetOptions()}</select></label>
      </div>
      <div class="ai-fields-out ai-small" aria-live="polite"></div>
    </details>
  </div>`;
}

/** Page fields on a rule: validate as you type, start from a preset, and test on a matching open tab. */
function wireFields(el, pat) {
  const fTa = el.querySelector('.ai-rule-fields');
  const sTa = el.querySelector('.ai-rule-status');
  const out = el.querySelector('.ai-fields-out');
  const errorsHtml = () => {
    const fe = parseFields(fTa.value).errors.map(e => `Fields, line ${e.line}: ${esc(e.message)}`);
    const se = parseStatusRules(sTa.value).errors.map(e => `Status rules, line ${e.line}: ${esc(e.message)}`);
    return [...fe, ...se].slice(0, 4).map(x => `<div class="ai-bad">${x}</div>`).join('');
  };
  const check = () => { out.innerHTML = errorsHtml(); };
  fTa.addEventListener('input', check);
  sTa.addEventListener('input', check);
  el.querySelector('.ai-preset').onchange = e => {
    const p = PRESETS.find(x => x.id === e.target.value);
    e.target.value = '';
    if (!p) return;
    if ((fTa.value.trim() || sTa.value.trim()) && !out.dataset.confirm) {
      out.dataset.confirm = p.id;
      out.innerHTML = `<div>This replaces the fields and status rules here. <button class="link ai-small" type="button" data-pc="${esc(p.id)}">Replace</button></div>`;
      out.querySelector('[data-pc]').onclick = () => { delete out.dataset.confirm; apply(p); };
      return;
    }
    apply(p);
  };
  const apply = p => {
    if (!pat.value.trim()) { pat.value = p.pattern; pat.dispatchEvent(new Event('input')); }
    fTa.value = p.fields; fTa.rows = rowsFor(p.fields);
    sTa.value = p.statusRules; sTa.rows = rowsFor(p.statusRules);
    out.textContent = `Copied the ${p.name} preset. Edit it as you like.`;
  };
  el.querySelector('[data-m=ftest]').onclick = async e => {
    const btn = e.currentTarget;
    const errs = errorsHtml();
    if (errs) { out.innerHTML = errs; return; }
    const { fields } = parseFields(fTa.value);
    if (!fields.length) { out.textContent = 'Add at least one field first.'; fTa.focus(); return; }
    const m = compilePattern(pat.value.trim());
    if (!m) { out.textContent = 'Write a valid pattern first.'; pat.focus(); return; }
    if (!state.access) { out.textContent = 'Testing needs page access (Settings › General › Privacy).'; return; }
    const tab = ctx.allTabs().map(x => x.t).find(t => m.test(urlOf(t)) && isReadableUrl(urlOf(t)) && !t.discarded && !t.frozen);
    if (!tab) { out.textContent = 'No open, awake tab matches this pattern. Open one and try again.'; return; }
    btn.disabled = true;
    try {
      const values = await AI.readFields(tab, fields);
      const { rules } = parseStatusRules(sTa.value);
      const d = rules.length ? decideStatus(rules, values) : null;
      const show = v => (Array.isArray(v) ? (v.length ? v.join(' | ') : '') : v);
      const rows = fields.map(f => { const v = show(values[f.name]); return `<tr><th>${esc(f.name)}</th><td>${v ? esc(v) : '<span class="ai-bad">not found</span>'}</td></tr>`; }).join('');
      const verdict = !rules.length ? 'No status rules, so the AI decides the status (with these fields put first).'
        : !d ? 'No status rule matched, so the AI decides the status.'
        : d.status === 'unknown' ? `Rule ${d.index + 1} says to let the AI decide.`
        : `Status: <b>${esc(STATUSES[d.status].label)}</b> (rule ${d.index + 1}: <code>${esc(sTa.value.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'))[d.index] || '')}</code>)`;
      out.innerHTML = `<div>From “${esc((tab.title || urlOf(tab)).slice(0, 70))}”</div><table class="ai-fields-tbl">${rows}</table><div>${verdict}</div>${factsLine(fields, values) ? `<div class="ai-muted">Facts: ${esc(factsLine(fields, values))}</div>` : ''}`;
    } catch (err) {
      out.innerHTML = `<div class="ai-bad">Couldn’t read that tab: ${esc(err?.message || err)}</div>`;
    } finally { btn.disabled = false; }
  };
}

function ruleCount(pattern) {
  const p = pattern.trim();
  if (!p) return { text: '', bad: false };
  const m = compilePattern(p);
  if (!m) return { text: 'Not a valid pattern.', bad: true };
  const n = ctx.allTabs().filter(({ t }) => m.test(urlOf(t))).length;
  const kind = m.kind === 'site' ? 'Whole site' : m.kind === 'regex' ? 'Regular expression' : 'Page pattern';
  return { text: `${kind} · matches ${n === 1 ? '1 open tab' : `${n} open tabs`}`, bad: false };
}

const TAB_KEY = 'tabdesk.settingsTab';
const lastTab = () => { try { return localStorage.getItem(TAB_KEY) === 'instructions' ? 'instructions' : 'general'; } catch { return 'general'; } };

export async function openAiSettings(opts = {}) {
  const { focus, newRule, rulesFor: forUrl } = opts;
  await refreshState();
  const s = state.settings;
  const key = await AI.getApiKey();
  const saved = await AI.insightCount();
  const groupRows = Object.entries(s.groups);
  const rules = [...s.rules];
  if (newRule != null && !rules.some(r => r.pattern === newRule)) rules.push({ pattern: newRule, instructions: '' });
  const radio = (name, v, cur, label, sub) => `<label class="ai-radio"><input type="radio" name="${name}" value="${v}" ${cur === v ? 'checked' : ''}><span><b>${label}</b><span>${sub}</span></span></label>`;
  const tab = focus === 'general' || newRule != null || forUrl ? 'instructions' : (opts.tab || lastTab());
  ctx.openModal(`<div class="dialog-head"><h2>Settings</h2></div>
    <div class="settings-layout">
      <nav class="settings-nav" role="tablist" aria-label="Settings sections" aria-orientation="vertical">
        <button class="settings-tab" role="tab" id="setTab-general" data-tab="general" aria-controls="setPanel-general" aria-selected="${tab === 'general'}" tabindex="${tab === 'general' ? 0 : -1}" type="button">${IC.gear}<span>General</span></button>
        <button class="settings-tab" role="tab" id="setTab-instructions" data-tab="instructions" aria-controls="setPanel-instructions" aria-selected="${tab === 'instructions'}" tabindex="${tab === 'instructions' ? 0 : -1}" type="button">${IC.note}<span>Summary instructions</span></button>
      </nav>
      <div class="dialog-body ai-settings settings-panels">
      <section class="settings-panel" role="tabpanel" id="setPanel-general" aria-labelledby="setTab-general" ${tab === 'general' ? '' : 'hidden'}>
      <h3 class="first">AI summaries</h3>
      <p class="ai-muted ai-small">One sentence and a status for every tab. Runs on your device by default; add your own Gemini API key for the cloud.</p>
      <label class="ai-check"><input type="checkbox" id="aiEnabled" ${s.enabled ? 'checked' : ''}><span>Show AI summaries and statuses</span></label>
      <label class="ai-check"><input type="checkbox" id="aiTabLines" ${s.tabLines ? 'checked' : ''}><span>Show the summary under each tab</span></label>
      <p class="ai-muted ai-small ai-indent">When off, hover a tab’s status to read its summary.</p>

      <h3>Engine</h3>
      ${radio('aiEngine', 'auto', s.engine, 'Auto', 'On-device for tabs when ready. Gemini for groups when you’ve added a key.')}
      ${radio('aiEngine', 'local', s.engine, 'On-device only', 'Nothing leaves your computer.')}
      ${radio('aiEngine', 'cloud', s.engine, 'Gemini API only', 'Always use your Gemini key.')}
      <div class="ai-status-line"><span class="ai-dot ${state.local}"></span><span>On-device model (Gemini Nano): ${esc(LOCAL_LABEL[state.local] || state.local)}${state.localApi === 'summarizer' ? ' Statuses need Chrome’s Prompt API, which isn’t available here, so on-device summaries come without a status.' : ''}</span>
        ${state.local === 'downloadable' ? '<button class="btn sm" id="aiDownload" type="button">Download</button>' : ''}</div>
      <div class="ai-bar wide" id="aiDlBar" hidden><i></i></div>

      <h3>Summarize tabs automatically</h3>
      ${radio('aiAuto', 'local', s.auto, 'When it runs on this device', 'New and changed tabs get a summary in the background, using the on-device model only.')}
      ${radio('aiAuto', 'all', s.auto, 'Always', 'Also uses your Gemini key when that’s the engine for tabs. Each new page is sent to Gemini.')}
      ${radio('aiAuto', 'off', s.auto, 'Off', 'Only when you press a summarize button.')}
      ${!state.access ? '<div class="ai-muted ai-small">Automatic summaries need page access (see Privacy below).</div>' : ''}

      <h3>Gemini API key <span class="ai-muted">(optional)</span></h3>
      <div class="ai-key-row">
        <input id="aiKey" type="password" autocomplete="off" spellcheck="false" placeholder="Paste a key from Google AI Studio" value="${esc(key)}" aria-label="Gemini API key">
        <button class="btn sm" id="aiKeyShow" type="button">Show</button>
        <button class="btn sm" id="aiKeyTest" type="button">Test</button>
      </div>
      <div class="ai-muted ai-small" id="aiKeyMsg">Get a key at <a href="${AI_STUDIO}" target="_blank" rel="noopener">Google AI Studio</a>. It’s stored unencrypted in this Chrome profile only (not synced). Use a key limited to the Gemini API.</div>
      <label class="ai-field"><span>Gemini model</span><input id="aiModel" type="text" spellcheck="false" value="${esc(s.model)}" placeholder="${DEFAULT_MODEL}"></label>

      <h3>Privacy</h3>
      <div class="ai-status-line"><span class="ai-dot ${state.access ? 'available' : 'unavailable'}"></span><span id="aiAccessText">Page access: ${state.access ? 'Tab Desk can read the text of pages it summarizes.' : 'Off. Summaries use titles and addresses only.'}</span>
        <button class="btn sm" id="aiAccess" type="button">${state.access ? 'Revoke' : 'Allow'}</button></div>
      <div class="ai-status-line"><span id="aiSavedText">${saved} saved tab ${saved === 1 ? 'summary' : 'summaries'} on this device.</span><button class="btn sm" id="aiClear" type="button" ${saved ? '' : 'disabled'}>Clear</button></div>
      ${s.cloudConsentAt ? '<div class="ai-muted ai-small">You agreed to send page content to Gemini. Removing your key resets this.</div>' : ''}
      </section>

      <section class="settings-panel" role="tabpanel" id="setPanel-instructions" aria-labelledby="setTab-instructions" ${tab === 'instructions' ? '' : 'hidden'}>
      <h3 class="first">How the prompt is built</h3>
      <p class="ai-muted ai-small">Every tab summary starts with a fixed base prompt that asks for JSON in the order <code>facts</code>, <code>summary</code>, <code>status</code>. After it comes one set of instructions, the most specific one: a matching page rule, else the group’s, else the general instructions below, else the default ones. They replace each other; they don’t add up.</p>
      <details class="ai-prompt-peek"><summary>Show the base prompt and the default instructions</summary>
        <div class="ai-small ai-muted">Base prompt (always used)</div><pre>${esc(baseTabPrompt('en'))}</pre>
        <div class="ai-small ai-muted">Default instructions (used when nothing else applies)</div><pre>${esc(DEFAULT_TAB_INSTRUCTIONS)}</pre>
      </details>

      <h3>General instructions</h3>
      <label class="ai-field"><span>Used for tabs with no page rule or group instructions. Leave empty to use the default ones.</span>
        <textarea id="aiGeneral" rows="${s.general ? Math.min(10, s.general.split('\n').length + 1) : 3}" maxlength="${MAX_INSTRUCTIONS}" placeholder="${esc(INSTRUCTION_TEMPLATE)}">${esc(s.general)}</textarea></label>
      ${s.general ? '' : '<div class="ai-rule-actions"><button class="link ai-small" id="aiGeneralDefault" type="button">Start from the default instructions</button></div>'}

      <h3>Sites and pages</h3>
      <div class="ai-field" id="aiRulesField">
        <div class="ai-muted ai-small">A site (<code>github.com</code>) covers all its pages. A page pattern matches the whole address without https:// — <code>*</code> is one part of the path, <code>**</code> is anything — so <code>github.com/*/*</code> is a repo’s home, <code>github.com/*/*/pulls</code> its pull request list and <code>github.com/*/*/pull/*</code> one pull request. Or write a <code>/regular expression/</code>. When several rules match a page, only the most specific one is used (a page pattern beats a whole site), and it replaces the group and general instructions there.</div>
        <label class="ai-check"><input type="checkbox" id="aiPresets" ${s.presets ? 'checked' : ''}><span>Use built-in page fields for ${PRESETS.map(p => esc(p.name)).join(' and ')} pages</span></label>
        <p class="ai-muted ai-small ai-indent">Their status comes from what the page shows (state, reviewers, checks, who you are) instead of the AI. A rule of yours with page fields replaces them. Open “Page fields and status rules” on a rule to read specific values from any site.</p>
        <div id="aiRules">${rules.map(ruleRow).join('')}</div>
        <button class="btn sm" id="aiAddRule" type="button" ${rules.length >= MAX_RULES ? 'disabled' : ''}>+ Add rule</button>
      </div>

      <h3>Groups</h3>
      <div class="ai-field">
        ${groupRows.length ? `<ul class="ai-glist">${groupRows.map(([k, v]) => `<li data-gk="${esc(k)}"><b>${esc(k)}</b><span>${esc(v.length > 90 ? v.slice(0, 90) + '…' : v)}</span><button class="icon-btn" data-m="gdel" type="button" title="Remove" aria-label="Remove instructions for ${esc(k)}">${IC.close}</button></li>`).join('')}</ul>`
          : '<div class="ai-muted ai-small">None yet. Open a group and choose “AI instructions” from its ⋯ menu.</div>'}
      </div>
      </section>
      </div>
    </div>
    <div class="dialog-foot"><button class="btn" data-m="cancel" type="button">Cancel</button><button class="btn primary" data-m="ok" type="button">Save</button></div>`,
  box => {
    const $b = sel => box.querySelector(sel);
    box.classList.add('settings-dialog');
    // Sidebar tabs: click, or arrow keys while a tab is focused.
    const tabs = [...box.querySelectorAll('.settings-tab')];
    const show = (name, focusTab = false) => {
      tabs.forEach(t => {
        const on = t.dataset.tab === name;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        box.querySelector('#' + t.getAttribute('aria-controls')).hidden = !on;
        if (on && focusTab) t.focus();
      });
      box.querySelector('.settings-panels').scrollTop = 0;
      try { localStorage.setItem(TAB_KEY, name); } catch {}
    };
    tabs.forEach(t => {
      t.onclick = () => show(t.dataset.tab);
      t.onkeydown = e => {
        const i = tabs.indexOf(t);
        const j = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
        if (j == null) return;
        e.preventDefault();
        show(tabs[(j + tabs.length) % tabs.length].dataset.tab, true);
      };
    });
    const removedGroups = new Set();
    const wireRule = el => {
      const pat = el.querySelector('.ai-rule-pat');
      const count = () => { const c = ruleCount(pat.value); const out = el.querySelector('.ai-rule-count'); out.textContent = c.text; out.classList.toggle('ai-bad', c.bad); };
      pat.addEventListener('input', count);
      count();
      el.querySelector('[data-m=rdel]').onclick = () => { el.remove(); $b('#aiAddRule').disabled = false; };
      wireFields(el, pat);
      const ta = el.querySelector('.ai-rule-ins');
      const msg = el.querySelector('.ai-rule-msg');
      const undo = el.querySelector('[data-m=rundo]');
      let before = null;
      const fill = (text, note) => {
        before = ta.value;
        ta.value = text;
        ta.rows = Math.min(10, text.split('\n').length + 1);
        msg.textContent = note || '';
        undo.hidden = !before.trim();
        ta.focus();
      };
      undo.onclick = () => { if (before != null) ta.value = before; before = null; undo.hidden = true; msg.textContent = ''; };
      el.querySelector('[data-m=rtpl]').onclick = () => fill(INSTRUCTION_TEMPLATE, 'Replace each … with what you want.');
      el.querySelector('[data-m=rdraft]').onclick = async e => {
        const btn = e.currentTarget;
        const m = compilePattern(pat.value.trim());
        if (!m) { msg.textContent = 'Write a valid pattern first.'; pat.focus(); return; }
        const matching = ctx.allTabs().map(x => x.t).filter(t => m.test(urlOf(t)));
        const tab = matching.find(t => isReadableUrl(urlOf(t)) && !t.discarded) || matching[0] || null;
        btn.disabled = true;
        const label = btn.querySelector('span');
        label.textContent = 'Drafting…';
        msg.textContent = tab ? `Looking at “${(tab.title || urlOf(tab)).slice(0, 60)}”…` : 'No open tab matches, so drafting from the pattern only…';
        try {
          const text = await AI.draftInstructions({ pattern: pat.value.trim(), tab, access: state.access });
          fill(text, 'Drafted by AI. Edit it as you like.');
        } catch (err) {
          if (!ta.value.trim()) fill(INSTRUCTION_TEMPLATE, `${err?.message || 'The AI couldn’t draft this.'} Here’s the template to fill in.`);
          else msg.textContent = err?.message || 'The AI couldn’t draft this.';
        } finally {
          btn.disabled = false;
          label.textContent = 'Draft with AI';
        }
      };
    };
    box.querySelectorAll('.ai-rule').forEach(wireRule);
    $b('#aiGeneralDefault')?.addEventListener('click', e => {
      const g = $b('#aiGeneral');
      if (!g.value.trim()) g.value = DEFAULT_TAB_INSTRUCTIONS;
      g.rows = Math.min(10, g.value.split('\n').length + 1);
      g.focus();
      e.target.parentElement.remove();
    });
    $b('#aiAddRule').onclick = () => {
      $b('#aiRules').insertAdjacentHTML('beforeend', ruleRow());
      const el = box.querySelector('.ai-rule:last-child');
      wireRule(el);
      el.querySelector('.ai-rule-pat').focus();
      if (box.querySelectorAll('.ai-rule').length >= MAX_RULES) $b('#aiAddRule').disabled = true;
    };
    if (focus === 'general') { const g = $b('#aiGeneral'); g.focus(); g.scrollIntoView({ block: 'center' }); }
    if (newRule != null) {
      const el = [...box.querySelectorAll('.ai-rule')].find(r => r.querySelector('.ai-rule-pat').value === newRule);
      if (el) { el.scrollIntoView({ block: 'center' }); el.querySelector('.ai-rule-ins').focus(); el.classList.add('flash'); }
    } else if (forUrl) $b('#aiRulesField').scrollIntoView({ block: 'center' });
    $b('[data-m=cancel]').onclick = ctx.closeModal;
    $b('#aiKeyShow').onclick = () => { const i = $b('#aiKey'); const show = i.type === 'password'; i.type = show ? 'text' : 'password'; $b('#aiKeyShow').textContent = show ? 'Hide' : 'Show'; };
    $b('#aiKeyTest').onclick = async () => {
      const k = $b('#aiKey').value.trim();
      const msg = $b('#aiKeyMsg');
      if (!k) { msg.textContent = 'Paste a key first.'; return; }
      const granted = await chrome.permissions.request({ origins: GEMINI_ORIGINS }).catch(() => false);
      msg.textContent = 'Checking…';
      try { await AI.testApiKey(k); msg.innerHTML = '<span class="ai-ok">The key works.</span>'; }
      catch (e) { msg.innerHTML = `<span class="ai-bad">${esc(e.message)}</span>${granted ? '' : ' (Chrome didn’t allow contacting Gemini.)'}`; }
    };
    $b('#aiDownload')?.addEventListener('click', e => {
      const bar = $b('#aiDlBar');
      bar.hidden = false;
      e.target.disabled = true;
      e.target.textContent = 'Downloading…';
      AI.downloadLocalModel(f => { bar.firstElementChild.style.width = `${Math.round(f * 100)}%`; })
        .then(async () => { e.target.textContent = 'Ready'; await refreshState(); ctx.render(); })
        .catch(err => { e.target.disabled = false; e.target.textContent = 'Download'; ctx.toast(esc(err.message)); });
    });
    $b('#aiAccess').onclick = e => {
      const p = state.access ? AI.revokePageAccess() : AI.requestPageAccess();
      p.then(async () => {
        await refreshAccess();
        state.settings = await AI.saveSettings({ pageAccessDeclined: !state.access });
        e.target.textContent = state.access ? 'Revoke' : 'Allow';
        $b('#aiAccessText').textContent = `Page access: ${state.access ? 'Tab Desk can read the text of pages it summarizes.' : 'Off. Summaries use titles and addresses only.'}`;
        e.target.parentElement.querySelector('.ai-dot').className = `ai-dot ${state.access ? 'available' : 'unavailable'}`;
      });
    };
    $b('#aiClear').onclick = async e => { await AI.clearInsights(); e.target.disabled = true; $b('#aiSavedText').textContent = 'No saved summaries on this device.'; };
    box.querySelectorAll('[data-m=gdel]').forEach(b => b.onclick = () => { const li = b.closest('li'); removedGroups.add(li.dataset.gk); li.remove(); });
    $b('[data-m=ok]').onclick = async () => {
      const newKey = $b('#aiKey').value.trim();
      // Ask for the Gemini host inside the click, before any await.
      const perm = newKey && newKey !== key ? chrome.permissions.request({ origins: GEMINI_ORIGINS }).catch(() => false) : Promise.resolve(true);
      const rulesOut = [...box.querySelectorAll('.ai-rule')].map(el => ({
        el,
        pattern: el.querySelector('.ai-rule-pat').value.trim(),
        instructions: el.querySelector('.ai-rule-ins').value.trim(),
        fields: el.querySelector('.ai-rule-fields').value.trim(),
        statusRules: el.querySelector('.ai-rule-status').value.trim(),
      }));
      const problem = r => {
        if (!(r.pattern || r.instructions || r.fields || r.statusRules)) return '';
        if (!r.pattern) return 'A rule needs a pattern.';
        if (!compilePattern(r.pattern)) return 'One rule’s pattern isn’t valid.';
        if (!r.instructions && !r.fields) return 'A rule needs instructions or page fields.';
        if (r.statusRules && !r.fields) return 'Status rules need page fields to read.';
        const fe = parseFields(r.fields).errors[0];
        if (fe) return `Page fields, line ${fe.line}: ${fe.message}.`;
        const se = parseStatusRules(r.statusRules).errors[0];
        if (se) return `Status rules, line ${se.line}: ${se.message}.`;
        return '';
      };
      const bad = rulesOut.find(r => problem(r));
      if (bad) {
        bad.el.scrollIntoView({ block: 'center' });
        bad.el.classList.add('flash');
        ctx.toast(esc(problem(bad)));
        return;
      }
      const groups = { ...state.settings.groups };
      removedGroups.forEach(k => delete groups[k]);
      await perm;
      await AI.setApiKey(newKey);
      if (!newKey && key) chrome.permissions.remove({ origins: GEMINI_ORIGINS }).catch(() => {});
      await AI.saveSettings({
        enabled: $b('#aiEnabled').checked,
        tabLines: $b('#aiTabLines').checked,
        engine: box.querySelector('input[name=aiEngine]:checked')?.value || 'auto',
        auto: box.querySelector('input[name=aiAuto]:checked')?.value || 'local',
        model: $b('#aiModel').value.trim() || DEFAULT_MODEL,
        general: $b('#aiGeneral').value.trim(),
        groups,
        rules: rulesOut.filter(r => r.pattern && (r.instructions || r.fields)).map(({ el, ...r }) => r),
        presets: $b('#aiPresets').checked,
        ...(newKey !== key ? { cloudConsentAt: 0 } : {}),
      });
      await refreshState();
      ctx.closeModal();
      ctx.render();
      ctx.toast('Settings saved');
    };
  });
}
