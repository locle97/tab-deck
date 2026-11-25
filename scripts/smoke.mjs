// End-to-end smoke test: loads the unpacked extension into Chromium with
// Playwright, opens real tabs and groups, and drives the Tab Desk page.
// Run with: npm run smoke   (needs the `playwright` package and a Chromium build)

import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const SHOTS = process.env.SHOTS_DIR;

const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><title>Page ${req.url}</title><h1>${req.url}</h1>`);
}).listen(0);
const port = server.address().port;
const A = p => `http://localhost:${port}${p}`;
const B = p => `http://127.0.0.1:${port}${p}`;

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'tabdesk-')), {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  viewport: { width: 1280, height: 820 },
});
const errors = [];
let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const step = msg => console.log('✓', msg);

try {
  // Open some tabs: two groups worth plus Inbox tabs and a duplicate.
  const urls = [A('/checkout'), A('/pr/1284'), A('/docs'), B('/incident'), B('/logs'), A('/news/1'), A('/news/2'), A('/pr/1284')];
  for (const u of urls) { const p = await ctx.newPage(); await p.goto(u); }

  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`chrome-extension://${extId}/dashboard.html`);

  // Make two groups through the real API.
  await page.evaluate(async ({ a, b }) => {
    const tabs = await chrome.tabs.query({});
    const id = u => tabs.find(t => t.url === u).id;
    const g1 = await chrome.tabs.group({ tabIds: [id(a + '/checkout'), tabs.find(t => t.url === a + '/pr/1284').id, id(a + '/docs')] });
    await chrome.tabGroups.update(g1, { title: 'Checkout redesign', color: 'blue' });
    const g2 = await chrome.tabs.group({ tabIds: [id(b + '/incident'), id(b + '/logs')] });
    await chrome.tabGroups.update(g2, { title: 'Incident 4821', color: 'red' });
  }, { a: `http://localhost:${port}`, b: `http://127.0.0.1:${port}` });

  await page.waitForFunction(() => document.querySelectorAll('[data-nav=group]').length === 2);
  const names = await page.$$eval('[data-nav=group] .name', ns => ns.map(n => n.textContent));
  assert.deepEqual(names, ['Checkout redesign', 'Incident 4821']);
  step('sidebar lists live groups');

  assert.match(await page.textContent('#dupBtn'), /1 duplicate tab/);
  step('duplicate counter');

  // Dashboard: the default view, one card per open group plus the Inbox.
  assert.equal(await page.getAttribute('[data-nav=dashboard]', 'aria-current'), 'true');
  await page.waitForFunction(() => document.querySelectorAll('.card[data-card]:not(.inbox)').length === 2);
  assert.deepEqual(await page.$$eval('.card:not(.inbox) .card-name', ns => ns.map(n => n.textContent)), ['Checkout redesign', 'Incident 4821']);
  assert.equal(await page.$$eval('.card:has-text("Checkout redesign") .card-tab', r => r.length), 3);
  assert.match(await page.textContent('.card:has-text("Checkout redesign") .card-meta'), /^3 tabs · 1 site/);
  assert.ok(await page.isVisible('.card.inbox'));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'dashboard.png') });
  step('dashboard shows a card per group with its tabs');

  await page.click('.card:has-text("Incident 4821") .card-tab-btn:has-text("/logs")');
  await page.waitForFunction(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url.endsWith('/logs'));
  await page.bringToFront();
  step('click a tab on a card to switch to it');

  await page.click('.card:has-text("Incident 4821") [data-act=card-more]');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'dashboard-menu.png') });
  await page.click('.menu button:has-text("Open details")');
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Incident 4821');
  await page.click('[data-nav=dashboard]');
  await page.waitForSelector('.card');
  step('card menu opens the group detail, sidebar returns to the dashboard');

  await page.click('[data-nav=group]:has-text("Checkout redesign")');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'group.png') });

  // Expand a group in the sidebar to list its tabs, then switch to one.
  await page.click('[data-gid]:has-text("Checkout redesign") .chev');
  await page.waitForFunction(() => document.querySelectorAll('.nav-tabs .nav-tab').length === 3);
  assert.equal(await page.getAttribute('[data-gid]:has-text("Checkout redesign") .chev', 'aria-expanded'), 'true');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'sidebar-expanded.png') });
  await page.click('.nav-tab:has-text("/pr/1284")');
  await page.waitForFunction(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url.endsWith('/pr/1284'));
  await page.bringToFront();
  step('expand a group in the sidebar and switch to one of its tabs');

  // Drag a group to reorder it; the real tab strip follows.
  const sideOrder = () => page.$$eval('[data-nav=group] .name', ns => ns.map(n => n.textContent));
  const stripOrder = () => page.evaluate(async () => {
    const [tabs, groups] = await Promise.all([chrome.tabs.query({ currentWindow: true }), chrome.tabGroups.query({})]);
    const ids = [...new Set(tabs.sort((a, b) => a.index - b.index).map(t => t.groupId).filter(id => id !== -1))];
    return ids.map(id => groups.find(g => g.id === id).title);
  });
  const waitSide = names => page.waitForFunction(n => JSON.stringify([...document.querySelectorAll('[data-nav=group] .name')].map(x => x.textContent)) === n, JSON.stringify(names));
  assert.deepEqual(await stripOrder(), ['Checkout redesign', 'Incident 4821']);
  await page.locator('[data-gid]:has-text("Incident 4821") .nav-row').dragTo(page.locator('[data-gid]:has-text("Checkout redesign") .nav-row'), { targetPosition: { x: 40, y: 3 } });
  await waitSide(['Incident 4821', 'Checkout redesign']);
  assert.deepEqual(await stripOrder(), ['Incident 4821', 'Checkout redesign']);
  step('drag a group up in the sidebar moves it in the tab strip');

  await page.click('.toast button');
  await waitSide(['Checkout redesign', 'Incident 4821']);
  assert.deepEqual(await stripOrder(), ['Checkout redesign', 'Incident 4821']);
  step('undo the group move');

  // Drag down (past an expanded group) and back with the keyboard.
  await page.locator('[data-gid]:has-text("Checkout redesign") .nav-row').dragTo(page.locator('[data-gid]:has-text("Incident 4821") .nav-row'), { targetPosition: { x: 40, y: 26 } });
  await waitSide(['Incident 4821', 'Checkout redesign']);
  assert.deepEqual(await stripOrder(), ['Incident 4821', 'Checkout redesign']);
  await page.focus('[data-nav=group]:has-text("Checkout redesign")');
  await page.keyboard.press('Alt+ArrowUp');
  await waitSide(['Checkout redesign', 'Incident 4821']);
  assert.deepEqual(await stripOrder(), ['Checkout redesign', 'Incident 4821']);
  step('drag a group down, and Alt+Up moves it back');

  // Rename + color.
  await page.click('[data-nav=group]:has-text("Checkout redesign")');
  await page.click('[data-act=rename]');
  await page.fill('#renameInput', 'Checkout v3');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Checkout v3');
  step('rename group');

  // Palette: find a news tab and move it into a new group.
  await page.keyboard.press('Control+k');
  await page.fill('#palInput', 'news/2');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'palette.png') });
  await page.keyboard.press('Control+m');
  await page.fill('#palInput', 'Reading');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-nav=group] .name')].some(n => n.textContent === 'Reading'));
  step('palette moves a tab into a new group');

  // Duplicates.
  await page.click('#dupBtn');
  await page.click('[data-m=ok]');
  await page.waitForFunction(() => /No duplicate/.test(document.querySelector('#dupBtn').textContent));
  step('close duplicates');

  // Save & close, then restore.
  await page.click('[data-nav=group]:has-text("Incident 4821")');
  await page.click('[data-act=save-close]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-nav=ws] .name')].some(n => n.textContent === 'Incident 4821'));
  const saved = await page.evaluate(() => chrome.storage.local.get('workspaces'));
  assert.equal(saved.workspaces[0].tabs.length, 2);
  step('save & close stores the workspace and closes its tabs');

  await page.click('[data-nav=workspaces]');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'workspaces.png') });
  await page.click('[data-act=restore]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-nav=group] .name')].some(n => n.textContent === 'Incident 4821'));
  const left = await page.evaluate(() => chrome.storage.local.get('workspaces'));
  assert.equal(left.workspaces.length, 0);
  step('restore reopens the group');

  // Undo from the toast (restore → back to saved).
  await page.click('.toast button');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-nav=ws] .name')].some(n => n.textContent === 'Incident 4821'));
  step('undo');

  // Inbox: group by site.
  await page.click('[data-nav=inbox]');
  const inboxCount = await page.$$eval('.tab', r => r.length);
  assert.ok(inboxCount >= 1);
  step(`inbox shows ${inboxCount} ungrouped tab(s)`);

  // Move a grouped tab via the row menu to the Inbox.
  await page.click('[data-nav=group]:has-text("Checkout v3")');
  const rows = await page.$$eval('.tab', r => r.length);
  await page.hover('.tab >> nth=0');
  await page.click('.tab >> nth=0 >> [data-act=move]');
  await page.click('.menu button:has-text("Inbox")');
  await page.waitForFunction(n => document.querySelectorAll('.tab').length === n - 1, rows);
  step('move tab to Inbox from the row menu');

  await page.click('[data-nav=inbox]');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'inbox.png') });
  if (await page.isEnabled('[data-act=by-domain]')) {
    await page.click('[data-act=by-domain]');
    await page.click('[data-m=ok]');
    await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Created'));
    step('group Inbox by site');
  }

  // Resize the sidebar by dragging its edge; the width is remembered.
  const sideW = () => page.$eval('.side', n => Math.round(n.getBoundingClientRect().width));
  assert.equal(await sideW(), 272);
  const h = await page.locator('#sideResizer').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + 200);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 100, h.y + 200, { steps: 5 });
  await page.mouse.up();
  assert.ok(Math.abs(await sideW() - 372) <= 2, `sidebar is ${await sideW()}px`);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'sidebar-wide.png') });
  await page.reload();
  await page.waitForSelector('[data-nav=group]');
  assert.ok(Math.abs(await sideW() - 372) <= 2);
  await page.focus('#sideResizer');
  await page.keyboard.press('Home');
  assert.equal(await sideW(), 200);
  await page.dblclick('#sideResizer');
  assert.equal(await sideW(), 272);
  step('resize the sidebar by dragging, keyboard and double-click reset');

  // Tab Desk always opens on the dashboard, even if you left it on a group.
  await page.click('[data-nav=group] >> nth=0');
  await page.reload();
  await page.waitForSelector('.card[data-card]');
  assert.equal(await page.getAttribute('[data-nav=dashboard]', 'aria-current'), 'true');
  step('always opens on the dashboard');

  // Dashboard columns: 3 on a large main area, 2 on medium, 1 on small.
  const cols = () => page.$eval('.cards', n => getComputedStyle(n).gridTemplateColumns.split(' ').length);
  for (const [w, n] of [[1600, 3], [1100, 2], [600, 1]]) {
    await page.setViewportSize({ width: w, height: 820 });
    assert.equal(await cols(), n, `${w}px wide should show ${n} columns`);
  }
  await page.setViewportSize({ width: 1280, height: 820 });
  step('dashboard shows 3, 2 or 1 columns depending on width');

  assert.deepEqual(errors, []);
  step('no page errors');
  console.log('\nSmoke test passed.');
} finally {
  await ctx.close();
  server.close();
}
