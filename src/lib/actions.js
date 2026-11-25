// Every change Tab Desk makes to real tabs goes through this file.
// Actions that can be reversed return an async `undo` function.

import { nextColor, sortedBySite, toWorkspace } from './model.js';
import { addWorkspace, removeWorkspace } from './workspaces.js';

const exists = p => p.then(() => true, () => false);

/** Bring a tab to the front, focusing its window. */
export async function activateTab(tab) {
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

/**
 * Switch context to a group: expand it, collapse the other groups in the
 * same window and bring its most recently used tab to the front.
 */
export async function focusGroup(group, model) {
  await chrome.tabGroups.update(group.id, { collapsed: false });
  for (const g of model.groups) {
    if (g.id !== group.id && g.windowId === group.windowId && !g.collapsed) {
      await chrome.tabGroups.update(g.id, { collapsed: true }).catch(() => {});
    }
  }
  const recent = [...group.tabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  if (recent) await activateTab(recent);
}

/** Record what is needed to reopen tabs later. */
async function describe(tabIds) {
  const tabs = (await Promise.all(tabIds.map(id => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
  const groupIds = [...new Set(tabs.map(t => t.groupId).filter(id => id !== -1))];
  const groups = new Map();
  for (const id of groupIds) {
    const g = await chrome.tabGroups.get(id).catch(() => null);
    if (g) groups.set(id, g);
  }
  return tabs.map(t => ({
    url: t.url || t.pendingUrl,
    windowId: t.windowId,
    index: t.index,
    pinned: t.pinned,
    groupId: t.groupId,
    groupTitle: groups.get(t.groupId)?.title || '',
    groupColor: groups.get(t.groupId)?.color || 'grey',
  }));
}

/** Reopen tabs from `describe` output, back into their groups where possible. */
export async function reopen(snaps, { windowId: fallbackWindow } = {}) {
  const created = [];
  const replacementGroups = new Map();
  for (const s of [...snaps].sort((a, b) => a.index - b.index)) {
    const windowOk = s.windowId != null && await exists(chrome.windows.get(s.windowId));
    let t;
    try {
      t = await chrome.tabs.create({
        url: s.url,
        windowId: windowOk ? s.windowId : fallbackWindow,
        index: windowOk ? s.index : undefined,
        active: false,
        pinned: !!s.pinned,
      });
    } catch {
      continue; // Some URLs (e.g. chrome://settings subpages) can't be reopened.
    }
    created.push(t.id);
    if (s.groupId == null || s.groupId === -1) continue;
    const live = await exists(chrome.tabGroups.get(s.groupId));
    const target = live ? s.groupId : replacementGroups.get(s.groupId);
    if (target != null) {
      await chrome.tabs.group({ tabIds: [t.id], groupId: target });
    } else {
      const gid = await chrome.tabs.group({ tabIds: [t.id], createProperties: { windowId: t.windowId } });
      await chrome.tabGroups.update(gid, { title: s.groupTitle, color: s.groupColor });
      replacementGroups.set(s.groupId, gid);
    }
  }
  return created;
}

export async function closeTabs(tabIds) {
  const snaps = await describe(tabIds);
  await chrome.tabs.remove(tabIds);
  return async () => { await reopen(snaps); };
}

/**
 * Move tabs into a group.
 * @param target a group id, 'inbox' to ungroup, or {newGroup: title}
 * @returns {{undo, groupId}}
 */
export async function moveTabs(tabIds, target, model) {
  const before = (await Promise.all(tabIds.map(id => chrome.tabs.get(id).catch(() => null)))).filter(Boolean);
  let groupId = null;
  if (target === 'inbox') {
    await chrome.tabs.ungroup(tabIds);
  } else if (typeof target === 'object') {
    groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId: before[0].windowId } });
    await chrome.tabGroups.update(groupId, {
      title: target.newGroup || '',
      color: nextColor(model.groups.map(g => g.color)),
    });
  } else {
    groupId = target;
    await chrome.tabs.group({ tabIds, groupId });
  }
  const undo = async () => {
    for (const t of before) {
      if (!await exists(chrome.tabs.get(t.id))) continue;
      if (t.groupId === -1) await chrome.tabs.ungroup([t.id]);
      else if (await exists(chrome.tabGroups.get(t.groupId))) await chrome.tabs.group({ tabIds: [t.id], groupId: t.groupId });
    }
  };
  return { undo, groupId };
}

export async function renameGroup(group, title) {
  const old = group.title;
  await chrome.tabGroups.update(group.id, { title });
  return async () => { await chrome.tabGroups.update(group.id, { title: old }); };
}

export async function setGroupColor(group, color) {
  const old = group.color;
  await chrome.tabGroups.update(group.id, { color });
  return async () => { await chrome.tabGroups.update(group.id, { color: old }); };
}

/**
 * Move a whole group in the tab strip, possibly to another window.
 * `to` comes from model.groupMoveTarget.
 */
export async function moveGroup(group, to) {
  const from = { windowId: group.windowId, index: group.tabs[0].index };
  await chrome.tabGroups.move(group.id, to);
  return async () => { await chrome.tabGroups.move(group.id, from); };
}

export async function setCollapsed(group, collapsed) {
  await chrome.tabGroups.update(group.id, { collapsed });
}

/** Reorder a group's tabs so tabs from the same site sit together. */
export async function sortGroupBySite(group) {
  const original = group.tabs.map(t => t.id);
  const base = Math.min(...group.tabs.map(t => t.index));
  const apply = async ids => {
    for (let i = 0; i < ids.length; i++) await chrome.tabs.move(ids[i], { index: base + i });
  };
  await apply(sortedBySite(group.tabs));
  return async () => { await apply(original); };
}

export async function ungroupGroup(group) {
  const ids = group.tabs.map(t => t.id);
  const { title, color, windowId } = group;
  await chrome.tabs.ungroup(ids);
  return async () => {
    const live = (await Promise.all(ids.map(id => chrome.tabs.get(id).catch(() => null)))).filter(Boolean).map(t => t.id);
    if (!live.length) return;
    const gid = await chrome.tabs.group({ tabIds: live, createProperties: { windowId } });
    await chrome.tabGroups.update(gid, { title, color });
  };
}

/** Save a group as a workspace, then close its tabs. */
export async function saveAndCloseGroup(group) {
  const ws = toWorkspace(group);
  await addWorkspace(ws);
  const undoClose = await closeTabs(group.tabs.map(t => t.id));
  return { ws, undo: async () => { await undoClose(); await removeWorkspace(ws.id); } };
}

/** Reopen a saved workspace as a new group in `windowId`, then forget it. */
export async function restoreWorkspace(ws, windowId) {
  const ids = [];
  for (const t of ws.tabs) {
    try {
      const tab = await chrome.tabs.create({ url: t.url, windowId, active: false });
      ids.push(tab.id);
    } catch { /* skip URLs Chrome refuses to open */ }
  }
  if (!ids.length) throw new Error('None of the saved tabs could be opened.');
  const groupId = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, { title: ws.name, color: ws.color, collapsed: false });
  await removeWorkspace(ws.id);
  return {
    groupId,
    count: ids.length,
    undo: async () => {
      await addWorkspace(ws);
      await chrome.tabs.remove(ids).catch(() => {});
    },
  };
}

export async function deleteWorkspace(ws) {
  await removeWorkspace(ws.id);
  return async () => { await addWorkspace(ws); };
}

/** Create one group per proposal from `domainProposals`. */
export async function groupBySite(proposals, model) {
  const used = model.groups.map(g => g.color);
  const created = [];
  for (const p of proposals) {
    const color = p.color || nextColor(used);
    used.push(color);
    const gid = await chrome.tabs.group({ tabIds: p.tabs.map(t => t.id), createProperties: { windowId: p.windowId } });
    await chrome.tabGroups.update(gid, { title: p.name, color });
    created.push(p.tabs.map(t => t.id));
  }
  return async () => {
    for (const ids of created) await chrome.tabs.ungroup(ids).catch(() => {});
  };
}

/** Unload tabs outside `keepGroupId` to free memory. They stay open. */
export async function sleepOtherTabs(model, keepGroupId) {
  let n = 0;
  const all = [...model.groups.filter(g => g.id !== keepGroupId).flatMap(g => g.tabs), ...model.inbox];
  for (const t of all) {
    if (t.active || t.audible || t.discarded || t.pinned) continue;
    if (await chrome.tabs.discard(t.id).then(() => true, () => false)) n++;
  }
  return n;
}
