// Tab strip preferences: how Tab Desk tidies Chrome's own tab strip as you work.
// Stored apart from the AI settings so the background worker can read them cheaply.

export const TAB_STRIP_KEY = 'tabStripSettings';

export const DEFAULT_TAB_STRIP = Object.freeze({
  collapseOthers: false, // when you switch to a grouped tab, collapse the other groups in that window
});

export function normalizeTabStrip(s) {
  const src = s && typeof s === 'object' ? s : {};
  return { collapseOthers: typeof src.collapseOthers === 'boolean' ? src.collapseOthers : DEFAULT_TAB_STRIP.collapseOthers };
}

/**
 * Ids of the groups to collapse when the tab in `activeGroupId` becomes active: every other
 * expanded group in the same window. Nothing when the active tab isn't in a group.
 * @param {{id:number, windowId:number, collapsed:boolean}[]} groups
 */
export function groupsToCollapse(groups, activeGroupId, windowId) {
  if (activeGroupId == null || activeGroupId === -1) return [];
  return groups.filter(g => g.id !== activeGroupId && g.windowId === windowId && !g.collapsed).map(g => g.id);
}

export async function getTabStrip() {
  const r = await chrome.storage.local.get(TAB_STRIP_KEY);
  return normalizeTabStrip(r[TAB_STRIP_KEY]);
}

export async function saveTabStrip(patch) {
  const next = normalizeTabStrip({ ...(await getTabStrip()), ...patch });
  await chrome.storage.local.set({ [TAB_STRIP_KEY]: next });
  return next;
}
