// AI summaries on the Tab Desk page: Summarize buttons, result cards, AI settings and
// custom instructions (general, and per group). The engines live in lib/ai.js.

import * as AI from './lib/ai.js';
import { renderSummary, groupKey, chooseEngine, DEFAULT_MODEL, MAX_INSTRUCTIONS } from './lib/ai-core.js';

const GEMINI_ORIGINS = ['https://generativelanguage.googleapis.com/*'];
const AI_STUDIO = 'https://aistudio.google.com/apikey';

const IC = {
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3Z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
  note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="M13.5 6.5l4 4"/></svg>',
};

let ctx = null;
let state = { settings: AI.DEFAULT_SETTINGS, hasKey: false, local: 'unavailable', access: false };
const sums = new Map(); // 'tab:<id>' | 'group:<id>' -> card state

/* ---------- setup ---------- */

export async function initAi(c) {
  ctx = c;
  await refreshState();
  AI.onSettingsChanged(async () => { await refreshState(); ctx.render(); });
  chrome.permissions.onAdded.addListener(refreshAccess);
  chrome.permissions.onRemoved.addListener(refreshAccess);
  document.getElementById('aiSettingsBtn')?.addEventListener('click', () => openAiSettings());
  paintSideButton();
}

async function refreshState() {
  const [{ settings, hasKey, local }, access] = await Promise.all([AI.engineState(), AI.hasPageAccess()]);
  state = { settings, hasKey, local, access };
  paintSideButton();
}
async function refreshAccess() { state.access = await AI.hasPageAccess(); }

function paintSideButton() {
  const b = document.getElementById('aiSettingsBtn');
  if (!b) return;
  const s = state.settings;
  const engine = !s.enabled ? 'Off' : s.engine === 'cloud' ? 'Gemini API' : s.engine === 'local' ? 'On-device' : state.hasKey ? 'Auto' : 'On-device';
  b.innerHTML = `${IC.spark}<span style="flex:1">AI summaries</span><span class="ai-side-state">${engine}</span>`;
}

const esc = s => ctx.esc(s);
export const aiEnabled = () => state.settings.enabled;

/* ---------- markup hooks used by dashboard.js ---------- */

export function tabSumButton(t) {
  if (!aiEnabled()) return '';
  return `<button class="icon-btn" data-act="ai-tab" type="button" title="Summarize tab" aria-label="Summarize ${esc(t.title || 'tab')}">${IC.spark}</button>`;
}

export function tabSumRow(t) {
  const k = `tab:${t.id}`;
  if (!aiEnabled() || !sums.has(k)) return '';
  return `<li class="tab-sum" data-for="${t.id}">${card(k)}</li>`;
}

export function groupSumButtons() {
  if (!aiEnabled()) return '';
  return `<button class="btn" data-act="ai-group" type="button" title="Summarize what this group is about">${IC.spark} Summarize</button>`;
}

export function groupSumCard(g) {
  if (!aiEnabled()) return '';
  const k = `group:${g.id}`;
  const own = state.settings.groups[groupKey(g.name)];
  if (!sums.has(k)) {
    return own ? `<div class="ai-instr-chip">${IC.note}<span>This group has its own AI instructions.</span><button class="link" data-act="ai-instr" type="button">Edit</button></div>` : '';
  }
  return card(k);
}

export function aiCommands(cur) {
  if (!aiEnabled()) return [{ type: 'cmd', label: 'AI settings', sub: 'AI summaries are off', ico: IC.gear, run: () => openAiSettings() }];
  const c = [];
  if (cur) {
    c.push({ type: 'cmd', label: `Summarize “${cur.name}”`, sub: 'What is this group about?', ico: IC.spark, run: () => start('group', cur.id) });
    c.push({ type: 'cmd', label: `AI instructions for “${cur.name}”`, sub: 'Tell the AI how to summarize this group', ico: IC.note, run: () => openGroupInstructions(cur) });
  }
  c.push({ type: 'cmd', label: 'AI settings', sub: 'Engine, Gemini API key, general instructions', ico: IC.gear, run: () => openAiSettings() });
  return c;
}

/** Extra items for the group "more" menu. */
export function groupMenuItems(g) {
  if (!aiEnabled()) return [];
  const has = !!state.settings.groups[groupKey(g.name)];
  return [{ html: `<span>${has ? 'Edit' : 'Add'} AI instructions for this group…</span>`, run: () => openGroupInstructions(g) }];
}

/** Keep a group's instructions when it is renamed. */
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
  switch (a) {
    case 'ai-tab': start('tab', +row.dataset.id); return true;
    case 'ai-group': if (g) start('group', g.id); return true;
    case 'ai-refresh': { const [kind, id] = key.split(':'); start(kind, +id, { force: true }); return true; }
    case 'ai-stop': sums.get(key)?.ctrl?.abort(); return true;
    case 'ai-dismiss': sums.get(key)?.ctrl?.abort(); sums.delete(key); ctx.renderMain(); return true;
    case 'ai-copy': {
      const s = sums.get(key);
      if (s?.text) navigator.clipboard.writeText(s.text).then(() => ctx.toast('Summary copied'), () => ctx.toast('Couldn’t copy'));
      return true;
    }
    case 'ai-instr': if (g) openGroupInstructions(g); return true;
    case 'ai-settings': openAiSettings(); return true;
    case 'ai-grant': grantAccessThen(() => { const [kind, id] = key.split(':'); start(kind, +id, { force: true }); }); return true;
  }
  return false;
}

/* ---------- running a summary ---------- */

function target(kind, id) {
  if (kind === 'tab') {
    const x = ctx.tabById(id);
    return x && { tab: x.t, groupName: x.owner?.name ?? null, title: x.t.title };
  }
  const g = ctx.groupById(id);
  return g && { group: g, groupName: g.name, title: g.name };
}

/**
 * Start a summary. Called straight from a click so Chrome sees a user gesture
 * (needed for the permission prompt and for the first on-device model download).
 */
function start(kind, id, { force = false } = {}) {
  const t = target(kind, id);
  if (!t) return;
  const s = state.settings;
  const engine = chooseEngine({ kind, setting: s.engine, local: state.local, hasKey: state.hasKey });

  // 1. Page access: explain first, then let Chrome ask.
  if (!state.access && !s.pageAccessDeclined) return explainAccess(() => start(kind, id, { force }));
  // 2. Cloud consent, once.
  if (engine === 'cloud' && !s.cloudConsentAt) return askCloudConsent(kind, () => start(kind, id, { force }));
  run(kind, id, t, force);
}

async function run(kind, id, t, force) {
  const key = `${kind}:${id}`;
  sums.get(key)?.ctrl?.abort();
  const s = { status: 'running', text: '', statusText: kind === 'group' ? 'Reading tabs…' : 'Reading the page…', progress: null, ctrl: new AbortController(), engine: null };
  sums.set(key, s);
  ctx.renderMain();
  const paint = throttle(() => paint0(key), 60);
  const opts = {
    force, signal: s.ctrl.signal, access: state.access, groupName: t.groupName,
    onChunk: text => { s.text = text; s.statusText = ''; paint(); },
    onProgress: f => { s.progress = f; s.statusText = `Downloading the on-device model… ${Math.round(f * 100)}%`; paint(); },
    onStatus: text => { s.statusText = text; paint(); },
  };
  try {
    s.engine = await AI.plannedEngine(kind).catch(() => null);
    paint();
    const r = kind === 'tab'
      ? await AI.summarizeTab(t.tab, opts)
      : await AI.summarizeGroup({ name: t.group.name, tabs: t.group.tabs }, opts);
    Object.assign(s, r, { status: 'done', statusText: '', progress: null });
  } catch (e) {
    if (e?.name === 'AbortError') Object.assign(s, { status: s.text ? 'done' : 'stopped', stopped: true, statusText: '' });
    else { console.error(e); Object.assign(s, { status: 'error', error: e?.message || String(e), code: e?.code, statusText: '' }); }
  }
  s.ctrl = null;
  if (state.local !== 'available' && s.engine === 'local' && s.status === 'done') refreshState();
  paint0(key);
}

function paint0(key) {
  const el = document.querySelector(`[data-sum="${key}"]`);
  if (el) el.outerHTML = card(key);
}

function throttle(fn, ms) {
  let t = null;
  return () => { if (!t) t = setTimeout(() => { t = null; fn(); }, ms); };
}

const REASONS = {
  restricted: 'Chrome doesn’t let extensions read this page, so this is based on its title and address only.',
  sleeping: 'This tab is asleep, so this is based on its title and address only. Open the tab and summarize again for a full summary.',
  'no-access': 'Tab Desk can’t read page text yet, so this is based on the title and address only.',
  incognito: 'Incognito tabs aren’t read, so this is based on the title and address only.',
  empty: 'The page had no readable text, so this is based on its title and address only.',
  failed: 'The page couldn’t be read, so this is based on its title and address only.',
};

function card(key) {
  const s = sums.get(key);
  const isGroup = key.startsWith('group:');
  const engine = s.engine === 'cloud' ? `<span class="ai-engine cloud" title="Sent to Google’s Gemini API with your key">Gemini · cloud</span>`
    : s.engine === 'local' ? `<span class="ai-engine" title="Generated on this device. Nothing left your computer.">On-device</span>` : '';
  const running = s.status === 'running';
  const tools = running
    ? `<button class="btn ghost sm" data-act="ai-stop" type="button">Stop</button>`
    : `${s.text ? `<button class="icon-btn" data-act="ai-copy" type="button" title="Copy summary" aria-label="Copy summary">${COPY}</button>` : ''}
       <button class="icon-btn" data-act="ai-refresh" type="button" title="Summarize again" aria-label="Summarize again">${REFRESH}</button>
       ${isGroup ? `<button class="icon-btn" data-act="ai-instr" type="button" title="AI instructions for this group" aria-label="AI instructions for this group">${IC.note}</button>` : ''}
       <button class="icon-btn" data-act="ai-dismiss" type="button" title="Hide summary" aria-label="Hide summary">${CLOSE}</button>`;
  const when = s.status === 'done' ? `<span class="ai-when">${s.cached ? 'Saved summary' : 'Just now'}</span>` : '';
  let body = '';
  if (s.text) body = `<div class="ai-text">${renderSummary(s.text)}</div>`;
  if (running && s.statusText) body += `<div class="ai-status" role="status">${s.progress != null ? `<span class="ai-bar"><i style="width:${Math.round(s.progress * 100)}%"></i></span>` : '<span class="ai-spin" aria-hidden="true"></span>'}${esc(s.statusText)}</div>`;
  if (s.status === 'error') {
    const fix = s.code === 'key' || s.code === 'model' || s.code === 'no-engine'
      ? `<button class="btn sm" data-act="ai-settings" type="button">Open AI settings</button>` : `<button class="btn sm" data-act="ai-refresh" type="button">Try again</button>`;
    body += `<div class="ai-error">${esc(s.error)} ${fix}</div>`;
  }
  if (s.status === 'stopped') body += `<div class="ai-note">Stopped.</div>`;
  const notes = [];
  if (s.status === 'done') {
    if (!isGroup && s.reason && REASONS[s.reason]) notes.push(esc(REASONS[s.reason]) + (s.reason === 'no-access' ? ' <button class="link" data-act="ai-grant" type="button">Allow page access</button>' : ''));
    if (s.partial) notes.push('The page is long, so this covers its first part.');
    if (s.stopped) notes.push('Stopped early.');
    if (isGroup && s.unreadable?.length) {
      const noAccess = s.unreadable.some(u => u.reason === 'no-access');
      notes.push(`Based on titles only for ${s.unreadable.length === 1 ? '1 tab' : `${s.unreadable.length} tabs`} that couldn’t be read: ${s.unreadable.slice(0, 4).map(u => `“${esc(u.title)}”`).join(', ')}${s.unreadable.length > 4 ? '…' : ''}${noAccess ? ' <button class="link" data-act="ai-grant" type="button">Allow page access</button>' : ''}`);
    }
    if (isGroup && s.skipped) notes.push(`Used the ${s.engine === 'cloud' ? 20 : 12} most recent tabs; ${s.skipped} more were left out.`);
  }
  return `<section class="ai-card${isGroup ? ' group' : ''}" data-sum="${key}" aria-label="${isGroup ? 'Group summary' : 'Tab summary'}" aria-busy="${running}">
    <div class="ai-head"><span class="ai-title">${IC.spark}${isGroup ? 'What this group is about' : 'Summary'}</span>${engine}${when}<span class="ai-tools">${tools}</span></div>
    ${body}${notes.length ? `<div class="ai-note">${notes.join('<br>')}</div>` : ''}</section>`;
}

const COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
const REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/></svg>';
const CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

/* ---------- permission + consent dialogs ---------- */

function explainAccess(then) {
  ctx.openModal(`<div class="dialog-head"><h2>Let Tab Desk read the pages you summarize?</h2>
      <p>To summarize a page, Tab Desk reads its text. It only reads pages when you press Summarize, and never reloads sleeping tabs.</p></div>
    <div class="dialog-body"><p class="ai-muted">Chrome will ask to “read and change your data on all websites”. Tab Desk only reads text from the tabs you summarize. Without it, summaries use page titles and addresses only.</p></div>
    <div class="dialog-foot"><button class="btn" data-m="titles" type="button">Use titles only</button><button class="btn primary" data-m="ok" type="button">Allow page access</button></div>`,
  box => {
    box.querySelector('[data-m=titles]').onclick = async () => {
      ctx.closeModal();
      await AI.saveSettings({ pageAccessDeclined: true });
      state.settings = { ...state.settings, pageAccessDeclined: true };
      then();
    };
    box.querySelector('[data-m=ok]').onclick = () => {
      // Must run inside the click: Chrome only shows the prompt during a user gesture.
      const req = AI.requestPageAccess();
      ctx.closeModal();
      req.then(async ok => {
        state.access = ok;
        if (!ok) { await AI.saveSettings({ pageAccessDeclined: true }); state.settings = { ...state.settings, pageAccessDeclined: true }; }
        then();
      });
    };
  });
}

function grantAccessThen(then) {
  AI.requestPageAccess().then(async ok => {
    state.access = ok;
    if (ok) { await AI.saveSettings({ pageAccessDeclined: false }); then(); }
    else ctx.toast('Page access wasn’t granted');
  });
}

function askCloudConsent(kind, then) {
  const localOk = state.local !== 'unavailable';
  ctx.openModal(`<div class="dialog-head"><h2>Send page content to Google Gemini?</h2>
      <p>${kind === 'group' ? 'For a group summary, the text of the readable tabs in the group' : 'The text of this page'} will be sent to Google’s Gemini API using your API key.</p></div>
    <div class="dialog-body ai-muted"><p>Google handles it under the Gemini API terms for your key. On the free tier, Google may use what you send to improve its products. Tab Desk has no server of its own and never sees your data.</p>
      <p>Summaries sent to Gemini are labeled <span class="ai-engine cloud">Gemini · cloud</span>. You’ll only be asked once; you can turn the cloud off any time in AI settings.</p></div>
    <div class="dialog-foot">${localOk ? '<button class="btn" data-m="local" type="button">Use on-device instead</button>' : ''}<button class="btn" data-m="cancel" type="button">Cancel</button><button class="btn primary" data-m="ok" type="button">Send to Gemini</button></div>`,
  box => {
    box.querySelector('[data-m=cancel]').onclick = ctx.closeModal;
    box.querySelector('[data-m=local]')?.addEventListener('click', async () => {
      ctx.closeModal();
      await AI.saveSettings({ engine: 'local' });
      state.settings = { ...state.settings, engine: 'local' };
      ctx.toast('Summaries will stay on this device. You can change this in AI settings.');
      then();
    });
    box.querySelector('[data-m=ok]').onclick = async () => {
      ctx.closeModal();
      const at = Date.now();
      await AI.saveSettings({ cloudConsentAt: at });
      state.settings = { ...state.settings, cloudConsentAt: at };
      then();
    };
  });
}

/* ---------- group instructions ---------- */

export function openGroupInstructions(g) {
  const s = state.settings;
  const cur = s.groups[groupKey(g.name)] || '';
  ctx.openModal(`<div class="dialog-head"><h2>AI instructions for “${esc(g.name)}”</h2>
      <p>Added to every summary of this group and of the tabs in it. Saved by group name, so it also applies after a restart or when you restore it from Workspaces.</p></div>
    <div class="dialog-body">
      <label class="ai-field"><span>Instructions for this group</span>
        <textarea id="aiGroupInstr" rows="5" maxlength="${MAX_INSTRUCTIONS}" placeholder="e.g. This is research for a trip to Japan in April. Focus on prices, dates and opening hours.">${esc(cur)}</textarea></label>
      <div class="ai-muted ai-small">${s.general ? `General instructions also apply: “${esc(s.general.length > 140 ? s.general.slice(0, 140) + '…' : s.general)}”` : 'No general instructions set.'} <button class="link" data-m="general" type="button">Edit general instructions</button></div>
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
  });
}

/* ---------- settings ---------- */

const LOCAL_LABEL = {
  available: 'Ready on this device.',
  downloadable: 'Supported. Chrome needs to download the model once (a few GB) before first use.',
  downloading: 'Chrome is downloading the model…',
  unavailable: 'Not available here. It needs desktop Chrome 138 or later with enough memory and free disk space, and supports English, Spanish, Japanese, German and French.',
};

export async function openAiSettings({ focus } = {}) {
  await refreshState();
  const s = state.settings;
  const key = await AI.getApiKey();
  const cached = await AI.cacheSize();
  const groupRows = Object.entries(s.groups);
  const radio = (v, label, sub) => `<label class="ai-radio"><input type="radio" name="aiEngine" value="${v}" ${s.engine === v ? 'checked' : ''}><span><b>${label}</b><span>${sub}</span></span></label>`;
  ctx.openModal(`<div class="dialog-head"><h2>AI summaries</h2><p>Summaries run on your device by default. Add your own Gemini API key for better group summaries.</p></div>
    <div class="dialog-body ai-settings">
      <label class="ai-check"><input type="checkbox" id="aiEnabled" ${s.enabled ? 'checked' : ''}><span>Show Summarize buttons</span></label>

      <h3>Engine</h3>
      ${radio('auto', 'Auto', 'On-device for tabs when ready. Gemini for groups when you’ve added a key.')}
      ${radio('local', 'On-device only', 'Nothing leaves your computer.')}
      ${radio('cloud', 'Gemini API only', 'Always use your Gemini key.')}
      <div class="ai-status-line"><span class="ai-dot ${state.local}"></span><span>On-device model (Gemini Nano): ${esc(LOCAL_LABEL[state.local] || state.local)}</span>
        ${state.local === 'downloadable' ? '<button class="btn sm" id="aiDownload" type="button">Download</button>' : ''}</div>
      <div class="ai-bar wide" id="aiDlBar" hidden><i></i></div>

      <label class="ai-field"><span>Summary length</span>
        <select id="aiLength"><option value="short" ${s.length === 'short' ? 'selected' : ''}>Short (3–5 points)</option><option value="medium" ${s.length === 'medium' ? 'selected' : ''}>Medium (5–7 points)</option></select></label>

      <h3>Gemini API key <span class="ai-muted">(optional)</span></h3>
      <div class="ai-key-row">
        <input id="aiKey" type="password" autocomplete="off" spellcheck="false" placeholder="Paste a key from Google AI Studio" value="${esc(key)}" aria-label="Gemini API key">
        <button class="btn sm" id="aiKeyShow" type="button">Show</button>
        <button class="btn sm" id="aiKeyTest" type="button">Test</button>
      </div>
      <div class="ai-muted ai-small" id="aiKeyMsg">Get a key at <a href="${AI_STUDIO}" target="_blank" rel="noopener">Google AI Studio</a>. It’s stored unencrypted in this Chrome profile only (not synced). Use a key limited to the Gemini API.</div>
      <label class="ai-field"><span>Gemini model</span><input id="aiModel" type="text" spellcheck="false" value="${esc(s.model)}" placeholder="${DEFAULT_MODEL}"></label>

      <h3>Custom instructions</h3>
      <label class="ai-field"><span>General instructions, for every summary</span>
        <textarea id="aiGeneral" rows="4" maxlength="${MAX_INSTRUCTIONS}" placeholder="e.g. Write in Vietnamese. Keep it brief and mention prices and deadlines if there are any.">${esc(s.general)}</textarea></label>
      <div class="ai-field"><span>Group instructions</span>
        ${groupRows.length ? `<ul class="ai-glist">${groupRows.map(([k, v]) => `<li data-gk="${esc(k)}"><b>${esc(k)}</b><span>${esc(v.length > 90 ? v.slice(0, 90) + '…' : v)}</span><button class="icon-btn" data-m="gdel" type="button" title="Remove" aria-label="Remove instructions for ${esc(k)}">${CLOSE}</button></li>`).join('')}</ul>`
          : '<div class="ai-muted ai-small">None yet. Open a group and choose “AI instructions” from its ⋯ menu or the group summary.</div>'}
      </div>

      <h3>Privacy</h3>
      <div class="ai-status-line"><span class="ai-dot ${state.access ? 'available' : 'unavailable'}"></span><span>Page access: ${state.access ? 'Tab Desk can read the text of pages you summarize.' : 'Off. Summaries use titles and addresses only.'}</span>
        <button class="btn sm" id="aiAccess" type="button">${state.access ? 'Revoke' : 'Allow'}</button></div>
      <div class="ai-status-line"><span>${cached} saved ${cached === 1 ? 'summary' : 'summaries'} on this device.</span><button class="btn sm" id="aiClear" type="button" ${cached ? '' : 'disabled'}>Clear</button></div>
      ${s.cloudConsentAt ? '<div class="ai-muted ai-small">You agreed to send page content to Gemini. Removing your key resets this.</div>' : ''}
    </div>
    <div class="dialog-foot"><button class="btn" data-m="cancel" type="button">Cancel</button><button class="btn primary" data-m="ok" type="button">Save</button></div>`,
  box => {
    const $b = sel => box.querySelector(sel);
    const removedGroups = new Set();
    if (focus === 'general') { const g = $b('#aiGeneral'); g.focus(); g.scrollIntoView({ block: 'center' }); }
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
        await AI.saveSettings({ pageAccessDeclined: !state.access });
        e.target.textContent = state.access ? 'Revoke' : 'Allow';
        e.target.previousElementSibling.textContent = `Page access: ${state.access ? 'Tab Desk can read the text of pages you summarize.' : 'Off. Summaries use titles and addresses only.'}`;
        e.target.parentElement.querySelector('.ai-dot').className = `ai-dot ${state.access ? 'available' : 'unavailable'}`;
      });
    };
    $b('#aiClear').onclick = async e => { await AI.clearCache(); e.target.disabled = true; e.target.previousElementSibling.textContent = '0 saved summaries on this device.'; };
    box.querySelectorAll('[data-m=gdel]').forEach(b => b.onclick = () => { const li = b.closest('li'); removedGroups.add(li.dataset.gk); li.remove(); });
    $b('[data-m=ok]').onclick = async () => {
      const newKey = $b('#aiKey').value.trim();
      // Ask for the Gemini host inside the click, before any await.
      const perm = newKey && newKey !== key ? chrome.permissions.request({ origins: GEMINI_ORIGINS }).catch(() => false) : Promise.resolve(true);
      const groups = { ...state.settings.groups };
      removedGroups.forEach(k => delete groups[k]);
      await perm;
      await AI.setApiKey(newKey);
      if (!newKey && key) chrome.permissions.remove({ origins: GEMINI_ORIGINS }).catch(() => {});
      await AI.saveSettings({
        enabled: $b('#aiEnabled').checked,
        engine: box.querySelector('input[name=aiEngine]:checked')?.value || 'auto',
        length: $b('#aiLength').value,
        model: $b('#aiModel').value.trim() || DEFAULT_MODEL,
        general: $b('#aiGeneral').value.trim(),
        groups,
        ...(newKey !== key ? { cloudConsentAt: 0 } : {}),
      });
      await refreshState();
      ctx.closeModal();
      ctx.render();
      ctx.toast('AI settings saved');
    };
  });
}
