// End-to-end smoke test for AI summaries. Loads the extension in Chromium with Playwright.
// Headless Chromium has no on-device model and we don't want real Gemini calls, so the page gets
// a fake `Summarizer` and a fake Gemini endpoint. Everything else (permissions, page reading,
// caching, settings, instructions, the UI) is the real code.
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

const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  const body = req.url === '/long'
    ? `<article><h1>Long read</h1>${Array.from({ length: 40 }, (_, i) => `<p>Paragraph ${i} ${'lorem ipsum '.repeat(30)}</p>`).join('')}</article>`
    : `<nav>Site menu</nav><main><h1>${req.url}</h1><p>The secret phrase on ${req.url} is purple-otter.</p></main><footer>Footer</footer>`;
  res.end(`<!doctype html><html lang="en"><title>Page ${req.url}</title>${body}`);
}).listen(0);
const port = server.address().port;
const U = p => `http://localhost:${port}${p}`;

// Injected into every page before its scripts run. Only acts on the extension page.
function fakes() {
  if (location.protocol !== 'chrome-extension:') return;
  window.__ai = { calls: [], fetches: [] };
  const state = { avail: 'downloadable' };
  window.__ai.state = state;
  class FakeSummarizer {
    constructor(o) { this.o = o; this.inputQuota = 1500; }
    static async availability() { return state.avail; }
    static async create(o) {
      if (state.avail !== 'available' && !navigator.userActivation.isActive) throw new DOMException('needs a click', 'NotAllowedError');
      for (const f of [0.25, 0.5, 1]) o.monitor?.({ addEventListener: (_, cb) => cb({ loaded: f, total: 1 }) });
      state.avail = 'available';
      return new FakeSummarizer(o);
    }
    async measureInputUsage(t) { return Math.ceil(t.length / 4); }
    async summarize(text, { context } = {}) {
      window.__ai.calls.push({ type: this.o.type, sharedContext: this.o.sharedContext, text, context });
      return `TLDR(${text.length})`;
    }
    async *summarizeStreaming(text, opts) {
      const out = await this.summarize(text, opts);
      const secret = /purple-otter/.test(text) ? 'mentions purple-otter' : 'no page text';
      yield `- Local summary: ${secret}\n`;
      yield `- ${this.o.type}, ${out}`;
    }
    destroy() {}
  }
  window.Summarizer = FakeSummarizer;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://generativelanguage.googleapis.com/')) {
      window.__ai.fetches.push({ url: String(url), headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
      if (init.headers?.['x-goog-api-key'] === 'bad') return new Response(JSON.stringify({ error: { message: 'API key not valid.' } }), { status: 400 });
      if (String(url).includes('/models?')) return new Response('{"models":[]}', { status: 200 });
      const ev = t => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }] } }] })}\n\n`;
      return new Response(ev('This group is about **testing**.\n\n') + ev('- Theme one\n- Theme two'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return realFetch(url, init);
  };
}

async function launch(ext) {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'tabdesk-ai-')), {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    viewport: { width: 1280, height: 860 },
  });
  await ctx.addInitScript(fakes);
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  return { ctx, extId: new URL(sw.url()).host };
}

async function openDesk(ctx, extId, errors) {
  for (const u of [U('/alpha'), U('/beta'), U('/long')]) { const p = await ctx.newPage(); await p.goto(u); }
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`chrome-extension://${extId}/dashboard.html`);
  await page.evaluate(async base => {
    const tabs = await chrome.tabs.query({});
    const ids = ['/alpha', '/beta', '/long'].map(p => tabs.find(t => t.url === base + p).id);
    const g = await chrome.tabs.group({ tabIds: ids });
    await chrome.tabGroups.update(g, { title: 'Research', color: 'purple' });
  }, `http://localhost:${port}`);
  await page.waitForSelector('[data-nav=group]');
  await page.click('[data-nav=group]:has-text("Research")');
  await page.waitForSelector('[data-act=ai-group]');
  return page;
}

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
    await page.waitForSelector('[data-sum^="tab:"] .ai-text');
    const card = await page.textContent('[data-sum^="tab:"]');
    assert.match(card, /no page text/);
    assert.match(card, /title and address only/);
    assert.match(card, /On-device/);
    step('“Use titles only” summarizes from the title, says so, and is labeled On-device');
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

  // Settings: general + group instructions.
  await page.click('#aiSettingsBtn');
  await page.waitForSelector('.ai-settings');
  assert.match(await page.textContent('.ai-settings'), /Download/);
  await page.fill('#aiGeneral', 'Write in Vietnamese.');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'ai-settings.png') });
  await page.click('[data-m=ok]');
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('AI settings saved'));
  step('save general instructions in AI settings');

  await page.click('[data-act=group-more]');
  await page.click('.menu button:has-text("AI instructions")');
  await page.fill('#aiGroupInstr', 'Focus on the secret phrase.');
  await page.click('[data-m=ok]');
  await page.waitForSelector('.ai-instr-chip');
  const saved = await page.evaluate(() => chrome.storage.local.get('aiSettings'));
  assert.equal(saved.aiSettings.general, 'Write in Vietnamese.');
  assert.deepEqual(saved.aiSettings.groups, { research: 'Focus on the secret phrase.' });
  step('save per-group instructions from the group menu');

  // Tab summary on-device: reads the page, downloads the model on first use, passes instructions.
  await page.hover('.tab:has-text("/alpha")');
  await page.click('.tab:has-text("/alpha") [data-act=ai-tab]');
  await page.waitForFunction(() => /mentions purple-otter/.test(document.querySelector('[data-sum^="tab:"] .ai-text')?.textContent || ''));
  const call = await page.evaluate(() => window.__ai.calls.at(-1));
  assert.match(call.sharedContext, /Write in Vietnamese\.\nFocus on the secret phrase\./);
  assert.doesNotMatch(call.text, /Site menu|Footer/);
  step('tab summary reads the page text (without nav/footer), on-device, with general + group instructions');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'ai-tab.png') });

  // Cached on the second run.
  const n = await page.evaluate(() => window.__ai.calls.length);
  await page.click('[data-sum^="tab:"] [data-act=ai-dismiss]');
  await page.hover('.tab:has-text("/alpha")');
  await page.click('.tab:has-text("/alpha") [data-act=ai-tab]');
  await page.waitForSelector('[data-sum^="tab:"] .ai-when:text("Saved summary")');
  assert.equal(await page.evaluate(() => window.__ai.calls.length), n);
  step('second summary of the same page comes from the cache');

  // Long page is split and summarized in parts.
  await page.hover('.tab:has-text("/long")');
  await page.click('.tab:has-text("/long") [data-act=ai-tab]');
  await page.waitForFunction(() => document.querySelectorAll('[data-sum^="tab:"] .ai-text').length === 2);
  const tl = await page.evaluate(() => window.__ai.calls.filter(c => c.type === 'tldr').length);
  assert.ok(tl >= 2, `expected chunked tldr calls, got ${tl}`);
  step('long pages are split and summarized in parts');

  // Group summary on-device (no key yet).
  await page.click('[data-act=ai-group]');
  await page.waitForSelector('[data-sum^="group:"] .ai-text');
  assert.match(await page.textContent('[data-sum^="group:"]'), /On-device/);
  step('group summary works on-device without a key');

  // Add a Gemini key: bad key is rejected by Test, good key saved.
  await page.click('#aiSettingsBtn');
  await page.fill('#aiKey', 'bad');
  await page.click('#aiKeyTest');
  await page.waitForSelector('#aiKeyMsg .ai-bad');
  await page.fill('#aiKey', 'good-key');
  await page.click('#aiKeyTest');
  await page.waitForSelector('#aiKeyMsg .ai-ok');
  await page.click('[data-m=ok]');
  await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('AI settings saved'));
  const stored = await page.evaluate(() => chrome.storage.local.get(null));
  assert.equal(stored.aiGeminiKey, 'good-key');
  step('Gemini key: Test rejects a bad key, accepts a good one, and Save stores it locally');

  // Group summary now goes to Gemini, after consent.
  await page.click('[data-sum^="group:"] [data-act=ai-refresh]');
  await page.waitForSelector('#modal:not([hidden]) :text("Send page content to Google Gemini?")');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'ai-consent.png') });
  await page.click('[data-m=ok]');
  await page.waitForFunction(() => /testing/.test(document.querySelector('[data-sum^="group:"] .ai-text')?.textContent || ''));
  const g = await page.textContent('[data-sum^="group:"]');
  assert.match(g, /Gemini · cloud/);
  assert.match(g, /Theme two/);
  const f = await page.evaluate(() => window.__ai.fetches.at(-1));
  assert.equal(f.headers['x-goog-api-key'], 'good-key');
  assert.doesNotMatch(f.url, /good-key/);
  assert.match(f.body.systemInstruction.parts[0].text, /Write in Vietnamese\.\nFocus on the secret phrase\./);
  assert.match(f.body.contents[0].parts[0].text, /purple-otter/);
  step('group summary asks for consent once, then streams from Gemini with the instructions, key in a header');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'ai-group.png') });

  // Rename keeps the group's instructions.
  await page.click('[data-act=rename]');
  await page.fill('#renameInput', 'Deep research');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Deep research');
  await page.waitForFunction(async () => (await chrome.storage.local.get('aiSettings')).aiSettings.groups['deep research']);
  step('renaming a group keeps its AI instructions');

  // Palette command.
  await page.keyboard.press('Control+k');
  await page.fill('#palInput', '>summarize');
  await page.waitForSelector('.pal-item:has-text("Summarize")');
  await page.keyboard.press('Escape');
  step('palette lists Summarize');

  // Dashboard cards: the group summary shows on the card, and cards can summarize groups and tabs.
  await page.click('[data-nav=dashboard]');
  await page.waitForSelector('.card:has-text("Deep research") [data-sum^="group:"] .ai-text');
  step('a group summary made on the detail page also shows on its dashboard card');
  await page.click('.card [data-sum^="group:"] [data-act=ai-dismiss]');
  await page.waitForFunction(() => !document.querySelector('.card [data-sum^="group:"]'));
  await page.click('.card:has-text("Deep research") [data-act=ai-group]');
  await page.waitForFunction(() => /Theme two/.test(document.querySelector('.card [data-sum^="group:"] .ai-text')?.textContent || ''));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'ai-dashboard.png') });
  step('Summarize on a dashboard card puts the group summary in the card');
  await page.hover('.card-tab:has-text("/beta")');
  await page.click('.card-tab:has-text("/beta") [data-act=ai-tab]');
  await page.waitForSelector('.card-tabs [data-sum^="tab:"] .ai-text');
  step('summarize a single tab from its dashboard card');
  await page.click('.card:has-text("Deep research") [data-act=card-more]');
  assert.ok(await page.isVisible('.menu button:has-text("AI instructions")'));
  await page.keyboard.press('Escape');
  step('card menu offers the group’s AI instructions');

  // Turning AI off hides the buttons.
  await page.click('#aiSettingsBtn');
  await page.uncheck('#aiEnabled');
  await page.click('[data-m=ok]');
  await page.waitForFunction(() => !document.querySelector('[data-act=ai-group]'));
  assert.equal(await page.$$eval('[data-act=ai-tab]', n => n.length), 0);
  step('turning AI summaries off hides the buttons');

  assert.deepEqual(errors, []);
  step('no page errors');
  console.log('\nAI smoke test passed.');
} finally {
  await ctx.close();
  server.close();
}
