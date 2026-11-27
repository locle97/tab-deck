import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupsToCollapse, normalizeTabStrip, DEFAULT_TAB_STRIP } from '../src/lib/tab-strip.js';

const groups = [
  { id: 1, windowId: 10, collapsed: false },
  { id: 2, windowId: 10, collapsed: false },
  { id: 3, windowId: 10, collapsed: true },
  { id: 4, windowId: 20, collapsed: false },
];

test('collapses the other expanded groups in the same window only', () => {
  assert.deepEqual(groupsToCollapse(groups, 1, 10), [2]);
  assert.deepEqual(groupsToCollapse(groups, 4, 20), []);
});

test('does nothing for an ungrouped tab', () => {
  assert.deepEqual(groupsToCollapse(groups, -1, 10), []);
  assert.deepEqual(groupsToCollapse(groups, undefined, 10), []);
});

test('normalizes stored settings, off by default', () => {
  assert.equal(DEFAULT_TAB_STRIP.collapseOthers, false);
  assert.deepEqual(normalizeTabStrip(null), { collapseOthers: false });
  assert.deepEqual(normalizeTabStrip({ collapseOthers: true, junk: 1 }), { collapseOthers: true });
  assert.deepEqual(normalizeTabStrip({ collapseOthers: 'yes' }), { collapseOthers: false });
});
