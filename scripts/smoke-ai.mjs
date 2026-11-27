// End-to-end smoke test for AI summaries. Loads the extension in Chromium with Playwright.
// Headless Chromium has no on-device model and we don't want real Gemini or Claude calls, so the page gets
// fake `LanguageModel` / `Summarizer` globals and fake Gemini and Claude endpoints. Everything else
// (permissions, page reading, saved summaries, statuses, rules, settings, the UI) is the real code.
// Run with: npm run smoke:ai

import { createServer } from 'node:http';
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const SHOTS = process.env.SHOTS_DIR;
const step = msg => console.log('✓', msg);

let liveText = 'The first version of this page.';
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  const body = req.url === '/live' ? `<main><h1>Live page</h1><p>${liveText}</p></main>`
    : req.url === '/issue/7'
    ? `<meta name="user-login" content="me-user"><main><h1>Fix the login page</h1><span class="State">Open</span><dl><dt>Assignee</dt><dd>me-user</dd><dt>Labels</dt><dd>bug</dd></dl><p>Long discussion that says Closed and Merged many times. ${'Closed. Merged. '.repeat(40)}</p></main>`
    : req.url === '/long'
    ? `<main><h1>Long read</h1><span class="State" title="Status: Merged">Merged</span><article><p>One comment</p></article><div class="reviewers"><svg class="octicon octicon-check-circle-fill color-fg-success" aria-hidden="true"><path d="M0 0"/></svg> reviewer-ann <svg class="octicon octicon-dot-fill fgColor-attention" aria-hidden="true"></svg> ci-build <button aria-label="Re-request review"><svg class="octicon octicon-sync"></svg></button><clipboard-copy aria-label="Copy code"><svg class="octicon octicon-check color-fg-success"></svg></clipboard-copy><button><svg class="octicon octicon-git-pull-request-closed"></svg> Close pull request</button></div>${Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i} ${'lorem ipsum '.repeat(30)}</p>`).join('')}<form><h3 class="status-heading">Pull request successfully merged and closed</h3></form></main>`
    : `<nav>Site menu</nav><main><h1>${req.url}</h1><p>The secret phrase on ${req.url} is purple-otter.</p></main><footer>Footer</footer>`;
  res.end(`<!doctype html><html lang="en"><title>Page ${req.url}</title>${body}`);
}).listen(0);
const port = server.address().port;
const U = p => `http://localhost:${port}${p}`;

// Injected into every page before its scripts run. Only acts on the extension page.
function fakes() {
  if (location.protocol !== 'chrome-extension:') return;
  const ai = window.__ai = { calls: [], fetches: [], state: { lm: localStorage.getItem('__fakeLm') || 'downloadable' } };
  const needGesture = () => { if (ai.state.lm !== 'available' && !navigator.userActivation.isActive) throw new DOMException('needs a click', 'NotAllowedError'); };
  class FakeLM {
    static async availability() { return ai.state.lm; }
    static async create(o) {
      needGesture();
      for (const f of [0.25, 0.5, 1]) o.monitor?.({ addEventListener: (_, cb) => cb({ loaded: f, total: 1 }) });
      ai.state.lm = 'available';
      localStorage.setItem('__fakeLm', 'available');
      return new FakeLM(o);
    }
    constructor(o) { this.o = o; }
    async clone() { return new FakeLM(this.o); }
    async prompt(text, opts = {}) {
      ai.calls.push({ system: this.o.initialPrompts?.[0]?.content || '', text, json: !!opts.responseConstraint });
      if (/write instructions for an AI that summarizes/.test(this.o.initialPrompts?.[0]?.content || '')) {
        return 'Here you go:\n```\nThis page is: a test page.\nFacts: the secret phrase.\nSummary: say the secret phrase.\nStatus:\n- Need action when the phrase is red.\n```';
      }
      if (opts.responseConstraint) {
        const status = /PR rule/.test(text) ? 'action' : /purple-otter/.test(text) ? 'working' : 'info';
        const what = /purple-otter/.test(text) ? 'mentions purple-otter' : 'no page text';
        return JSON.stringify({ summary: `Local summary ${what}. A second sentence that should be dropped.`, status });
      }
      return 'This group is about local testing of tabs. Another sentence.';
    }
    destroy() {}
  }
  window.LanguageModel = FakeLM;
  window.Summarizer = { availability: async () => 'unavailable' };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://generativelanguage.googleapis.com/')) {
      const body = init.body ? JSON.parse(init.body) : null;
      ai.fetches.push({ url: String(url), headers: init.headers, body });
      if (init.headers?.['x-goog-api-key'] === 'bad') return new Response(JSON.stringify({ error: { message: 'API key not valid.' } }), { status: 400 });
      if (String(url).includes('/models?')) return new Response('{"models":[]}', { status: 200 });
      const ev = t => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] })}\n\n`;
      const out = body.generationConfig?.responseMimeType === 'application/json'
        ? ev('{"summary": "A cloud tab sentence from Gemini. Extra.", ') + ev('"status": "waiting"}')
        : ev('This group is about **cloud** testing. ') + ev('Extra sentence.');
      return new Response(out, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (String(url).startsWith('https://api.anthropic.com/')) {
      const body = init.body ? JSON.parse(init.body) : null;
      ai.fetches.push({ url: String(url), headers: init.headers, body });
      if (init.headers?.['x-api-key'] === 'bad') return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401 });
      if (String(url).includes('/v1/models')) return new Response('{"data":[]}', { status: 200 });
      const ev = t => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })}\n\n`;
      const end = 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
      const fmt = body.output_config?.format;
      const out = fmt && fmt.schema.required.includes('status')
        ? ev('{"facts": "", "summary": "A cloud tab sentence from Claude. Extra.", ') + ev('"status": "idle"}')
        : fmt ? ev('{"summary": "A field sentence from Claude."}')
        : ev('This group is about **Claude** testing. ') + ev('Extra sentence.');
      return new Response(out + end, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return realFetch(url, init);
  };
}

async function launch(ext) {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'tabdesk-ai-')), {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    viewport: { width: 1280, height: 900 },
  });
  await ctx.addInitScript(fakes);
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  return { ctx, extId: new URL(sw.url()).host };
}

async function openDesk(ctx, extId, errors) {
  for (const u of [U('/alpha'), U('/pr/5'), U('/long'), U('/other')]) { const p = await ctx.newPage(); await p.goto(u); }
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`chrome-extension://${extId}/dashboard.html`);
  await page.evaluate(async base => {
    const tabs = await chrome.tabs.query({});
    const id = p => tabs.find(t => t.url === base + p).id;
    const o = await chrome.tabs.group({ tabIds: [id('/other')] });
    await chrome.tabGroups.update(o, { title: 'Other', color: 'grey' });
    const g = await chrome.tabs.group({ tabIds: ['/alpha', '/pr/5', '/long'].map(id) });
    await chrome.tabGroups.update(g, { title: 'Research', color: 'purple' });
    await chrome.tabGroups.move(o, { index: 0 });
  }, `http://localhost:${port}`);
  await page.waitForSelector('[data-nav=group]:has-text("Research")');
  await page.click('[data-nav=group]:has-text("Research")');
  await page.waitForSelector('[data-act=ai-group]');
  return page;
}

const line = (page, path) => page.locator(`.tab:has-text("${path}") .ai-line`);
const waitLine = (page, path, re) => page.waitForFunction(([p, src]) => {
  const row = [...document.querySelectorAll('.tab, .card-tab')].find(r => r.textContent.includes(p));
  return new RegExp(src).test(row?.querySelector('.ai-line')?.textContent || '');
}, [path, re.source]);

const errors = [];

/* ---------- 1. Real manifest: page access is optional, so the explain dialog shows first ---------- */
{
  const { ctx, extId } = await launch(SRC);
  try {
    const page = await openDesk(ctx, extId, errors);
    await page.hover('.tab:has-text("/alpha")');
    await page.click('.tab:has-text("/alpha") [data-act=ai-tab]');
    await page.waitForSelector('#modal:not([hidden]) :text("read the pages you summarize")');
    step('first Summarize explains page access before Chrome asks');
    await page.click('[data-m=titles]');
    await page.waitForFunction(() => /Local summary no page text\.\n/.test([...document.querySelectorAll('.tab')].find(r => r.textContent.includes('/alpha'))?.querySelector('.ai-st')?.title || ''));
    assert.equal(await page.locator('.ai-line').count(), 0, 'no summary line under tabs by default');
    step('“Use titles only” still gives a one-sentence summary; by default it shows on hover over the status, not under the tab');
  } finally { await ctx.close(); }
}

/* ---------- 2. With page access granted (test copy of the manifest) ---------- */
const ext = mkdtempSync(join(tmpdir(), 'tabdesk-ext-'));
cpSync(SRC, ext, { recursive: true });
const mf = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
mf.host_permissions = ['<all_urls>'];
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(mf, null, 2));

const { ctx, extId } = await launch(ext);
try {
  const page = await openDesk(ctx, extId, errors);
  assert.equal(await page.locator('.ai-line .ai-sum').count(), 0, 'nothing summarized before the model is downloaded');
  step('no automatic summaries before the on-device model is downloaded');

  // Settings: general instructions and a URL rule.
  await page.click('#settingsBtn');
  await page.waitForSelector('.settings-dialog [role=tab][data-tab=general][aria-selected=true]');
  assert.equal(await page.isChecked('#aiTabLines'), false);
  await page.check('#aiTabLines');
  assert.equal(await page.textContent('#settingsBtn'), 'Settings');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'settings-general.png') });
  assert.equal(await page.isVisible('#aiGeneral'), false);
  await page.click('[role=tab][data-tab=instructions]');
  await page.fill('#aiGeneral', 'Write in Vietnamese.');
  await page.click('#aiAddRule');
  await page.fill('.ai-rule:last-child .ai-rule-pat', `localhost:${port}/pr/*`);
  await page.waitForFunction(() => /matches 1 open tab/.test(document.querySelector('.ai-rule:last-child .ai-rule-count').textContent));
  await page.fill('.ai-rule:last-child .ai-rule-ins', 'PR rule: say if my review is needed.');
  await page.click('#aiAddRule');
  await page.fill('.ai-rule:last-child .ai-rule-pat', '/[/');
  await page.waitForFunction(() => /Not a valid pattern/.test(document.querySelector('.ai-rule:last-child .ai-rule-count').textContent));
  await page.click('.ai-rule:last-child [data-m=rdel]');
  if (SHOTS) {
    await page.locator('#aiRulesField').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, 'ai-settings-rules.png') });
  }
  await page.click('[data-m=ok]');
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Settings saved'));
  let saved = (await page.evaluate(() => chrome.storage.local.get('aiSettings'))).aiSettings;
  assert.equal(saved.general, 'Write in Vietnamese.');
  assert.equal(saved.tabLines, true);
  assert.deepEqual(saved.rules, [{ pattern: `localhost:${port}/pr/*`, instructions: 'PR rule: say if my review is needed.' }]);
  step('turn on the summary under each tab; save general instructions and a URL rule (live match count, invalid pattern flagged)');

  await page.click('[data-act=group-more]');
  await page.click('.menu button:has-text("AI instructions")');
  await page.fill('#aiGroupInstr', 'Focus on the secret phrase.');
  await page.click('[data-m=ok]');
  await page.waitForSelector('.ai-instr-chip');
  step('save per-group instructions from the group menu');

  // Summarize the group: downloads the model (click = gesture), summarizes every tab, then the group.
  await page.click('[data-act=ai-group]');
  await page.waitForFunction(() => /local testing of tabs\.$/.test(document.querySelector('[data-sum^="group:"] .ai-gtext')?.textContent || ''));
  await waitLine(page, '/alpha', /^Local summary mentions purple-otter\.$/);
  await waitLine(page, '/pr/5', /mentions purple-otter/);
  assert.match(await page.textContent('.tab:has-text("/pr/5") .ai-st'), /Need action/);
  assert.match(await page.textContent('.tab:has-text("/alpha") .ai-st'), /Working/);
  assert.match(await page.textContent('.pane-meta'), /Need action/);
  const calls = await page.evaluate(() => window.__ai.calls);
  const prCall = calls.find(c => c.json && c.text.includes('/pr/5'));
  const alphaCall = calls.find(c => c.json && c.text.includes('/alpha'));
  const longCall = calls.find(c => c.json && c.text.includes('/long'));
  assert.match(prCall.text, /^Instructions for this page:\nPR rule/, 'the page rule replaces group and general instructions');
  assert.doesNotMatch(prCall.text, /Vietnamese|Focus on the secret/);
  assert.match(alphaCall.text, /^Instructions for this page:\nFocus on the secret phrase\./, 'group instructions replace the general ones');
  assert.doesNotMatch(alphaCall.text, /Vietnamese/);
  assert.match(prCall.system || calls.find(c => c.json).system, /Reply with JSON only, in this order: \{"facts"/);
  assert.doesNotMatch(alphaCall.text, /PR rule/);
  assert.doesNotMatch(alphaCall.text, /Site menu|Footer/);
  assert.ok(longCall.text.length < 7000, 'long pages are trimmed for the on-device model');
  assert.match(longCall.text, /Page state: Status: Merged/, 'state badges are read and put first');
  assert.match(longCall.text, /successfully merged and closed/, 'the end of a long page (merge box) is kept');
  assert.match(longCall.text, /Paragraph 3 /, 'the whole main area is read, not just one comment');
  assert.match(longCall.text, /\[icon: passed\/approved, green\] reviewer-ann/, 'icons become text');
  assert.match(longCall.text, /\[icon: pending, yellow\] ci-build/);
  assert.match(longCall.text, /\[Re-request review\]/);
  assert.doesNotMatch(longCall.text, /\[icon: passed\/approved, green\] *\[Copy code\]|closed pull request/, 'icons on labelled buttons are left out');
  assert.equal((longCall.text.match(/passed\/approved/g) || []).length, 1);
  assert.match(calls.find(c => !c.json).system, /ONE short sentence/);
  step('Summarize group: one sentence per tab and for the group, statuses from the AI, URL rule only on matching pages');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'ai-group-page.png') });

  // Set a status by hand.
  await page.click('.tab:has-text("/alpha") .ai-st');
  await page.click('.menu button:has-text("Idle")');
  await page.waitForFunction(() => /Idle/.test(document.querySelector('.tab .ai-st.manual')?.textContent || ''));
  const ins = await page.evaluate(async u => (await new Promise(r => setTimeout(r, 400)), (await chrome.storage.local.get('aiTabInsights')).aiTabInsights[u]), U('/alpha'));
  assert.equal(ins.manual, 'idle');
  assert.equal(ins.status, 'working');
  step('set a tab’s status by hand; the AI’s status is kept underneath');

  // "AI instructions for pages like this" from the status menu suggests a rule for the URL.
  await page.click('.tab:has-text("/long") .ai-st');
  await page.click('.menu button:has-text("pages like this")');
  await page.waitForFunction(p => [...document.querySelectorAll('.ai-rule-pat')].some(i => i.value === p), `localhost:${port}/long`);
  // Draft with AI fills the template from the matching tab; Undo is not offered for an empty box.
  const rule = page.locator('.ai-rule:last-child');
  await rule.locator('[data-m=rdraft]').click();
  await page.waitForFunction(() => /^This page is: a test page\./.test(document.querySelector('.ai-rule:last-child .ai-rule-ins').value));
  const draftCall = await page.evaluate(() => window.__ai.calls.filter(c => /write instructions for an AI/.test(c.system)).at(-1));
  assert.match(draftCall.system, /This page is: …\nFacts: …/, 'the template is in the draft prompt');
  assert.match(draftCall.text, /Pattern: localhost:\d+\/long/);
  assert.match(draftCall.text, /Paragraph 3 /, 'the matching tab’s page text is used');
  assert.match(await rule.locator('.ai-rule-msg').textContent(), /Drafted by AI/);
  await rule.locator('.ai-rule-ins').fill('My own words');
  await rule.locator('[data-m=rtpl]').click();
  assert.match(await rule.locator('.ai-rule-ins').inputValue(), /^This page is: …/);
  await rule.locator('[data-m=rundo]').click();
  assert.equal(await rule.locator('.ai-rule-ins').inputValue(), 'My own words');
  if (SHOTS) { await rule.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(SHOTS, 'ai-rule-draft.png') }); }
  await page.click('[data-m=cancel]');
  step('status menu offers instructions for pages like this one; Draft with AI fills the template from that page; Insert template and Undo');

  // A new tab isn't summarized on its own; the interval refresh picks it up when it is due.
  const p2 = await ctx.newPage();
  await p2.goto(U('/fresh'));
  await page.bringToFront();
  await page.click('[data-nav=inbox]');
  await page.waitForTimeout(800);
  assert.doesNotMatch(await line(page, '/fresh').textContent().catch(() => ''), /purple-otter/, 'no summary before the refresh is due');
  await page.evaluate(() => chrome.storage.local.set({ aiLastRefresh: 1 })); // as if the last refresh was long ago
  await page.reload();
  await page.click('[data-nav=inbox]');
  await waitLine(page, '/fresh', /mentions purple-otter/);
  step('new tabs wait for the interval refresh, which summarizes them once it is due');

  // Saved summaries come back after a reload, without calling the model again.
  await page.reload();
  await page.click('[data-nav=group]:has-text("Research")');
  await waitLine(page, '/pr/5', /mentions purple-otter/);
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => window.__ai.calls.filter(c => c.json).length);
  assert.equal(after, 0, 'unchanged pages are not sent to the model again after a reload');
  step('summaries and statuses are saved and shown again after a reload without re-running the model');

  // A page that changes after its summary: marked outdated, not summarized again.
  const pLive = await ctx.newPage();
  await pLive.goto(U('/live'));
  await page.bringToFront();
  await page.click('[data-nav=inbox]');
  await page.hover('.tab:has-text("/live")');
  await page.click('.tab:has-text("/live") [data-act=ai-tab]');
  await page.waitForSelector('.tab:has-text("/live") .ai-sum');
  const before = await page.evaluate(() => window.__ai.calls.length);
  await pLive.reload(); // same text: not outdated
  await page.waitForTimeout(6500);
  assert.equal(await page.locator('.tab:has-text("/live") .ai-sum.is-stale').count(), 0, 'a reload without changes keeps the summary');
  liveText = 'A completely different second version, merged and closed.';
  await pLive.reload();
  await page.waitForSelector('.tab:has-text("/live") .ai-sum.is-stale', { timeout: 15000 });
  assert.match(await line(page, '/live').textContent(), /^Outdated/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'ai-outdated.png') });
  assert.equal(await page.evaluate(() => window.__ai.calls.length), before, 'marking a summary outdated calls no model');
  await page.hover('.tab:has-text("/live")');
  await page.click('.tab:has-text("/live") [data-act=ai-tab]');
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll('.tab')].find(r => r.textContent.includes('/live'));
    return row?.querySelector('.ai-sum') && !row.querySelector('.ai-sum.is-stale');
  });
  step('a page that changed after its summary is marked Outdated without a model call; Summarize clears it');

  // Leaving a tab you were on summarizes it, so its status is current.
  liveText = 'A third version: the build is running now.';
  await pLive.reload();
  await page.waitForSelector('.tab:has-text("/live") .ai-sum.is-stale', { timeout: 15000 });
  const callsBeforeLeave = await page.evaluate(() => window.__ai.calls.length);
  await pLive.bringToFront();
  await pLive.waitForTimeout(5500);
  await page.bringToFront();
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll('.tab')].find(r => r.textContent.includes('/live'));
    return row?.querySelector('.ai-sum') && !row.querySelector('.ai-sum.is-stale');
  }, null, { timeout: 20000 });
  assert.ok(await page.evaluate(() => window.__ai.calls.length) > callsBeforeLeave, 'leaving the tab ran the model');
  step('leaving a tab after a few seconds summarizes it again, so its status is up to date');

  // Dashboard: tab lines, status dots, group sentence and "most urgent first".
  await page.click('[data-nav=dashboard]');
  await page.waitForSelector('.card:has-text("Research") .ai-gtext');
  assert.match(await page.textContent('.card-tab:has-text("/pr/5") .ai-line'), /mentions purple-otter/);
  assert.equal(await page.locator('.card-tab:has-text("/pr/5") .ai-edge.st-action').count(), 1);
  assert.match(await page.textContent('.card:has-text("Research") .card-head'), /Need action/);
  assert.ok(await page.isVisible('.card:has-text("Research") .card-head [data-act=ai-group]'), 'Summarize sits in the card header');
  assert.match(await page.textContent('.dash-bar .ai-next'), /^Next refresh in \d+ min$/, 'countdown to the next refresh in the header');
  assert.equal(await page.locator('text=Tabs changed').count(), 0, 'groups show no "Tabs changed"; only tabs show Outdated');
  assert.ok(await page.isVisible('.card:has-text("Research") .st-bar'));
  assert.ok(await page.isVisible('.card.needs-you:has-text("Research")'));
  // Most urgent is the default sort: Research (needs you) comes before Other, and /pr/5 is its first tab.
  const order = () => page.$$eval('.card .card-name', ns => ns.map(n => n.textContent.trim()));
  assert.deepEqual((await order()).slice(0, 2), ['Research', 'Other']);
  assert.match(await page.textContent('.card:has-text("Research") .card-tab >> nth=0'), /\/pr\/5/);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'ai-dashboard.png') });
  await page.click('[data-act=sort]');
  await page.click('.menu button:has-text("Tab strip order")');
  await page.waitForFunction(() => document.querySelector('.card .card-name')?.textContent.trim() === 'Other');
  await page.click('[data-act=sort]');
  await page.click('.menu button:has-text("Most urgent")');
  await page.waitForFunction(() => document.querySelector('.card .card-name')?.textContent.trim() === 'Research');
  assert.equal(await page.locator('.chip, .done-row').count(), 0, 'no status filter or Done row: groups never grey out or fold away');
  assert.doesNotMatch(await page.textContent('.card:has-text("Research") .card-meta'), /done/, 'no "X of Y done" footer');
  assert.match(await page.getAttribute('.card:has-text("Research") .st-bar', 'title'), /Need action[\s\S]*Idle/, 'the status bar counts the new statuses');
  assert.equal(await page.locator('.card.is-done').count(), 0);
  assert.match(await page.textContent('.card:has-text("Other") .card-meta'), /1 of 1 working/, 'the footer counts tabs running a task');
  step('dashboard cards show tab summaries, status edges, the group sentence; and the sort menu works');

  // The same page open in two groups (Research has its own instructions, Other doesn't): summarizing
  // one group must not rewrite the shared tab each time, back and forth.
  await page.evaluate(async base => {
    const [other] = await chrome.tabs.query({ url: base + '/other' });
    const t = await chrome.tabs.create({ url: base + '/alpha', active: false });
    await new Promise(r => { const f = (id, i) => { if (id === t.id && i.status === 'complete') { chrome.tabs.onUpdated.removeListener(f); r(); } }; chrome.tabs.onUpdated.addListener(f); });
    await chrome.tabs.group({ tabIds: [t.id], groupId: other.groupId });
  }, `http://localhost:${port}`);
  const card = n => page.locator(`.card:has(.card-name:text-is("${n}"))`);
  await card('Other').locator('.card-head [data-act=ai-group]').waitFor();
  const alphaAt = () => page.evaluate(async u => (await chrome.storage.local.get('aiTabInsights')).aiTabInsights?.[u]?.at, U('/alpha'));
  const atBefore = await alphaAt();
  for (const n of ['Other', 'Research', 'Other']) {
    await card(n).locator('.card-head [data-act=ai-group]').click();
    await page.waitForFunction(name => {
      const c = [...document.querySelectorAll('.card')].find(e => e.querySelector('.card-name')?.textContent.trim() === name);
      return c && c.querySelector('.ai-gtext') && !c.querySelector('.ai-gline.is-running');
    }, n);
  }
  await page.waitForTimeout(500);
  assert.equal(await alphaAt(), atBefore, 'the shared page keeps its summary');
  assert.equal(await page.locator('.ai-sum.is-stale').count(), 0, 'no tab shows Outdated');
  step('a page open in two groups keeps one summary; summarizing either group doesn\'t rewrite it');

  // The side panel shows the same statuses, read from storage, and picks up changes made in the page.
  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 380, height: 700 });
  panel.on('pageerror', e => errors.push(`panel: ${e.message}`));
  await panel.goto(`chrome-extension://${extId}/panel.html`);
  await panel.waitForSelector('.card:has-text("Research") .ai-gtext');
  assert.match(await panel.textContent('.card:has-text("Research") .card-head'), /Need action/);
  assert.equal(await panel.locator('.card-tab:has-text("/pr/5") .ai-edge.st-action').count(), 1);
  assert.deepEqual((await panel.$$eval('.card .card-name', ns => ns.map(n => n.textContent.trim()))).slice(0, 2), ['Research', 'Other']);
  if (SHOTS) await panel.screenshot({ path: join(SHOTS, 'ai-side-panel.png') });
  await page.bringToFront();
  await page.click('.card-tab:has-text("/pr/5") .ai-edge');
  await page.click('.menu button:has-text("Idle")');
  await panel.waitForSelector('.card-tab:has-text("/pr/5") .ai-edge.st-idle');
  await page.click('.card-tab:has-text("/pr/5") .ai-edge');
  await page.click('.menu button:has-text("Let the AI decide")');
  await panel.waitForSelector('.card-tab:has-text("/pr/5") .ai-edge.st-action');
  await panel.close();
  step('side panel shows the same statuses and updates when they change in the page');

  // Gemini key, consent, and cloud summaries.
  await page.click('#settingsBtn');
  // Remembers the last tab (Summary instructions); arrow keys move between tabs.
  await page.waitForSelector('[role=tab][data-tab=instructions][aria-selected=true]');
  await page.focus('[role=tab][data-tab=instructions]');
  await page.keyboard.press('ArrowUp');
  await page.waitForSelector('#aiKey-gemini', { state: 'visible' });
  assert.equal(await page.isVisible('#aiKey-claude'), false, 'only the chosen cloud’s key is shown');
  await page.fill('#aiKey-gemini', 'bad');
  await page.click('[data-cloud=gemini] [data-keytest]');
  await page.waitForSelector('[data-cloud=gemini] .ai-key-msg .ai-bad');
  await page.fill('#aiKey-gemini', 'good-key');
  await page.click('[data-m=ok]');
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Settings saved'));
  await page.click('.card:has-text("Research") [data-act=card-more]');
  await page.click('.menu button:has-text("Summarize group and tabs")');
  await page.waitForSelector('#modal:not([hidden]) :text("Send page content to Google Gemini?")');
  await page.click('[data-m=ok]');
  await page.waitForFunction(() => /^This group is about cloud testing\.$/.test(document.querySelector('.card [data-sum^="group:"] .ai-gtext')?.textContent || ''));
  let f = await page.evaluate(() => window.__ai.fetches.at(-1));
  assert.equal(f.headers['x-goog-api-key'], 'good-key');
  assert.doesNotMatch(f.url, /good-key/);
  assert.match(f.body.systemInstruction.parts[0].text, /Focus on the secret phrase\./);
  assert.doesNotMatch(f.body.systemInstruction.parts[0].text, /Vietnamese/);
  step('with a key, the group sentence comes from Gemini after consent, with instructions, key in a header');

  // Gemini for tabs: JSON summary + status.
  await page.click('#settingsBtn');
  await page.check('input[name=aiEngine][value=cloud]');
  await page.click('[data-m=ok]');
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Settings saved'));
  await page.click('[data-nav=group]:has-text("Research")');
  await page.hover('.tab:has-text("/pr/5")');
  await page.click('.tab:has-text("/pr/5") [data-act=ai-tab]');
  await waitLine(page, '/pr/5', /^A cloud tab sentence from Gemini\.$/);
  assert.match(await page.textContent('.tab:has-text("/pr/5") .ai-st'), /Working/, 'an old "waiting" reply counts as Working');
  f = await page.evaluate(() => window.__ai.fetches.at(-1));
  assert.equal(f.body.generationConfig.responseMimeType, 'application/json');
  assert.match(f.body.systemInstruction.parts[0].text, /^You look at one browser tab[\s\S]*in this order: \{"facts"[\s\S]*Instructions for this page:\nPR rule/);
  step('Gemini for tabs returns one sentence and a status as JSON, with the URL rule');

  // Claude Haiku as the cloud: its own key, its own consent, same summaries and statuses.
  await page.click('#settingsBtn');
  await page.check('input[name=aiCloud][value=claude]');
  await page.waitForSelector('#aiKey-claude', { state: 'visible' });
  assert.equal(await page.isVisible('#aiKey-gemini'), false);
  assert.equal(await page.inputValue('#aiModel-claude'), 'claude-haiku-5-5');
  await page.fill('#aiKey-claude', 'bad');
  await page.click('[data-cloud=claude] [data-keytest]');
  await page.waitForFunction(() => /Claude API key was rejected/.test(document.querySelector('[data-cloud=claude] .ai-key-msg')?.textContent || ''));
  await page.fill('#aiKey-claude', 'claude-key');
  if (SHOTS) { await page.locator('#aiKey-claude').scrollIntoViewIfNeeded(); await page.screenshot({ path: join(SHOTS, 'ai-settings-claude.png') }); }
  await page.click('[data-m=ok]');
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Settings saved'));
  const keys = await page.evaluate(() => chrome.storage.local.get(['aiGeminiKey', 'aiClaudeKey']));
  assert.deepEqual(keys, { aiGeminiKey: 'good-key', aiClaudeKey: 'claude-key' }, 'each cloud keeps its own key');
  await page.hover('.tab:has-text("/alpha")');
  await page.click('.tab:has-text("/alpha") [data-act=ai-tab]');
  await page.waitForSelector('#modal:not([hidden]) :text("Send page content to Anthropic Claude?")');
  await page.click('[data-m=ok]');
  await waitLine(page, '/alpha', /^A cloud tab sentence from Claude\.$/);
  assert.match(await page.textContent('.tab:has-text("/alpha") .ai-st'), /Idle/);
  assert.match(await page.getAttribute('.tab:has-text("/alpha") .ai-sum', 'title'), /Claude · cloud/);
  f = await page.evaluate(() => window.__ai.fetches.at(-1));
  assert.equal(f.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(f.headers['x-api-key'], 'claude-key');
  assert.equal(f.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.ok(f.headers['anthropic-version']);
  assert.equal(f.body.model, 'claude-haiku-5-5');
  assert.equal(f.body.stream, true);
  assert.deepEqual(f.body.output_config.format.schema.required, ['facts', 'summary', 'status']);
  assert.match(f.body.messages[0].content, /purple-otter/);
  // Group sentence from Claude too, labeled as Claude.
  await page.click('[data-act=ai-group]');
  await page.waitForFunction(() => /^This group is about Claude testing\.$/.test(document.querySelector('[data-sum^="group:"] .ai-gtext')?.textContent || ''));
  assert.match(await page.textContent('[data-sum^="group:"]'), /Claude · cloud/);
  saved = (await page.evaluate(() => chrome.storage.local.get('aiSettings'))).aiSettings;
  assert.ok(saved.claudeConsentAt > 0 && saved.cloudConsentAt > 0);
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'ai-claude.png') });
  step('Claude Haiku as the cloud: own key and consent, tab summary + status and group sentence from the Claude API');
  // Back to Gemini for the rest of the test.
  await page.click('#settingsBtn');
  await page.check('input[name=aiCloud][value=gemini]');
  await page.click('[data-m=ok]');
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Settings saved'));

  // Rename keeps the group's instructions.
  await page.click('[data-act=rename]');
  await page.fill('#renameInput', 'Deep research');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Deep research');
  await page.waitForFunction(async () => (await chrome.storage.local.get('aiSettings')).aiSettings.groups['deep research']);
  step('renaming a group keeps its AI instructions');

  await page.keyboard.press('Control+k');
  await page.fill('#palInput', '>summarize');
  await page.waitForSelector('.pal-item:has-text("Summarize")');
  await page.keyboard.press('Escape');
  step('palette lists Summarize');

  // Prompt log: every prompt and answer is kept in the extension, readable from the DevTools console.
  const log = await page.evaluate(() => window.tabDeskAiLog());
  const kinds = new Set(log.map(e => `${e.kind}/${e.engine}`));
  for (const k of ['tab/local', 'group/local', 'draft/local', 'group/cloud', 'tab/cloud']) assert.ok(kinds.has(k), `log has ${k}`);
  assert.ok(log.some(e => e.engine === 'cloud' && e.cloud === 'claude' && e.model === 'claude-haiku-5-5'), 'Claude calls are logged with their model');
  const lt = log.find(e => e.kind === 'tab' && e.engine === 'local' && /\/pr\/5/.test(e.url));
  assert.match(lt.system, /Reply with JSON only, in this order/);
  assert.match(lt.user, /^Instructions for this page:\nPR rule/);
  assert.match(lt.output, /"summary"/);
  const ct = log.findLast(e => e.kind === 'tab' && e.engine === 'cloud' && /\/pr\/5/.test(e.url));
  assert.match(ct.system, /Instructions for this page:\nPR rule/);
  assert.ok(ct.model);
  assert.ok(log.length <= 30);
  assert.ok(!JSON.stringify(log).includes('good-key') && !JSON.stringify(log).includes('claude-key'), 'the API keys are never logged');
  const one = await page.evaluate(n => window.tabDeskAiLog(n), log.indexOf(ct));
  assert.equal(one.at, ct.at);
  await page.evaluate(() => window.tabDeskAiLog.clear());
  assert.equal((await page.evaluate(() => window.tabDeskAiLog())).length, 0);
  step('every prompt and answer is logged in the extension (tabDeskAiLog() in the console), never the API key');

  // Page fields and status rules: read specific values from any site, decide the status in code.
  const p3 = await ctx.newPage();
  await p3.goto(U('/issue/7'));
  await page.bringToFront();
  await page.click('#settingsBtn');
  await page.click('[role=tab][data-tab=instructions]');
  assert.equal(await page.isChecked('#aiPresets'), true, 'built-in GitHub fields are on by default');
  await page.click('#aiAddRule');
  const fr = page.locator('.ai-rule:last-child');
  await fr.locator('.ai-rule-pat').fill(`localhost:${port}/issue/*`);
  await fr.locator('.ai-fields > summary').click();
  assert.equal(await fr.locator('.ai-fields .ai-hint').isVisible(), false, 'help text is hidden until (i) is pressed');
  await fr.locator('.ai-fields .ai-info').click();
  assert.match(await fr.locator('.ai-fields .ai-hint').textContent(), /decide the status from them without the AI/);
  await fr.locator('.ai-rule-fields').fill('viewer: meta[name="user-login"] @content\nstate: .State\nassignee: label: Assignee\nmissing: .nope');
  await fr.locator('.ai-rule-status').fill('idle when state matches /closed|merged/\nneed action when assignee has {viewer}\nai otherwise');
  await fr.locator('[data-m=ftest]').click();
  await page.waitForFunction(() => /Need action/.test(document.querySelector('.ai-rule:last-child .ai-fields-out')?.textContent || ''));
  const out = await fr.locator('.ai-fields-out').textContent();
  assert.match(out, /viewerme-user/);
  assert.match(out, /stateOpen/);
  assert.match(out, /assigneeme-user/, 'label: reads the value next to a label');
  assert.match(out, /missingnot found/);
  assert.match(out, /rule 2/);
  if (SHOTS) { await fr.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(SHOTS, 'ai-page-fields.png') }); }
  // A bad line is flagged and blocks saving.
  await fr.locator('.ai-rule-status').fill('soon when state is open');
  await page.waitForSelector('.ai-rule:last-child .ai-fields-out .ai-bad');
  await page.click('[data-m=ok]');
  await page.waitForFunction(() => /Status rules, line 1/.test(document.querySelector('.toast')?.textContent || ''));
  await fr.locator('.ai-rule-status').fill('idle when state matches /closed|merged/\nneed action when assignee has {viewer}\nai otherwise');
  await page.click('[data-m=ok]');
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('Settings saved'));
  saved = (await page.evaluate(() => chrome.storage.local.get('aiSettings'))).aiSettings;
  const fRule = saved.rules.find(r => r.pattern.includes('/issue/'));
  assert.equal(fRule.instructions, '', 'a rule can have page fields and no instructions');
  assert.match(fRule.fields, /assignee: label: Assignee/);
  await page.click('[data-nav=inbox]');
  await page.hover('.tab:has-text("/issue/7")');
  await page.click('.tab:has-text("/issue/7") [data-act=ai-tab]');
  await waitLine(page, '/issue/7', /^A cloud tab sentence from Gemini\.$/);
  assert.match(await page.textContent('.tab:has-text("/issue/7") .ai-st'), /Need action/, 'status from the rules, not the AI’s "waiting"');
  assert.match(await page.getAttribute('.tab:has-text("/issue/7") .ai-st', 'title'), /from page fields[\s\S]*state: Open · assignee: me-user/);
  f = await page.evaluate(() => window.__ai.fetches.at(-1));
  assert.deepEqual(f.body.generationConfig.responseSchema.required, ['summary'], 'the AI is asked for the sentence only');
  assert.match(f.body.contents[0].parts[0].text, /State: state: Open · assignee: me-user\nStatus: Need action/);
  assert.ok(f.body.contents[0].parts[0].text.length < 4000, 'only a short excerpt is sent');
  step('page fields on any site: Test shows each value and the status; the status comes from the rules and the AI only writes the sentence');

  // Turning AI off hides lines, statuses and buttons.
  await page.click('#settingsBtn');
  await page.click('[role=tab][data-tab=general]');
  await page.uncheck('#aiEnabled');
  await page.click('[data-m=ok]');
  // On the Inbox there is no group button, so wait for the tab lines and statuses themselves to go.
  await page.waitForFunction(() => !document.querySelector('[data-act=ai-group], .ai-line, .ai-st, [data-act=ai-tab]'), null, { timeout: 5000 });
  step('turning AI summaries off hides summaries, statuses and buttons');

  assert.deepEqual(errors, []);
  step('no page errors');
  console.log('\nAI smoke test passed.');
} finally {
  await ctx.close();
  server.close();
}
