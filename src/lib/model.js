// Pure helpers for Tab Desk. Nothing in this file touches the chrome.* APIs,
// so it can be unit-tested with plain Node.

export const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

export const COLOR_NAMES = {
  grey: 'Grey', blue: 'Blue', red: 'Red', yellow: 'Yellow', green: 'Green',
  pink: 'Pink', purple: 'Purple', cyan: 'Cyan', orange: 'Orange',
};

export const UNTITLED = 'Untitled group';

/** Hostname of a URL, or '' when it cannot be parsed. */
export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** URL without scheme and leading "www." for display. */
export function shortUrl(url) {
  return String(url || '').replace(/^[a-z-]+:\/\//i, '').replace(/^www\./, '');
}

/** Host without "www." for display and grouping names. */
export function siteName(url) {
  return hostOf(url).replace(/^www\./, '');
}

export function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Compact "time since" label: now, 5m, 3h, 2d, 3w. */
export function timeAgo(ms, now = Date.now()) {
  if (!ms) return '';
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (86400 * 7))}w`;
}

/** First color not used by an existing group, or a rotating fallback. */
export function nextColor(usedColors) {
  const used = new Set(usedColors);
  return COLORS.find(c => !used.has(c)) || COLORS[usedColors.length % COLORS.length];
}

/**
 * Turn raw chrome.tabs / chrome.tabGroups results into the shape the UI renders.
 * @param {chrome.tabs.Tab[]} tabs
 * @param {chrome.tabGroups.TabGroup[]} groups
 * @param {(tab) => boolean} isHidden tabs to leave out (the dashboard itself)
 */
export function buildModel(tabs, groups, isHidden = () => false) {
  const visible = tabs.filter(t => !isHidden(t));
  const windowOrder = [...new Set(visible.map(t => t.windowId))].sort((a, b) => a - b);
  const winNumber = id => windowOrder.indexOf(id) + 1;
  const byGroup = new Map();
  const inbox = [];
  const sorted = [...visible].sort((a, b) => winNumber(a.windowId) - winNumber(b.windowId) || a.index - b.index);
  for (const t of sorted) {
    if (t.groupId == null || t.groupId === -1) inbox.push(t);
    else {
      if (!byGroup.has(t.groupId)) byGroup.set(t.groupId, []);
      byGroup.get(t.groupId).push(t);
    }
  }
  const groupInfo = new Map(groups.map(g => [g.id, g]));
  const outGroups = [...byGroup.entries()].map(([id, gtabs]) => {
    const g = groupInfo.get(id) || {};
    return {
      id,
      title: g.title || '',
      name: g.title || UNTITLED,
      color: COLORS.includes(g.color) ? g.color : 'grey',
      collapsed: !!g.collapsed,
      windowId: gtabs[0].windowId,
      window: winNumber(gtabs[0].windowId),
      tabs: gtabs,
    };
  });
  return { groups: outGroups, inbox, windowCount: windowOrder.length, tabCount: visible.length };
}

/** All tabs with the group they belong to (null for Inbox). */
export function allTabs(model) {
  const out = [];
  model.groups.forEach(g => g.tabs.forEach(t => out.push({ t, owner: g })));
  model.inbox.forEach(t => out.push({ t, owner: null }));
  return out;
}

/**
 * Pages open in more than one tab. For each, pick one tab to keep:
 * the active one, else one in a group, else the most recently used.
 * @returns {{url: string, keep: object, extras: object[], items: object[]}[]}
 */
export function findDuplicates(model) {
  const byUrl = new Map();
  for (const item of allTabs(model)) {
    const url = item.t.url;
    if (!url) continue;
    if (!byUrl.has(url)) byUrl.set(url, []);
    byUrl.get(url).push(item);
  }
  const rank = it => (it.t.active ? 4 : 0) + (it.owner ? 2 : 0);
  return [...byUrl.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([url, items]) => {
      const ordered = [...items].sort((a, b) => rank(b) - rank(a) || (b.t.lastAccessed || 0) - (a.t.lastAccessed || 0));
      return { url, keep: ordered[0], extras: ordered.slice(1), items: ordered };
    });
}

export function duplicateCount(model) {
  return findDuplicates(model).reduce((n, d) => n + d.extras.length, 0);
}

const KNOWN_SITES = {
  'news.ycombinator.com': 'Hacker News',
  'developer.chrome.com': 'Chrome for Developers',
  'developer.mozilla.org': 'MDN',
  'github.com': 'GitHub',
  'youtube.com': 'YouTube',
  'docs.google.com': 'Google Docs',
  'mail.google.com': 'Gmail',
  'stackoverflow.com': 'Stack Overflow',
  'reddit.com': 'Reddit',
};

/** Suggested new groups: Inbox tabs that share a site (two or more per window). */
export function domainProposals(inbox) {
  const buckets = new Map();
  for (const t of inbox) {
    const site = siteName(t.url);
    if (!site) continue;
    const key = `${t.windowId}|${site}`;
    if (!buckets.has(key)) buckets.set(key, { site, windowId: t.windowId, tabs: [] });
    buckets.get(key).tabs.push(t);
  }
  return [...buckets.values()]
    .filter(b => b.tabs.length > 1)
    .map(b => ({ ...b, name: KNOWN_SITES[b.site] || b.site }));
}

/** Tab ids of a group in site order, used for "Sort tabs by site". */
export function sortedBySite(tabs) {
  return [...tabs]
    .sort((a, b) => siteName(a.url).localeCompare(siteName(b.url)) || a.index - b.index)
    .map(t => t.id);
}

/**
 * Fuzzy match score. 0 means no match. Substring matches beat scattered
 * letters, and matches at the start beat matches later on.
 */
export function score(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const s = String(text || '').toLowerCase();
  const i = s.indexOf(q);
  if (i >= 0) return 200 - Math.min(i, 100) + (i === 0 ? 60 : 0);
  let qi = 0, sc = 0, last = -2;
  for (let k = 0; k < s.length && qi < q.length; k++) {
    if (s[k] === q[qi]) {
      sc += k === last + 1 ? 4 : 1;
      last = k;
      qi++;
    }
  }
  return qi === q.length ? sc : 0;
}

/** What to keep when saving a group as a workspace. */
export function toWorkspace(group, now = Date.now()) {
  return {
    id: `w${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: group.title || UNTITLED,
    color: group.color,
    savedAt: now,
    tabs: group.tabs.filter(t => t.url).map(t => ({ url: t.url, title: t.title || t.url, pinned: !!t.pinned })),
  };
}

/** "Nov 12" style date for saved workspaces. */
export function savedLabel(ms, now = Date.now()) {
  if (now - ms < 60_000) return 'just now';
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Where to send a group so it lands next to another group in the tab strip.
 * Returns {windowId, index} for chrome.tabGroups.move, where `index` is the
 * position of the group's first tab after the move, or null when the group
 * would not move. `place` is 'before' or 'after' the target group.
 */
export function groupMoveTarget(groups, groupId, targetId, place) {
  const src = groups.find(g => g.id === groupId);
  const dst = groups.find(g => g.id === targetId);
  if (!src || !dst || src.id === dst.id || !src.tabs.length || !dst.tabs.length) return null;
  const first = g => g.tabs[0].index;
  const last = g => g.tabs[g.tabs.length - 1].index;
  const sameWindow = src.windowId === dst.windowId;
  // Within one window the group's own tabs leave the strip first, so
  // everything after them shifts left by the group's size.
  const shift = sameWindow && first(src) < first(dst) ? src.tabs.length : 0;
  const index = (place === 'after' ? last(dst) + 1 : first(dst)) - shift;
  if (sameWindow && index === first(src)) return null;
  return { windowId: dst.windowId, index };
}

/**
 * Where to send a tab with chrome.tabs.move so it lands right before or after
 * `anchorIndex` in the same window. The tab leaves the strip first, so when it
 * starts left of the anchor everything after it shifts left by one.
 */
export function tabMoveIndex(fromIndex, anchorIndex, place) {
  const shift = fromIndex < anchorIndex ? 1 : 0;
  return (place === 'after' ? anchorIndex + 1 : anchorIndex) - shift;
}

/** The group next to `groupId` in sidebar order, for keyboard reordering. */
export function neighborMove(groups, groupId, dir) {
  const i = groups.findIndex(g => g.id === groupId);
  const n = groups[i + dir];
  if (i < 0 || !n) return null;
  return { targetId: n.id, place: dir < 0 ? 'before' : 'after' };
}

/** Tabs shown on a dashboard card: the first `limit`, or all when the card is opened up. */
export function cardTabs(tabs, limit, showAll = false) {
  if (showAll || tabs.length <= limit + 1) return { shown: tabs, hidden: 0 };
  return { shown: tabs.slice(0, limit), hidden: tabs.length - limit };
}

/** One-line facts about a group for its dashboard card: "4 tabs · 2 sites · 1 sleeping". */
export function groupFacts(tabs) {
  const sites = new Set(tabs.map(t => siteName(t.url || t.pendingUrl || '')).filter(Boolean)).size;
  const sleeping = tabs.filter(t => t.discarded || t.frozen).length;
  const playing = tabs.filter(t => t.audible).length;
  const parts = [plural(tabs.length, 'tab')];
  if (sites) parts.push(plural(sites, 'site'));
  if (sleeping) parts.push(`${sleeping} sleeping`);
  if (playing) parts.push(`${playing} playing`);
  return parts.join(' · ');
}

/** When a group was last used: the most recent lastAccessed of its tabs (0 if unknown). */
export function lastUsed(tabs) {
  return tabs.reduce((m, t) => Math.max(m, t.lastAccessed || 0), 0);
}

/* ---------- dashboard ordering and grouping ----------
   These take a status *function*, so they don't care how a status is worked out. */

/**
 * Order dashboard cards. 'urgent': by `rankOf` (lowest first), then tab strip order.
 * 'recent': most recently used first. 'manual' (or anything else): tab strip order.
 */
export function sortGroups(groups, mode, rankOf = () => 0) {
  const list = groups.map((g, i) => ({ g, i }));
  if (mode === 'urgent') list.sort((a, b) => rankOf(a.g) - rankOf(b.g) || a.i - b.i);
  else if (mode === 'recent') list.sort((a, b) => lastUsed(b.g.tabs) - lastUsed(a.g.tabs) || a.i - b.i);
  return list.map(x => x.g);
}

/** Tabs in urgency order (stable): the ones a collapsed card shows first. */
export function sortTabsBy(tabs, rankOf) {
  return tabs.map((t, i) => ({ t, i })).sort((a, b) => rankOf(a.t) - rankOf(b.t) || a.i - b.i).map(x => x.t);
}
