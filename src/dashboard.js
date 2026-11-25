import {
  COLORS, COLOR_NAMES, buildModel, allTabs, findDuplicates, duplicateCount, domainProposals,
  hostOf, shortUrl, siteName, plural, timeAgo, nextColor, score, savedLabel, groupMoveTarget, neighborMove,
  cardTabs, groupFacts, lastUsed,
} from './lib/model.js';
import * as A from './lib/actions.js';
import { listWorkspaces, onWorkspacesChanged } from './lib/workspaces.js';
import * as AIUI from './ai-ui.js';
import { statusRank } from './lib/ai-core.js';

const SELF_URL = chrome.runtime.getURL('dashboard.html');
const isMac = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || '');
const MOD = isMac ? '⌘' : 'Ctrl';
const PAL_PLACEHOLDER = 'Search tabs, groups, workspaces. Type > for commands';

let selfTab = null;
let model = { groups: [], inbox: [], windowCount: 1, tabCount: 0 };
let workspaces = [];
let view = { kind: 'dashboard' };
let selected = new Set();
let renaming = false;
let deferred = false;
let dragging = null; // id of the group being dragged in the sidebar
const showAllTabs = new Set(); // dashboard cards opened up to list every tab
const CARD_TABS = 8; // tabs listed on a dashboard card before "+ N more"


// Sidebar groups opened to show their tabs. Remembered per browser; it is only a convenience.
const EXPANDED_KEY = 'tabdesk.expandedGroups';
const expanded = new Set((() => { try { return JSON.parse(localStorage.getItem(EXPANDED_KEY)) || []; } catch { return []; } })());
function saveExpanded() {
  const live = new Set(model.groups.map(g => g.id));
  for (const id of expanded) if (!live.has(id)) expanded.delete(id);
  try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded])); } catch {}
}

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cvar = c => `var(--g-${c})`;
const groupById = id => model.groups.find(g => g.id === id);
const tabById = id => allTabs(model).find(x => x.t.id === id);
const isSelf = t => (t.url || t.pendingUrl || '').startsWith(SELF_URL);
const titleOf = t => t.title || shortUrl(t.url || t.pendingUrl) || 'New tab';

/* ---------- data ---------- */
async function refresh() {
  const [tabs, groups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})]);
  model = buildModel(tabs, groups, isSelf);
  const live = new Set(allTabs(model).map(x => x.t.id));
  for (const id of selected) if (!live.has(id)) selected.delete(id);
  if (view.kind === 'group' && !groupById(view.id)) {
    view = model.groups[0] ? { kind: 'group', id: model.groups[0].id } : { kind: 'inbox' };
  }
  if (renaming || dragging != null) { deferred = true; return; }
  render();
  if (!$('#pal').hidden) renderPalette();
  AIUI.noticeTabs(allTabs(model));
}
let refreshTimer;
const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 80); };

const RELEVANT = ['title', 'url', 'status', 'groupId', 'discarded', 'audible', 'pinned', 'favIconUrl'];
chrome.tabs.onUpdated.addListener((id, info) => { if (RELEVANT.some(k => k in info)) scheduleRefresh(); });
['onCreated', 'onRemoved', 'onMoved', 'onAttached', 'onDetached', 'onActivated', 'onReplaced'].forEach(e => chrome.tabs[e].addListener(scheduleRefresh));
['onCreated', 'onUpdated', 'onRemoved', 'onMoved'].forEach(e => chrome.tabGroups[e].addListener(scheduleRefresh));
onWorkspacesChanged(list => { workspaces = list; render(); if (!$('#pal').hidden) renderPalette(); });
chrome.runtime.onMessage.addListener(msg => { if (msg?.type === 'open-palette') openPalette(); });

/* ---------- toast + running actions ---------- */
let toastTimer = null;
function toast(msg, undo = null) {
  document.querySelectorAll('.toast').forEach(n => n.remove());
  clearTimeout(toastTimer);
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>${msg}</span>` + (undo ? '<button type="button">Undo</button>' : '');
  const b = el.querySelector('button');
  if (b) b.onclick = async () => {
    el.remove();
    try { await undo(); toast('Undone'); } catch (e) { toast(`Couldn't undo: ${esc(e.message)}`); }
    scheduleRefresh();
  };
  document.body.append(el);
  toastTimer = setTimeout(() => el.remove(), 6000);
}

/** Run an action. `fn` resolves to {msg, undo?} or nothing. */
async function perform(fn) {
  closeMenu();
  try {
    const r = await fn();
    await refresh();
    if (r?.msg) toast(r.msg, r.undo || null);
  } catch (e) {
    console.error(e);
    toast(`Couldn't finish that: ${esc(e.message || e)}`);
    scheduleRefresh();
  }
}

/* ---------- actions wired to UI ---------- */
function setView(v) { view = v; selected.clear(); renaming = false; closeMenu(); render(); $('#main').scrollTop = 0; }

const doCloseTabs = ids => perform(async () => ({ msg: `Closed ${plural(ids.length, 'tab')}`, undo: await A.closeTabs(ids) }));

const doMove = (ids, target) => perform(async () => {
  const { undo, groupId } = await A.moveTabs(ids, target, model);
  const label = target === 'inbox' ? 'Inbox' : typeof target === 'object' ? `“${esc(target.newGroup || 'a new group')}”` : `“${esc(groupById(target)?.name)}”`;
  selected.clear();
  if (typeof target === 'object' && groupId != null) view = { kind: 'group', id: groupId };
  return { msg: `Moved ${plural(ids.length, 'tab')} to ${label}`, undo };
});

const doSaveClose = g => perform(async () => {
  const { undo } = await A.saveAndCloseGroup(g);
  return { msg: `Saved “${esc(g.name)}” to Workspaces and closed ${plural(g.tabs.length, 'tab')}`, undo };
});

const doRestore = ws => perform(async () => {
  const { groupId, count, undo } = await A.restoreWorkspace(ws, selfTab.windowId);
  view = { kind: 'group', id: groupId };
  return { msg: `Restored “${esc(ws.name)}” with ${plural(count, 'tab')}`, undo };
});

const doFocus = g => perform(() => A.focusGroup(g, model));

/** Move group `id` before or after group `targetId`, in the real tab strip. */
function doMoveGroup(id, targetId, place, refocus = false) {
  const g = groupById(id);
  const to = g && groupMoveTarget(model.groups, id, targetId, place);
  if (!to) return;
  const crossWindow = to.windowId !== g.windowId;
  perform(async () => {
    const undo = await A.moveGroup(g, to);
    return { msg: `Moved “${esc(g.name)}”${crossWindow ? ' to another window' : ''}`, undo };
  }).then(() => { if (refocus) document.querySelector(`[data-nav=group][data-id="${id}"]`)?.focus(); });
}

/* ---------- favicons ---------- */
function hash(s) { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0; return Math.abs(h); }
function fav(url = '') {
  const host = siteName(url);
  const parts = host.split('.');
  const key = parts.length > 2 ? parts[parts.length - 2] : parts[0] || '?';
  const hue = hash(key) % 360;
  const img = /^https?:/.test(url)
    ? `<img src="${esc(chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=32`))}" alt="" loading="lazy">`
    : '';
  return `<span class="fav" style="background:hsl(${hue} 52% 44%)" aria-hidden="true">${esc((key[0] || '?').toUpperCase())}${img}</span>`;
}
document.addEventListener('error', e => { if (e.target.tagName === 'IMG' && e.target.closest('.fav')) e.target.remove(); }, true);

/* ---------- icons ---------- */
const ICON = {
  move: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0-4-4m4 4 4-4M5 21h14"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7M14 17.5h7"/></svg>',
  copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9m0 0-4 4m4-4 4 4M5 3h14"/></svg>',
  inbox: '<svg class="inbox-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6H3v-6l2-8Z"/></svg>',
  stack: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3 4 14h7l-1 7 9-11h-7l1-7Z"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
  grid: '<svg class="grid-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
  go: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>',
};

/* ---------- render ---------- */
function render() { renderSide(); renderMain(); }

function renderSide() {
  const dupCount = duplicateCount(model);
  $('#brandStat').textContent = plural(model.tabCount, 'tab');
  const cur = (k, id) => String(view.kind === k && (id == null || view.id === id));
  const multiWin = model.windowCount > 1;
  let h = `<div class="nav-scroll"><div class="nav-items" style="padding-top:4px">
    <button class="nav-item" data-nav="dashboard" aria-current="${cur('dashboard')}" type="button" title="Every open group on one page">${ICON.grid}<span class="name">Dashboard</span><span class="hot">Alt 0</span><span class="count">${model.groups.length}</span></button>
    <button class="nav-item" data-nav="inbox" aria-current="${cur('inbox')}" type="button">${ICON.inbox}<span class="name">Inbox</span><span class="count">${model.inbox.length}</span></button>
  </div></div>`;
  h += `<div class="nav-label"><span>Open groups</span><span>${model.groups.length}</span></div><div class="nav-scroll"><div class="nav-items">`;
  if (!model.groups.length) h += `<div class="mock-note" style="padding:4px 8px">No tab groups yet. Select tabs in the Inbox and move them to a new group.</div>`;
  model.groups.forEach((g, i) => {
    const open = expanded.has(g.id);
    h += `<div class="nav-group${dragging === g.id ? ' is-dragging' : ''}" data-gid="${g.id}" style="--c:${cvar(g.color)}">
      <div class="nav-row" draggable="true" title="Drag to reorder. Alt+↑/↓ moves the group in the tab strip.">
      <button class="chev" data-side="toggle" type="button" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} tabs in ${esc(g.name)}">${ICON.chev}</button>
      <button class="nav-item" data-nav="group" data-id="${g.id}" aria-current="${cur('group', g.id)}" type="button" title="${esc(g.name)}">
      <span class="dot"></span><span class="name">${esc(g.name)}</span>${multiWin ? `<span class="win-tag">W${g.window}</span>` : ''}${i < 9 ? `<span class="hot">Alt ${i + 1}</span>` : ''}<span class="count">${g.tabs.length}</span></button></div>`;
    if (open) {
      h += `<ul class="nav-tabs">${g.tabs.map(t => {
        const url = t.url || t.pendingUrl || '';
        return `<li><button class="nav-tab${t.active ? ' is-active' : ''}" data-side-tab="${t.id}" type="button" title="${esc(titleOf(t))}\n${esc(shortUrl(url))}">${fav(url)}<span class="name">${esc(titleOf(t))}</span></button></li>`;
      }).join('')}</ul>`;
    }
    h += `</div>`;
  });
  h += `</div></div>`;
  h += `<div class="nav-label"><span>Workspaces</span><span>${workspaces.length} saved</span></div><div class="nav-scroll"><div class="nav-items">`;
  h += `<button class="nav-item" data-nav="workspaces" aria-current="${cur('workspaces')}" type="button"><span style="display:grid;color:var(--muted)">${ICON.stack}</span><span class="name">All workspaces</span></button>`;
  workspaces.forEach(w => {
    h += `<button class="nav-item saved" data-nav="ws" data-id="${esc(w.id)}" style="--c:${cvar(w.color)}" type="button" title="Saved ${esc(savedLabel(w.savedAt))}"><span class="dot hollow"></span><span class="name">${esc(w.name)}</span><span class="count">${w.tabs.length}</span></button>`;
  });
  h += `</div></div>`;
  $('#nav').innerHTML = h;
  const btn = $('#dupBtn');
  btn.innerHTML = dupCount
    ? `${ICON.copy}<span style="flex:1"><b>${plural(dupCount, 'duplicate tab')}</b> open</span><span>Review</span>`
    : `${ICON.copy}<span style="flex:1">No duplicate tabs</span>`;
  btn.disabled = !dupCount;
}

function tabRow(t, counts) {
  const badges = [];
  if (t.pinned) badges.push('<span class="badge">Pinned</span>');
  if (t.active) badges.push('<span class="badge active" title="The visible tab in its window">Active</span>');
  if (t.audible) badges.push('<span class="badge audio">Playing</span>');
  if (counts.get(t.url) > 1) badges.push('<span class="badge dup">Duplicate</span>');
  if (t.discarded || t.frozen) badges.push('<span class="badge sleep" title="Unloaded to save memory. It reloads when you open it.">Sleeping</span>');
  const url = t.url || t.pendingUrl || '';
  const u = shortUrl(url);
  const d = siteName(url);
  const urlHtml = d && u.startsWith(d) ? `<b>${esc(d)}</b>${esc(u.slice(d.length))}` : esc(u);
  const ago = timeAgo(t.lastAccessed);
  return `<li class="tab${selected.has(t.id) ? ' is-selected' : ''}" data-id="${t.id}">
    <input type="checkbox" id="sel-${t.id}" data-act="select" ${selected.has(t.id) ? 'checked' : ''} aria-label="Select ${esc(titleOf(t))}">
    ${fav(url)}
    <div class="tab-text"><div class="tab-title"><span class="t">${esc(titleOf(t))}</span>${AIUI.tabStatus(t)}${badges.join('')}</div><div class="tab-url">${urlHtml}</div>${AIUI.tabLine(t)}</div>
    <span class="tab-meta">${ago ? (ago === 'now' ? 'Now' : `${ago} ago`) : ''}</span>
    <div class="tab-actions">
      ${AIUI.tabSumButton(t)}
      <button class="icon-btn" data-act="move" type="button" title="Move to group" aria-label="Move to group">${ICON.move}</button>
      <button class="icon-btn close" data-act="close" type="button" title="Close tab" aria-label="Close tab">${ICON.close}</button>
    </div></li>`;
}

function bulkBar() {
  if (!selected.size) return '';
  return `<div class="bulk"><span class="grow">${plural(selected.size, 'tab')} selected</span>
    <button class="btn" data-act="bulk-move" type="button">${ICON.move} Move to…</button>
    <button class="btn" data-act="bulk-close" type="button">${ICON.close} Close</button>
    <button class="btn" data-act="bulk-clear" type="button">Clear</button></div>`;
}

const hints = () => `<div class="hint-row"><span><kbd>${MOD} K</kbd> jump anywhere</span><span><kbd>Alt 1–9</kbd> show group</span><span>Click a row to switch to that tab</span></div>`;

function urlCounts() {
  const m = new Map();
  allTabs(model).forEach(({ t }) => t.url && m.set(t.url, (m.get(t.url) || 0) + 1));
  return m;
}

function renderMain() {
  const counts = urlCounts();
  if (view.kind === 'dashboard') { $('#main').innerHTML = renderDashboard(); return; }
  let h = '<div class="pane">';
  if (view.kind === 'group' && groupById(view.id)) {
    const g = groupById(view.id);
    const sites = new Set(g.tabs.map(t => hostOf(t.url))).size;
    const sleeping = g.tabs.filter(t => t.discarded || t.frozen).length;
    h += `<div class="pane-head" style="--c:${cvar(g.color)}">
      <div class="pane-title">
        <div class="eyebrow"><span class="bar"></span>${COLOR_NAMES[g.color]} group${model.windowCount > 1 ? ` · window ${g.window}` : ''}${g.collapsed ? ' · collapsed' : ''}</div>
        ${renaming ? `<input class="rename-input" id="renameInput" value="${esc(g.title)}" placeholder="Group name" aria-label="Group name">` : `<h1>${esc(g.name)}</h1>`}
        <div class="pane-meta">${plural(g.tabs.length, 'tab')} · ${plural(sites, 'site')}${sleeping ? ` · ${sleeping} sleeping` : ''} ${AIUI.groupStatusBadge(g)}</div>
      </div>
      <div class="actions">
        <button class="btn ghost" data-act="rename" type="button">${ICON.pen} Rename</button>
        <button class="btn" data-act="color" type="button"><span class="swatch"></span> Color</button>
        <button class="btn" data-act="group-more" type="button" aria-label="More group actions">${ICON.more}</button>
        ${AIUI.groupSumButtons()}
        <button class="btn" data-act="focus" type="button" title="Expand this group, collapse the others in its window and open its most recent tab">${ICON.go} Switch to group</button>
        <button class="btn primary" data-act="save-close" type="button" title="Save this group as a workspace and close its tabs">${ICON.save} Save &amp; close</button>
      </div></div>`;
    h += bulkBar();
    h += AIUI.groupSumCard(g, { detail: true });
    h += `<ul class="tabs">${g.tabs.map(t => tabRow(t, counts)).join('')}</ul>`;
    h += hints();
  } else if (view.kind === 'workspaces') {
    h += `<div class="pane-head"><div class="pane-title">
        <div class="eyebrow"><span class="bar"></span>Saved for later</div>
        <h1>Workspaces</h1>
        <div class="pane-meta">Groups you saved and closed. Restore one to reopen its tabs as a group in this window.</div>
      </div></div>`;
    if (!workspaces.length) h += `<div class="empty"><strong>No saved workspaces</strong>Open a group and press Save &amp; close to park it here.</div>`;
    else {
      h += '<div class="ws-grid">';
      workspaces.forEach(w => {
        h += `<article class="ws-card" data-wid="${esc(w.id)}" style="--c:${cvar(w.color)}">
          <div class="ws-top"><span class="dot"></span><span class="ws-name">${esc(w.name)}</span></div>
          <div class="ws-meta">${plural(w.tabs.length, 'tab')} · saved ${esc(savedLabel(w.savedAt))}</div>
          <ul class="ws-tabs">${w.tabs.slice(0, 4).map(t => `<li>${fav(t.url)}<span>${esc(t.title)}</span></li>`).join('')}
          ${w.tabs.length > 4 ? `<li class="more">+ ${w.tabs.length - 4} more</li>` : ''}</ul>
          <div class="ws-actions"><button class="btn primary" data-act="restore" type="button">${ICON.restore} Restore</button>
          <button class="btn" data-act="ws-delete" type="button">Delete</button></div></article>`;
      });
      h += '</div>';
    }
  } else {
    const props = domainProposals(model.inbox);
    h += `<div class="pane-head"><div class="pane-title">
        <div class="eyebrow"><span class="bar"></span>Ungrouped tabs</div>
        <h1>Inbox</h1>
        <div class="pane-meta">${plural(model.inbox.length, 'tab')} not in any group.</div>
      </div><div class="actions">
        <button class="btn primary" data-act="by-domain" type="button" ${props.length ? '' : 'disabled'}>${ICON.sparkle} Group by site${props.length ? ` (${props.length})` : ''}</button>
      </div></div>`;
    h += bulkBar();
    h += model.inbox.length ? `<ul class="tabs">${model.inbox.map(t => tabRow(t, counts)).join('')}</ul>`
      : `<div class="empty"><strong>Inbox zero</strong>Every open tab belongs to a group.</div>`;
    h += hints();
  }
  h += '</div>';
  $('#main').innerHTML = h;
  if (renaming) { const i = $('#renameInput'); i.focus(); i.select(); }
}

/* ---------- dashboard ---------- */
// "Most urgent first": order cards by the most urgent tab status in each group (Needs you first).
const URGENT_KEY = 'tabdesk.urgentFirst';
let urgentFirst = (() => { try { return localStorage.getItem(URGENT_KEY) === '1'; } catch { return false; } })();
function sortByUrgency(groups) {
  return groups.map((g, i) => ({ g, i, r: statusRank(AIUI.groupStatus(g)) })).sort((a, b) => a.r - b.r || a.i - b.i).map(x => x.g);
}

/** The group's AI summary (or its instructions chip), between the facts line and the tab list. */
const cardSummary = g => AIUI.groupSumCard(g);

function cardTab(t) {
  const url = t.url || t.pendingUrl || '';
  const sleeping = t.discarded || t.frozen;
  return `<li class="card-tab${t.active ? ' is-active' : ''}${sleeping ? ' is-sleeping' : ''}" data-id="${t.id}">
    ${AIUI.tabStatus(t, { compact: true })}<button class="card-tab-btn" data-act="activate" type="button" title="${esc(titleOf(t))}\n${esc(shortUrl(url))}">${fav(url)}<span class="card-tab-text"><span class="t">${esc(titleOf(t))}</span>${AIUI.tabLine(t)}</span>
    ${t.audible ? `<span class="card-ico" title="Playing audio">${ICON.audio}</span>` : ''}${t.active ? '<span class="live" title="The visible tab in its window"></span>' : ''}</button>
    ${AIUI.tabSumButton(t)}<button class="icon-btn close" data-act="close" type="button" title="Close tab" aria-label="Close ${esc(titleOf(t))}">${ICON.close}</button></li>`;
}

function cardTabList(key, tabs) {
  const all = showAllTabs.has(key);
  const { shown, hidden } = cardTabs(tabs, CARD_TABS, all);
  let h = `<ul class="card-tabs">${shown.map(cardTab).join('')}</ul>`;
  if (hidden) h += `<button class="card-toggle" data-act="card-all" type="button">+ ${plural(hidden, 'more tab')}</button>`;
  else if (all && tabs.length > CARD_TABS + 1) h += `<button class="card-toggle" data-act="card-all" type="button">Show fewer</button>`;
  return h;
}

function groupCard(g) {
  const used = timeAgo(lastUsed(g.tabs));
  const meta = [groupFacts(g.tabs)];
  if (used) meta.push(used === 'now' ? 'used now' : `used ${used} ago`);
  if (g.collapsed) meta.push('collapsed');
  return `<article class="card" data-card="${g.id}" style="--c:${cvar(g.color)}" aria-label="${esc(g.name)}">
    <header class="card-head">
      <button class="card-name" data-act="open" type="button" title="Show ${esc(g.name)} in detail">${esc(g.name)}</button>
      ${model.windowCount > 1 ? `<span class="win-tag">W${g.window}</span>` : ''}
      ${AIUI.cardSumButton()}
      <button class="btn sm" data-act="focus" type="button" title="Expand this group, collapse the others in its window and open its most recent tab">${ICON.go} Switch</button>
      <button class="icon-btn" data-act="card-more" type="button" title="More actions" aria-label="More actions for ${esc(g.name)}">${ICON.more}</button>
    </header>
    <div class="card-meta">${esc(meta.join(' · '))}${AIUI.groupStatusBadge(g)}</div>
    ${cardSummary(g)}
    ${cardTabList(g.id, g.tabs)}
  </article>`;
}

function inboxCard() {
  return `<article class="card inbox" data-card="inbox" aria-label="Inbox">
    <header class="card-head">
      <button class="card-name" data-act="open" type="button" title="Show the Inbox">${ICON.inbox} Inbox</button>
    </header>
    <div class="card-meta">${plural(model.inbox.length, 'tab')} not in any group</div>
    ${cardTabList('inbox', model.inbox)}
  </article>`;
}

function renderDashboard() {
  const urgent = AIUI.aiEnabled() && urgentFirst;
  const g = urgent ? sortByUrgency(model.groups) : model.groups;
  let h = `<div class="pane wide"><div class="pane-head"><div class="pane-title">
      <div class="eyebrow"><span class="bar"></span>All open groups</div>
      <h1>Dashboard</h1>
      <div class="pane-meta">${plural(g.length, 'group')} · ${plural(model.tabCount, 'tab')}${model.windowCount > 1 ? ` · ${plural(model.windowCount, 'window')}` : ''}</div>
    </div>${AIUI.aiEnabled() ? `<div class="actions"><label class="urgent-toggle" title="Groups with tabs that need you come first"><input type="checkbox" data-act="urgent" ${urgent ? 'checked' : ''}> Most urgent first</label></div>` : ''}</div>`;
  if (!g.length && !model.inbox.length) h += `<div class="empty"><strong>No open tabs</strong>Open some tabs and group them to see them here.</div>`;
  else {
    if (!g.length) h += `<div class="notice">No tab groups yet. Select tabs in the Inbox and move them to a new group.</div>`;
    h += `<div class="cards">${g.map(groupCard).join('')}${model.inbox.length ? inboxCard() : ''}</div>`;
  }
  h += `<div class="hint-row"><span>Click a tab to switch to it</span><span>Click a group name for details</span><span><kbd>Alt 0</kbd> dashboard</span><span><kbd>${MOD} K</kbd> jump anywhere</span></div>`;
  return h + '</div>';
}

/* ---------- menus ---------- */
let menuEl = null;
function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
function openMenu(anchor, build) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu';
  m.setAttribute('role', 'menu');
  build(m);
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const w = m.offsetWidth, hgt = m.offsetHeight;
  const left = Math.max(12, Math.min(r.right - w, innerWidth - w - 12));
  let top = r.bottom + 6;
  if (top + hgt > innerHeight - 12) top = Math.max(12, r.top - hgt - 6);
  m.style.left = left + scrollX + 'px';
  m.style.top = top + scrollY + 'px';
  menuEl = m;
  m.querySelector('button')?.focus();
}
function menuItem(m, html, run) {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('role', 'menuitem');
  b.innerHTML = html;
  b.onclick = e => { e.stopPropagation(); closeMenu(); run(); };
  m.append(b);
}
function menuLabel(m, text) { const d = document.createElement('div'); d.className = 'menu-label'; d.textContent = text; m.append(d); }
function colorSwatches(m, g) {
  menuLabel(m, 'Group color');
  const s = document.createElement('div');
  s.className = 'swatches';
  COLORS.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.setProperty('--c', cvar(c));
    b.title = COLOR_NAMES[c];
    b.setAttribute('aria-label', COLOR_NAMES[c]);
    b.setAttribute('aria-pressed', String(c === g.color));
    b.onclick = ev => { ev.stopPropagation(); perform(async () => ({ msg: `Changed “${esc(g.name)}” to ${c}`, undo: await A.setGroupColor(g, c) })); };
    s.append(b);
  });
  m.append(s);
}
/** Actions for one group. `onCard` adds the ones the detail pane shows as buttons. */
function groupMenu(m, g, onCard = false) {
  if (onCard) {
    menuItem(m, `${ICON.pen}<span>Open details</span>`, () => setView({ kind: 'group', id: g.id }));
    menuItem(m, `${ICON.save}<span>Save &amp; close</span>`, () => doSaveClose(g));
    m.append(document.createElement('hr'));
  }
  menuItem(m, '<span>Sort tabs by site</span>', () => perform(async () => ({ msg: 'Sorted tabs by site', undo: await A.sortGroupBySite(g) })));
  menuItem(m, `<span>${g.collapsed ? 'Expand' : 'Collapse'} in tab strip</span>`, () => perform(() => A.setCollapsed(g, !g.collapsed)));
  AIUI.groupMenuItems(g).forEach(it => menuItem(m, it.html, it.run));
  menuItem(m, '<span>Ungroup (move tabs to Inbox)</span>', () => perform(async () => {
    const undo = await A.ungroupGroup(g);
    if (!onCard) view = { kind: 'inbox' };
    return { msg: `Ungrouped “${esc(g.name)}”`, undo };
  }));
  if (onCard) { m.append(document.createElement('hr')); colorSwatches(m, g); }
  m.append(document.createElement('hr'));
  menuItem(m, `<span style="color:var(--danger)">Close group and its ${plural(g.tabs.length, 'tab')}</span>`,
    () => perform(async () => ({ msg: `Closed “${esc(g.name)}” and ${plural(g.tabs.length, 'tab')}`, undo: await A.closeTabs(g.tabs.map(t => t.id)) })));
}
function sourceGroupId(ids) { const x = tabById(ids[0]); return x?.owner ? x.owner.id : 'inbox'; }
function moveMenu(anchor, ids) {
  const from = sourceGroupId(ids);
  openMenu(anchor, m => {
    menuLabel(m, `Move ${plural(ids.length, 'tab')} to`);
    model.groups.filter(g => g.id !== from).forEach(g => menuItem(m,
      `<span class="dot" style="--c:${cvar(g.color)}"></span><span style="flex:1">${esc(g.name)}</span><span style="color:var(--faint)">${g.tabs.length}</span>`,
      () => doMove(ids, g.id)));
    m.append(document.createElement('hr'));
    if (from !== 'inbox') menuItem(m, `${ICON.inbox}<span>Inbox (ungroup)</span>`, () => doMove(ids, 'inbox'));
    menuItem(m, `<span style="width:10px;text-align:center;color:var(--muted)">+</span><span>New group</span>`, () => doMove(ids, { newGroup: '' }));
  });
}

/* ---------- modals ---------- */
function openModal(html, wire) {
  $('#modalBox').className = 'dialog';
  $('#modalBox').innerHTML = html;
  $('#modal').hidden = false;
  wire?.($('#modalBox'));
  $('#modalBox').querySelector('.btn.primary')?.focus();
}
function closeModal() { $('#modal').hidden = true; }

function openDuplicates() {
  const d = findDuplicates(model);
  if (!d.length) return;
  const extra = d.reduce((n, x) => n + x.extras.length, 0);
  const where = (x, keep) => `<span class="where${keep ? ' keep' : ''}">${x.owner ? `<span class="dot" style="--c:${cvar(x.owner.color)}"></span>${esc(x.owner.name)}` : 'Inbox'}${keep ? ' · keep' : ''}</span>`;
  openModal(`<div class="dialog-head"><h2>Close duplicate tabs</h2><p>${plural(extra, 'tab')} show the same page as another tab. Tab Desk keeps the active copy, or the one in a group.</p></div>
    <div class="dialog-body">${d.map(x => `<div class="dup-item"><div class="dup-row">${fav(x.url)}<span class="t">${esc(titleOf(x.keep.t))}</span><span class="badge dup">×${x.items.length}</span></div>
      <div class="dup-where">${x.items.map((it, i) => where(it, i === 0)).join('')}</div></div>`).join('')}</div>
    <div class="dialog-foot"><button class="btn" data-m="cancel" type="button">Cancel</button><button class="btn primary" data-m="ok" type="button">Close ${plural(extra, 'duplicate')}</button></div>`,
  box => {
    box.querySelector('[data-m=cancel]').onclick = closeModal;
    box.querySelector('[data-m=ok]').onclick = () => {
      closeModal();
      const ids = d.flatMap(x => x.extras.map(e => e.t.id));
      perform(async () => ({ msg: `Closed ${plural(ids.length, 'duplicate tab')}`, undo: await A.closeTabs(ids) }));
    };
  });
}

function openByDomain() {
  const ps = domainProposals(model.inbox);
  if (!ps.length) return;
  const used = model.groups.map(g => g.color);
  ps.forEach(p => { p.color = nextColor(used); used.push(p.color); });
  openModal(`<div class="dialog-head"><h2>Group Inbox tabs by site</h2><p>Sites with two or more ungrouped tabs become new groups. Single tabs stay in the Inbox.</p></div>
    <div class="dialog-body">${ps.map((p, i) => `<label class="prop"><input type="checkbox" id="prop-${i}" checked>
      <div><div class="t"><span class="dot" style="--c:${cvar(p.color)}"></span>${esc(p.name)} <span class="badge">${p.tabs.length} tabs</span></div>
      <ul>${p.tabs.map(t => `<li>${esc(titleOf(t))}</li>`).join('')}</ul></div></label>`).join('')}</div>
    <div class="dialog-foot"><button class="btn" data-m="cancel" type="button">Cancel</button><button class="btn primary" data-m="ok" type="button">Create groups</button></div>`,
  box => {
    box.querySelector('[data-m=cancel]').onclick = closeModal;
    box.querySelector('[data-m=ok]').onclick = () => {
      const chosen = ps.filter((p, i) => box.querySelector(`#prop-${i}`).checked);
      closeModal();
      if (!chosen.length) return;
      perform(async () => ({ msg: `Created ${plural(chosen.length, 'group')} from the Inbox`, undo: await A.groupBySite(chosen, model) }));
    };
  });
}

/* ---------- events ---------- */
document.addEventListener('click', e => {
  if (menuEl && !menuEl.contains(e.target)) closeMenu();
  const side = e.target.closest('[data-side], [data-side-tab]');
  if (side) {
    if (side.dataset.sideTab) {
      const x = tabById(+side.dataset.sideTab);
      if (x) perform(() => A.activateTab(x.t));
      return;
    }
    const gid = +side.closest('[data-gid]').dataset.gid;
    expanded.has(gid) ? expanded.delete(gid) : expanded.add(gid);
    saveExpanded();
    renderSide();
    document.querySelector(`[data-gid="${gid}"] .chev`)?.focus();
    return;
  }
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    const k = nav.dataset.nav;
    if (k === 'ws') {
      setView({ kind: 'workspaces' });
      const c = [...document.querySelectorAll('[data-wid]')].find(n => n.dataset.wid === nav.dataset.id);
      if (c) { c.scrollIntoView({ block: 'nearest' }); c.classList.add('flash'); }
    } else setView(k === 'group' ? { kind: 'group', id: +nav.dataset.id } : { kind: k });
    return;
  }
  const act = e.target.closest('[data-act]');
  const row = e.target.closest('.tab, .card-tab');
  if (act) return handleAction(act, row, e);
  if (row?.classList.contains('tab') && !e.target.closest('input,button')) {
    const x = tabById(+row.dataset.id);
    if (x) perform(() => A.activateTab(x.t));
  }
});

function handleAction(act, row, e) {
  const a = act.dataset.act;
  const tid = row ? +row.dataset.id : null;
  const card = act.closest('[data-card]');
  const g = card ? groupById(+card.dataset.card) : view.kind === 'group' ? groupById(view.id) : null;
  const ws = () => workspaces.find(w => w.id === act.closest('[data-wid]').dataset.wid);
  switch (a) {
    case 'select':
      e.stopPropagation();
      act.checked ? selected.add(tid) : selected.delete(tid);
      return renderMain();
    case 'close': return doCloseTabs([tid]);
    case 'move': e.stopPropagation(); return moveMenu(act, [tid]);
    case 'bulk-move': e.stopPropagation(); return moveMenu(act, [...selected]);
    case 'bulk-close': { const ids = [...selected]; selected.clear(); return doCloseTabs(ids); }
    case 'bulk-clear': selected.clear(); return renderMain();
    case 'save-close': return doSaveClose(g);
    case 'focus': return doFocus(g);
    case 'rename': renaming = true; return renderMain();
    case 'color': e.stopPropagation(); return openMenu(act, m => colorSwatches(m, g));
    case 'group-more': e.stopPropagation(); return openMenu(act, m => groupMenu(m, g));
    case 'card-more': e.stopPropagation(); return openMenu(act, m => groupMenu(m, g, true));
    case 'urgent':
      urgentFirst = act.checked;
      try { localStorage.setItem(URGENT_KEY, urgentFirst ? '1' : '0'); } catch {}
      return renderMain();
    case 'card-all': {
      const key = card.dataset.card === 'inbox' ? 'inbox' : +card.dataset.card;
      showAllTabs.has(key) ? showAllTabs.delete(key) : showAllTabs.add(key);
      return renderMain();
    }
    case 'open': return setView(g ? { kind: 'group', id: g.id } : { kind: 'inbox' });
    case 'activate': { const x = tabById(tid); if (x) perform(() => A.activateTab(x.t)); return; }
    case 'by-domain': return openByDomain();
    case 'restore': return doRestore(ws());
    case 'ws-delete': {
      const w = ws();
      return perform(async () => ({ msg: `Deleted workspace “${esc(w.name)}”`, undo: await A.deleteWorkspace(w) }));
    }
    default:
      if (a.startsWith('ai-')) { e.stopPropagation(); AIUI.handleAiAction(a, act, row, g); }
  }
}

document.addEventListener('keydown', e => {
  if (e.target.id === 'renameInput') {
    if (e.key === 'Enter') commitRename();
    if (e.key === 'Escape') { renaming = false; finishRename(); }
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#pal').hidden ? openPalette() : closePalette(); return; }
  if (e.key === 'Escape') {
    if (menuEl) return closeMenu();
    if (!$('#modal').hidden) return closeModal();
  }
  if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    const gEl = e.target.closest?.('#nav [data-gid]');
    const m = gEl && neighborMove(model.groups, +gEl.dataset.gid, e.key === 'ArrowUp' ? -1 : 1);
    if (gEl) e.preventDefault();
    if (m) doMoveGroup(+gEl.dataset.gid, m.targetId, m.place, true);
    return;
  }
  if (e.altKey && !mod && e.code === 'Digit0' && $('#pal').hidden) { e.preventDefault(); setView({ kind: 'dashboard' }); return; }
  if (e.altKey && /^Digit[1-9]$/.test(e.code) && $('#pal').hidden) {
    const g = model.groups[+e.code.slice(5) - 1];
    if (g) { e.preventDefault(); setView({ kind: 'group', id: g.id }); }
  }
});
/* ---------- sidebar drag to reorder groups ---------- */
const DRAG_TYPE = 'application/x-tabdesk-group';
const navEl = $('#nav');
function clearDropMarks() { navEl.querySelectorAll('.drop-before, .drop-after').forEach(n => n.classList.remove('drop-before', 'drop-after')); }
function dropPlace(gEl, e) {
  const r = gEl.querySelector('.nav-row').getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? 'before' : 'after';
}
navEl.addEventListener('dragstart', e => {
  const row = e.target.closest?.('.nav-row');
  if (!row) return;
  const gEl = row.closest('[data-gid]');
  dragging = +gEl.dataset.gid;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(DRAG_TYPE, String(dragging));
  e.dataTransfer.setDragImage(row, 16, row.offsetHeight / 2);
  requestAnimationFrame(() => gEl.classList.add('is-dragging'));
});
navEl.addEventListener('dragover', e => {
  if (dragging == null || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
  const gEl = e.target.closest?.('[data-gid]');
  if (!gEl) return;
  e.preventDefault();
  const place = dropPlace(gEl, e);
  const ok = !!groupMoveTarget(model.groups, dragging, +gEl.dataset.gid, place);
  e.dataTransfer.dropEffect = ok ? 'move' : 'none';
  clearDropMarks();
  if (ok) gEl.classList.add(`drop-${place}`);
});
navEl.addEventListener('dragleave', e => { if (!navEl.contains(e.relatedTarget)) clearDropMarks(); });
navEl.addEventListener('drop', e => {
  const gEl = e.target.closest?.('[data-gid]');
  if (dragging == null || !gEl) return;
  e.preventDefault();
  const id = dragging;
  const place = dropPlace(gEl, e);
  endDrag();
  doMoveGroup(id, +gEl.dataset.gid, place);
});
navEl.addEventListener('dragend', endDrag);
function endDrag() {
  if (dragging == null) return;
  dragging = null;
  clearDropMarks();
  if (deferred) { deferred = false; refresh(); } else renderSide();
}

document.addEventListener('focusout', e => { if (e.target.id === 'renameInput') commitRename(); });

function finishRename() {
  if (deferred) { deferred = false; refresh(); } else renderMain();
}
function commitRename() {
  if (!renaming) return;
  const g = groupById(view.id);
  const v = $('#renameInput').value.trim();
  renaming = false;
  if (g && v !== g.title) {
    const old = g.name;
    if (v) AIUI.onGroupRenamed(old, v);
    perform(async () => ({ msg: `Renamed “${esc(old)}” to “${esc(v || 'Untitled group')}”`, undo: await A.renameGroup(g, v) }));
  } else finishRename();
}

$('#dupBtn').onclick = openDuplicates;
$('#openPalette').onclick = () => openPalette();
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

/* ---------- command palette ---------- */
let pal = { mode: null, items: [], sel: 0 };

function hl(text, q) {
  text = String(text ?? '');
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}

function commands() {
  const cur = view.kind === 'group' ? groupById(view.id) : null;
  const c = [];
  if (cur) {
    c.push({ type: 'cmd', label: `Switch to “${cur.name}”`, sub: 'Expand it, collapse other groups, open its latest tab', ico: ICON.go, run: () => doFocus(cur) });
    c.push({ type: 'cmd', label: `Save & close “${cur.name}”`, sub: 'Park this group in Workspaces', ico: ICON.save, run: () => doSaveClose(cur) });
  }
  const dc = duplicateCount(model);
  if (dc) c.push({ type: 'cmd', label: 'Close duplicate tabs', sub: `${plural(dc, 'extra tab')} open`, ico: ICON.copy, run: openDuplicates });
  const dp = domainProposals(model.inbox).length;
  if (dp) c.push({ type: 'cmd', label: 'Group Inbox tabs by site', sub: `${plural(dp, 'group')} suggested`, ico: ICON.sparkle, run: () => { setView({ kind: 'inbox' }); openByDomain(); } });
  c.push({ type: 'cmd', label: 'Show dashboard', sub: `All ${plural(model.groups.length, 'open group')} on one page`, ico: ICON.grid.replace('class="grid-ico"', ''), run: () => setView({ kind: 'dashboard' }) });
  c.push({ type: 'cmd', label: 'Go to Inbox', sub: plural(model.inbox.length, 'ungrouped tab'), ico: ICON.inbox.replace('class="inbox-ico"', ''), run: () => setView({ kind: 'inbox' }) });
  c.push({ type: 'cmd', label: 'Show workspaces', sub: `${workspaces.length} saved`, ico: ICON.stack, run: () => setView({ kind: 'workspaces' }) });
  c.push(...AIUI.aiCommands(cur));
  c.push({ type: 'cmd', label: cur ? 'Sleep tabs outside this group' : 'Sleep inactive tabs', sub: 'Free memory. Tabs stay open and reload when opened.', ico: ICON.bolt,
    run: () => perform(async () => ({ msg: `Put ${plural(await A.sleepOtherTabs(model, cur?.id), 'tab')} to sleep` })) });
  return c;
}

function buildItems(q) {
  if (pal.mode) {
    const ids = pal.mode.ids;
    const from = sourceGroupId(ids);
    const targets = model.groups.filter(g => g.id !== from).map(g => ({ type: 'target', label: g.name, sub: plural(g.tabs.length, 'tab'), color: g.color, run: () => doMove(ids, g.id) }));
    if (from !== 'inbox') targets.push({ type: 'target', label: 'Inbox (ungroup)', sub: '', ico: ICON.inbox.replace('class="inbox-ico"', ''), run: () => doMove(ids, 'inbox') });
    targets.push({ type: 'target', label: q ? `New group “${q}”` : 'New group', sub: 'Create a group with this tab', ico: '<span style="font-size:16px">+</span>', always: true, run: () => doMove(ids, { newGroup: q }) });
    const r = targets.map(t => ({ ...t, s: t.always ? 0.5 : score(q, t.label) })).filter(t => t.s > 0).sort((a, b) => b.s - a.s);
    return [{ sec: 'Move to' }, ...r];
  }
  if (q.startsWith('>')) {
    const qq = q.slice(1).trim();
    const r = commands().map(c => ({ ...c, s: score(qq, c.label) })).filter(c => c.s > 0).sort((a, b) => b.s - a.s);
    return r.length ? [{ sec: 'Commands' }, ...r] : [];
  }
  const groups = model.groups.map((g, i) => ({
    type: 'group', label: g.name, sub: `${plural(g.tabs.length, 'tab')}${i < 9 ? ` · Alt ${i + 1}` : ''}`, color: g.color,
    run: () => setView({ kind: 'group', id: g.id }), alt: () => doFocus(g), close: () => doSaveClose(g),
  })).map(x => ({ ...x, s: score(q, x.label) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s);

  let tabs = allTabs(model).map(({ t, owner }) => ({
    type: 'tab', label: titleOf(t), sub: shortUrl(t.url || t.pendingUrl), url: t.url || '', owner, last: t.lastAccessed || 0,
    run: () => perform(() => A.activateTab(t)), close: () => doCloseTabs([t.id]), move: () => enterMove([t.id], titleOf(t)),
  })).map(x => ({ ...x, s: Math.max(score(q, x.label), score(q, x.sub) * 0.8, x.owner ? score(q, x.owner.name) * 0.6 : 0) })).filter(x => x.s > 0);
  tabs.sort(q ? (a, b) => b.s - a.s : (a, b) => b.last - a.last);
  tabs = tabs.slice(0, q ? 12 : 6);

  const ws = workspaces.map(w => ({ type: 'ws', label: w.name, sub: `Saved workspace · ${plural(w.tabs.length, 'tab')} · ${savedLabel(w.savedAt)}`, color: w.color, run: () => doRestore(w) }))
    .map(x => ({ ...x, s: score(q, x.label) })).filter(x => x.s > 0);
  const cmds = q ? commands().map(c => ({ ...c, s: score(q, c.label) })).filter(c => c.s > 40) : [];
  const secs = q
    ? [['Tabs', tabs], ['Groups', groups], ['Workspaces · restore', ws], ['Commands', cmds]].sort((a, b) => (b[1][0]?.s || 0) - (a[1][0]?.s || 0))
    : [['Groups', groups], ['Recent tabs', tabs], ['Workspaces · restore', ws]];
  const out = [];
  secs.forEach(([name, list]) => { if (list.length) out.push({ sec: name }, ...list); });
  return out;
}

function renderPalette() {
  const q = $('#palInput').value.trim();
  const items = buildItems(q);
  pal.items = items.filter(x => !x.sec);
  if (pal.sel >= pal.items.length) pal.sel = Math.max(0, pal.items.length - 1);
  const qq = q.startsWith('>') ? q.slice(1).trim() : q;
  let idx = 0, h = '';
  items.forEach(it => {
    if (it.sec) { h += `<div class="pal-sec">${esc(it.sec)}</div>`; return; }
    const i = idx++;
    let lead;
    if (it.type === 'tab') lead = fav(it.url);
    else if (it.color) lead = `<span class="ico"><span class="dot${it.type === 'ws' ? ' hollow' : ''}" style="--c:${cvar(it.color)}"></span></span>`;
    else lead = `<span class="ico">${it.ico || ''}</span>`;
    const right = it.type === 'tab'
      ? (it.owner ? `<span class="grp"><span class="dot" style="--c:${cvar(it.owner.color)}"></span>${esc(it.owner.name)}</span>` : '<span class="grp">Inbox</span>')
      : '';
    h += `<div class="pal-item" role="option" id="pi-${i}" data-i="${i}" aria-selected="${i === pal.sel}">${lead}<div class="main-t"><span class="l">${hl(it.label, qq)}</span>${it.sub ? `<span class="s">${hl(it.sub, qq)}</span>` : ''}</div>${right}</div>`;
  });
  $('#palList').innerHTML = h || `<div class="pal-empty">Nothing matches “${esc(q)}”.<br>Type <kbd>&gt;</kbd> to search commands.</div>`;
  renderFoot();
  document.getElementById('pi-' + pal.sel)?.scrollIntoView({ block: 'nearest' });
  $('#palInput').setAttribute('aria-activedescendant', 'pi-' + pal.sel);
}

function renderFoot() {
  const it = pal.items[pal.sel];
  const k = (key, label) => `<span><kbd>${key}</kbd>${label}</span>`;
  let f = k('↑↓', 'navigate');
  if (pal.mode) f += k('↵', 'move here') + k('Esc', 'back');
  else if (!it) f += k('Esc', 'close');
  else if (it.type === 'tab') f += k('↵', 'switch to tab') + k(`${MOD} ⌫`, 'close tab') + k(`${MOD} M`, 'move to group') + k('Esc', 'close');
  else if (it.type === 'group') f += k('↵', 'show group') + k('Shift ↵', 'switch to group') + k(`${MOD} ⌫`, 'save &amp; close') + k('Esc', 'close');
  else if (it.type === 'ws') f += k('↵', 'restore workspace') + k('Esc', 'close');
  else f += k('↵', 'run') + k('Esc', 'close');
  $('#palFoot').innerHTML = f;
}

function resetPaletteMode() {
  pal.mode = null;
  $('#palMode').hidden = true;
  $('#palInput').value = '';
  $('#palInput').placeholder = PAL_PLACEHOLDER;
}
function openPalette() {
  closeMenu();
  closeModal();
  pal = { mode: null, items: [], sel: 0 };
  resetPaletteMode();
  $('#pal').hidden = false;
  renderPalette();
  $('#palInput').focus();
}
function closePalette() { $('#pal').hidden = true; }
function enterMove(ids, title) {
  pal.mode = { ids };
  pal.sel = 0;
  const m = $('#palMode');
  m.hidden = false;
  m.textContent = `Move “${title.length > 28 ? title.slice(0, 28) + '…' : title}”`;
  $('#palInput').value = '';
  $('#palInput').placeholder = 'Pick a group or type a new group name';
  renderPalette();
}
function runItem(it, which = 'run') { if (!it?.[which]) return; closePalette(); it[which](); }

$('#palInput').addEventListener('input', () => { pal.sel = 0; renderPalette(); });
$('#palInput').addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  const it = pal.items[pal.sel];
  if (e.key === 'ArrowDown') { e.preventDefault(); pal.sel = Math.min(pal.items.length - 1, pal.sel + 1); renderPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pal.sel = Math.max(0, pal.sel - 1); renderPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); runItem(it, e.shiftKey && it?.alt ? 'alt' : 'run'); }
  else if (mod && e.key === 'Backspace') { e.preventDefault(); if (it?.close) runItem(it, 'close'); }
  else if (mod && e.key.toLowerCase() === 'm') { e.preventDefault(); it?.move?.(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (pal.mode) { resetPaletteMode(); renderPalette(); } else closePalette(); }
  else if (e.key === 'Backspace' && pal.mode && !e.target.value) { resetPaletteMode(); renderPalette(); }
});
$('#palList').addEventListener('mousemove', e => {
  const r = e.target.closest('.pal-item');
  if (r && +r.dataset.i !== pal.sel) {
    pal.sel = +r.dataset.i;
    document.querySelectorAll('.pal-item').forEach(n => n.setAttribute('aria-selected', String(+n.dataset.i === pal.sel)));
    renderFoot();
  }
});
$('#palList').addEventListener('click', e => { const r = e.target.closest('.pal-item'); if (r) runItem(pal.items[+r.dataset.i]); });
$('#pal').addEventListener('click', e => { if (e.target.id === 'pal') closePalette(); });

/* ---------- start ---------- */
async function start() {
  $('#kbdHint').textContent = `${MOD} K`;
  selfTab = await chrome.tabs.getCurrent();
  workspaces = await listWorkspaces();
  await AIUI.initAi({ esc, toast, openModal, closeModal, render: () => render(), renderMain: () => renderMain(), tabById, groupById, openMenu, menuItem, menuLabel, allTabs: () => allTabs(model) })
    .catch(e => console.error('AI summaries failed to start', e));
  await refresh();
  // Tab Desk always opens on the dashboard.
  try { localStorage.removeItem('tabdesk.home'); } catch {}
  setView({ kind: 'dashboard' });
  if (location.hash === '#palette') {
    history.replaceState(null, '', location.pathname);
    openPalette();
  }
}
start();

/* ---------- resizable sidebar ---------- */
{
  const KEY = 'tabdesk.sidebarWidth';
  const DEFAULT = 272, MIN = 200, MAX = 560;
  const app = $('.app');
  const handle = $('#sideResizer');
  const clamp = w => Math.round(Math.min(Math.max(w, MIN), Math.min(MAX, window.innerWidth - 360)));
  let preferred = DEFAULT; // what the person chose; the page may be too narrow to show it all
  const setWidth = (w, save = false, user = true) => {
    if (user) preferred = Math.min(Math.max(w, MIN), MAX);
    const v = clamp(preferred);
    app.style.setProperty('--side-w', `${v}px`);
    handle.setAttribute('aria-valuenow', v);
    if (save) { try { preferred === DEFAULT ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, Math.round(preferred)); } catch {} }
    return v;
  };
  handle.setAttribute('aria-valuemin', MIN);
  handle.setAttribute('aria-valuemax', MAX);
  let stored = DEFAULT;
  try { stored = +localStorage.getItem(KEY) || DEFAULT; } catch {}
  setWidth(stored);

  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const left = app.getBoundingClientRect().left;
    handle.classList.add('is-active');
    document.body.classList.add('is-resizing');
    const move = ev => setWidth(ev.clientX - left);
    const up = ev => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.classList.remove('is-active');
      document.body.classList.remove('is-resizing');
      setWidth(ev.clientX - left, true);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => setWidth(DEFAULT, true));
  handle.addEventListener('keydown', e => {
    const cur = clamp(preferred);
    const step = e.shiftKey ? 64 : 16;
    const next = { ArrowLeft: cur - step, ArrowRight: cur + step, Home: MIN, End: MAX }[e.key];
    if (next == null) return;
    e.preventDefault();
    setWidth(next, true);
  });
  window.addEventListener('resize', () => setWidth(preferred, false, false));
}
