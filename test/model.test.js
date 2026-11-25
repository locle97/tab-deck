import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModel, findDuplicates, duplicateCount, domainProposals, sortedBySite,
  score, timeAgo, nextColor, shortUrl, siteName, toWorkspace, UNTITLED,
  groupMoveTarget, neighborMove, cardTabs, groupFacts, lastUsed,
} from '../src/lib/model.js';

const tab = (id, url, o = {}) => ({ id, url, title: `Tab ${id}`, windowId: 1, index: id, groupId: -1, active: false, ...o });

test('buildModel splits grouped tabs from the Inbox and keeps tab order', () => {
  const tabs = [
    tab(3, 'https://b.com', { groupId: 10, index: 3 }),
    tab(1, 'https://a.com', { groupId: 10, index: 1 }),
    tab(2, 'https://c.com', { index: 2 }),
    tab(4, 'chrome-extension://x/dashboard.html', { index: 4 }),
  ];
  const groups = [{ id: 10, title: 'Work', color: 'blue', collapsed: false, windowId: 1 }];
  const m = buildModel(tabs, groups, t => t.id === 4);
  assert.equal(m.groups.length, 1);
  assert.deepEqual(m.groups[0].tabs.map(t => t.id), [1, 3]);
  assert.equal(m.groups[0].name, 'Work');
  assert.deepEqual(m.inbox.map(t => t.id), [2]);
  assert.equal(m.tabCount, 3);
});

test('buildModel names untitled groups and numbers windows', () => {
  const tabs = [tab(1, 'https://a.com', { groupId: 5, windowId: 9 }), tab(2, 'https://b.com', { windowId: 3 })];
  const m = buildModel(tabs, [{ id: 5, title: '', color: 'red' }]);
  assert.equal(m.groups[0].name, UNTITLED);
  assert.equal(m.groups[0].window, 2);
  assert.equal(m.windowCount, 2);
});

test('findDuplicates keeps the grouped copy and lists the extras', () => {
  const tabs = [
    tab(1, 'https://x.com/pr/1'),
    tab(2, 'https://x.com/pr/1', { groupId: 7 }),
    tab(3, 'https://x.com/pr/1', { lastAccessed: 99 }),
    tab(4, 'https://y.com'),
  ];
  const m = buildModel(tabs, [{ id: 7, title: 'G', color: 'blue' }]);
  const d = findDuplicates(m);
  assert.equal(d.length, 1);
  assert.equal(d[0].keep.t.id, 2);
  assert.deepEqual(d[0].extras.map(x => x.t.id), [3, 1]);
  assert.equal(duplicateCount(m), 2);
});

test('findDuplicates prefers the active tab over a grouped one', () => {
  const tabs = [tab(1, 'https://x.com', { active: true }), tab(2, 'https://x.com', { groupId: 7 })];
  const d = findDuplicates(buildModel(tabs, [{ id: 7, color: 'blue' }]));
  assert.equal(d[0].keep.t.id, 1);
});

test('domainProposals suggests sites with two or more tabs per window', () => {
  const inbox = [
    tab(1, 'https://news.ycombinator.com'),
    tab(2, 'https://news.ycombinator.com/item?id=1'),
    tab(3, 'https://github.com/a'),
    tab(4, 'https://www.github.com/b', { windowId: 2 }),
  ];
  const p = domainProposals(inbox);
  assert.equal(p.length, 1);
  assert.equal(p[0].name, 'Hacker News');
  assert.deepEqual(p[0].tabs.map(t => t.id), [1, 2]);
});

test('sortedBySite orders by host, then original position', () => {
  const ids = sortedBySite([tab(1, 'https://z.com'), tab(2, 'https://a.com/2'), tab(3, 'https://a.com/1')]);
  assert.deepEqual(ids, [2, 3, 1]);
});

test('score ranks substring and prefix matches above scattered letters', () => {
  assert.equal(score('', 'anything'), 1);
  assert.equal(score('xyz', 'checkout'), 0);
  assert.ok(score('check', 'Checkout redesign') > score('check', 'Recheck'));
  assert.ok(score('crd', 'Checkout redesign') > 0);
  assert.ok(score('check', 'Recheck') > score('crd', 'Checkout redesign'));
});

test('timeAgo gives compact labels', () => {
  const now = 1_000_000_000;
  assert.equal(timeAgo(now - 10_000, now), 'now');
  assert.equal(timeAgo(now - 5 * 60_000, now), '5m');
  assert.equal(timeAgo(now - 3 * 3600_000, now), '3h');
  assert.equal(timeAgo(now - 2 * 86400_000, now), '2d');
  assert.equal(timeAgo(undefined, now), '');
});

test('nextColor picks an unused color', () => {
  assert.equal(nextColor([]), 'grey');
  assert.equal(nextColor(['grey', 'blue']), 'red');
});

test('url helpers strip scheme and www', () => {
  assert.equal(shortUrl('https://www.example.com/a?b'), 'example.com/a?b');
  assert.equal(siteName('https://www.example.com/a'), 'example.com');
  assert.equal(siteName('not a url'), '');
});

test('toWorkspace keeps name, color and tab URLs', () => {
  const w = toWorkspace({ title: 'Trip', color: 'cyan', tabs: [tab(1, 'https://a.com'), tab(2, '')] }, 5);
  assert.equal(w.name, 'Trip');
  assert.equal(w.color, 'cyan');
  assert.equal(w.savedAt, 5);
  assert.deepEqual(w.tabs.map(t => t.url), ['https://a.com']);
});

// Window 1: [0 inbox] [1,2 = A] [3 inbox] [4 = B] [5,6,7 = C]; window 2: [0,1 = D]
const strip = () => buildModel([
  tab(1, 'https://x.com/0', { index: 0 }),
  tab(2, 'https://x.com/1', { index: 1, groupId: 10 }),
  tab(3, 'https://x.com/2', { index: 2, groupId: 10 }),
  tab(4, 'https://x.com/3', { index: 3 }),
  tab(5, 'https://x.com/4', { index: 4, groupId: 20 }),
  tab(6, 'https://x.com/5', { index: 5, groupId: 30 }),
  tab(7, 'https://x.com/6', { index: 6, groupId: 30 }),
  tab(8, 'https://x.com/7', { index: 7, groupId: 30 }),
  tab(9, 'https://y.com/0', { index: 0, groupId: 40, windowId: 2 }),
  tab(10, 'https://y.com/1', { index: 1, groupId: 40, windowId: 2 }),
], [10, 20, 30, 40].map(id => ({ id, title: `G${id}`, color: 'blue' }))).groups;

test('groupMoveTarget moves a group left in its window', () => {
  assert.deepEqual(groupMoveTarget(strip(), 30, 10, 'before'), { windowId: 1, index: 1 });
  assert.deepEqual(groupMoveTarget(strip(), 30, 20, 'before'), { windowId: 1, index: 4 });
});

test('groupMoveTarget accounts for the group leaving when moving right', () => {
  // A (2 tabs) after C: C ends at 7, so A's first tab ends up at 8 - 2 = 6.
  assert.deepEqual(groupMoveTarget(strip(), 10, 30, 'after'), { windowId: 1, index: 6 });
  assert.deepEqual(groupMoveTarget(strip(), 10, 20, 'after'), { windowId: 1, index: 3 });
  assert.deepEqual(groupMoveTarget(strip(), 10, 30, 'before'), { windowId: 1, index: 3 });
});

test('groupMoveTarget returns null when nothing would change', () => {
  assert.equal(groupMoveTarget(strip(), 10, 10, 'before'), null);
  assert.equal(groupMoveTarget(strip(), 20, 30, 'before'), null);
  assert.equal(groupMoveTarget(strip(), 30, 20, 'after'), null);
  assert.equal(groupMoveTarget(strip(), 99, 10, 'before'), null);
});

test('groupMoveTarget moves a group to another window', () => {
  assert.deepEqual(groupMoveTarget(strip(), 10, 40, 'after'), { windowId: 2, index: 2 });
  assert.deepEqual(groupMoveTarget(strip(), 40, 10, 'before'), { windowId: 1, index: 1 });
});

test('neighborMove finds the group above or below', () => {
  assert.deepEqual(neighborMove(strip(), 20, -1), { targetId: 10, place: 'before' });
  assert.deepEqual(neighborMove(strip(), 20, 1), { targetId: 30, place: 'after' });
  assert.equal(neighborMove(strip(), 10, -1), null);
  assert.equal(neighborMove(strip(), 40, 1), null);
});

test('cardTabs shows the first tabs and counts the rest, but never hides just one', () => {
  const ts = [1, 2, 3, 4, 5, 6].map(i => tab(i, `https://x${i}.com`));
  assert.deepEqual(cardTabs(ts, 4), { shown: ts.slice(0, 4), hidden: 2 });
  assert.deepEqual(cardTabs(ts, 5), { shown: ts, hidden: 0 });
  assert.deepEqual(cardTabs(ts, 4, true), { shown: ts, hidden: 0 });
  assert.deepEqual(cardTabs([], 4), { shown: [], hidden: 0 });
});

test('groupFacts counts tabs, distinct sites, sleeping and playing tabs', () => {
  const ts = [
    tab(1, 'https://www.a.com/1'), tab(2, 'https://a.com/2', { discarded: true }),
    tab(3, 'https://b.com', { audible: true }), tab(4, 'chrome://newtab'),
  ];
  assert.equal(groupFacts(ts), '4 tabs · 3 sites · 1 sleeping · 1 playing');
  assert.equal(groupFacts([tab(1, 'https://a.com')]), '1 tab · 1 site');
});

test('lastUsed is the most recent tab access in a group', () => {
  assert.equal(lastUsed([tab(1, 'a', { lastAccessed: 5 }), tab(2, 'b', { lastAccessed: 9 }), tab(3, 'c')]), 9);
  assert.equal(lastUsed([]), 0);
});

/* ---------- dashboard ordering and grouping ---------- */
import { sortGroups, sortTabsBy, statusSegments } from '../src/lib/model.js';

const dg = (id, st, last) => ({ id, st, tabs: [{ lastAccessed: last }] });
const dgs = [dg(1, 'done', 30), dg(2, 'action', 10), dg(3, null, 50), dg(4, 'action', 20)];
const rank = s => ({ action: 0, working: 1, waiting: 2, done: 3, info: 4 }[s] ?? 2.5);

test('sortGroups: urgent by rank then strip order, recent by last use, manual keeps order', () => {
  assert.deepEqual(sortGroups(dgs, 'urgent', g => rank(g.st)).map(g => g.id), [2, 4, 3, 1]);
  assert.deepEqual(sortGroups(dgs, 'recent').map(g => g.id), [3, 1, 4, 2]);
  assert.deepEqual(sortGroups(dgs, 'manual').map(g => g.id), [1, 2, 3, 4]);
  assert.notEqual(sortGroups(dgs, 'manual'), dgs, 'returns a new array');
});

test('sortTabsBy is stable', () => {
  const tabs = [{ id: 1, s: 'done' }, { id: 2, s: 'action' }, { id: 3, s: 'done' }, { id: 4, s: 'action' }];
  assert.deepEqual(sortTabsBy(tabs, t => rank(t.s)).map(t => t.id), [2, 4, 1, 3]);
});

test('statusSegments', () => {
  const tabs = [{ s: 'done' }, { s: null }, { s: 'action' }, { s: 'done' }];
  assert.deepEqual(statusSegments(tabs, t => t.s, ['action', 'working', 'waiting', 'done', 'info']),
    [{ status: 'action', n: 1 }, { status: 'done', n: 2 }, { status: 'none', n: 1 }]);
});
