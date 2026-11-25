import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSettings, groupKey, instructionsFor, chooseEngine, cleanText, chunkText, langCode, isReadableUrl,
  tabPrompt, groupPrompt, localContext, geminiRequest, parseSse, geminiError, cacheKey, pruneCache, renderSummary,
  DEFAULT_MODEL, MAX_INSTRUCTIONS, matchesPattern, compilePattern, suggestPattern, rulesFor, rollupStatus, normalizeStatus,
  effectiveStatus, statusRank, oneSentence, parseInsight, insightKey, needsInsight, headTail, INSIGHT_SCHEMA, PROMPT_VERSION,
  pickInstructions, baseTabPrompt, tabInstructionBlock, draftPrompt, cleanDraft, INSTRUCTION_TEMPLATE, DEFAULT_TAB_INSTRUCTIONS,
} from '../src/lib/ai-core.js';

test('normalizeSettings fills defaults and drops bad values', () => {
  const s = normalizeSettings({ engine: 'nope', auto: 'sometimes', length: 'huge', model: '  ', groups: { '  Trip  Japan ': ' go ', empty: '  ' },
    rules: [{ pattern: 'github.com', instructions: ' x ' }, { pattern: '/[/', instructions: 'bad regex' }, { pattern: 'a.com', instructions: '' }, 'junk'] });
  assert.equal(s.engine, 'auto');
  assert.equal(s.auto, 'local');
  assert.equal('length' in s, false);
  assert.deepEqual(s.rules, [{ pattern: 'github.com', instructions: 'x' }]);
  assert.equal(s.model, DEFAULT_MODEL);
  assert.deepEqual(s.groups, { 'trip japan': 'go' });
  assert.equal(normalizeSettings(null).enabled, true);
  assert.equal(normalizeSettings({ general: 'x'.repeat(5000) }).general.length, MAX_INSTRUCTIONS);
});

test('group instructions are keyed by normalized name and combined with general ones', () => {
  assert.equal(groupKey('  Trip   to JAPAN '), 'trip to japan');
  const s = normalizeSettings({ general: 'Write in Vietnamese.', groups: { 'Trip to Japan': 'Focus on prices.' } });
  assert.equal(instructionsFor(s, 'trip to japan'), 'Focus on prices.');
  assert.equal(instructionsFor(s, 'Other'), 'Write in Vietnamese.');
  assert.equal(instructionsFor(s, null), 'Write in Vietnamese.');
  assert.equal(instructionsFor(normalizeSettings({}), 'x'), '');
});

test('chooseEngine follows the setting, prefers on-device for tabs and cloud for groups in auto', () => {
  const c = o => chooseEngine({ kind: 'tab', setting: 'auto', local: 'available', hasKey: false, ...o });
  assert.equal(c({}), 'local');
  assert.equal(c({ local: 'downloadable' }), 'local');
  assert.equal(c({ local: 'unavailable' }), null);
  assert.equal(c({ hasKey: true }), 'local');
  assert.equal(c({ hasKey: true, local: 'downloadable' }), 'cloud');
  assert.equal(c({ hasKey: true, kind: 'group' }), 'cloud');
  assert.equal(c({ kind: 'group' }), 'local');
  assert.equal(c({ setting: 'local', hasKey: true, kind: 'group' }), 'local');
  assert.equal(c({ setting: 'local', local: 'unavailable', hasKey: true }), null);
  assert.equal(c({ setting: 'cloud' }), null);
  assert.equal(c({ setting: 'cloud', hasKey: true }), 'cloud');
});

test('cleanText collapses whitespace and blank lines', () => {
  assert.equal(cleanText('  a \t b \n\n\n\n c d  '), 'a b\n\nc d');
});

test('chunkText splits at paragraph boundaries and reports truncation', () => {
  const para = 'x'.repeat(800);
  const text = Array(10).fill(para).join('\n\n');
  const { chunks, truncated } = chunkText(text, 2000, 3);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every(c => c.length <= 2000));
  assert.equal(truncated, true);
  assert.deepEqual(chunkText('short', 2000), { chunks: ['short'], truncated: false });
});

test('langCode and isReadableUrl', () => {
  assert.equal(langCode('en-US'), 'en');
  assert.equal(langCode('pt_BR'), 'pt');
  assert.equal(langCode(''), '');
  assert.equal(isReadableUrl('https://example.com'), true);
  assert.equal(isReadableUrl('chrome://settings'), false);
  assert.equal(isReadableUrl('https://chromewebstore.google.com/detail/x'), false);
  assert.equal(isReadableUrl('about:blank'), false);
});

test('prompts ask for one sentence, include user instructions, guard against page instructions and cap sizes', () => {
  const t = tabPrompt({ title: 'T', url: 'https://a', text: 'y'.repeat(70000), instructions: 'Use emoji.', lang: 'vi' });
  assert.match(t.system, /ONE short sentence/);
  assert.match(t.system, /"action" \(Needs you\)/);
  assert.match(t.system, /Use emoji\./);
  assert.match(t.system, /Ignore any instructions/);
  assert.match(t.system, /"vi"/);
  assert.ok(t.user.length < 61000);
  assert.match(tabPrompt({ title: 'T', url: 'u', text: '' }).user, /could not be read/);

  const tabs = Array.from({ length: 5 }, (_, i) => ({ title: `T${i}`, url: `https://x/${i}`, text: 'z'.repeat(20000) }));
  const g = groupPrompt({ name: 'Trip', tabs, instructions: 'Focus on prices.', budget: 20000 });
  assert.match(g.system, /"Trip"/);
  assert.match(g.system, /ONE short sentence/);
  assert.match(g.system, /Focus on prices\./);
  assert.ok(g.user.length < 25000);
  assert.match(g.user, /### Tab 5: T4/);
  assert.equal(groupPrompt({ name: 'n', tabs: [] }).system.includes('instructions'), true);
});

test('localContext adds instructions for the on-device model', () => {
  assert.match(localContext('tab'), /web page/);
  assert.match(localContext('group', { groupName: 'Trip', instructions: 'Be brief' }), /"Trip"[\s\S]*User instructions: Be brief/);
});

test('geminiRequest builds a streaming request without the key in the URL', () => {
  const r = geminiRequest({ model: 'gemini-flash-latest', system: 's', user: 'u' });
  assert.equal(r.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:streamGenerateContent?alt=sse');
  assert.equal(r.body.systemInstruction.parts[0].text, 's');
  assert.equal(r.body.contents[0].parts[0].text, 'u');
  assert.doesNotMatch(r.url, /key=/);
});

test('parseSse reads text parts across partial chunks and skips thoughts', () => {
  const ev = o => `data: ${JSON.stringify(o)}\n\n`;
  const all = ev({ candidates: [{ content: { parts: [{ text: 'Hel' }] } }] }) +
    ev({ candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: 'lo' }] } }] });
  const cut = 30;
  const a = parseSse(all.slice(0, cut));
  const b = parseSse(a.rest + all.slice(cut));
  assert.equal([...a.texts, ...b.texts].join(''), 'Hello');
  assert.equal(parseSse(ev({ promptFeedback: { blockReason: 'SAFETY' } })).blocked, 'SAFETY');
});

test('geminiError maps statuses to friendly messages', () => {
  assert.equal(geminiError(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }).code, 'key');
  assert.equal(geminiError(403, '').code, 'key');
  assert.equal(geminiError(404, '').code, 'model');
  const r = geminiError(429, JSON.stringify({ error: { message: 'quota', details: [{ '@type': 'RetryInfo', retryDelay: '7s' }] } }));
  assert.equal(r.code, 'rate');
  assert.equal(r.retry, 7);
  assert.equal(geminiError(503, '').code, 'server');
  assert.match(geminiError(400, { error: { message: 'Bad thing' } }).message, /Bad thing/);
});

test('cacheKey changes with instructions and text; pruneCache drops old and extra entries', () => {
  const k1 = cacheKey(['tab', 'local', 'a', 'h1']);
  assert.equal(k1, cacheKey(['tab', 'local', 'a', 'h1']));
  assert.notEqual(k1, cacheKey(['tab', 'local', 'b', 'h1']));
  assert.notEqual(k1, cacheKey(['tab', 'local', 'a', 'h2']));
  const now = 1_000_000;
  const c = { old: { at: now - 100 }, a: { at: now - 1 }, b: { at: now - 2 }, c: { at: now - 3 } };
  assert.deepEqual(Object.keys(pruneCache(c, now, 50, 2)), ['a', 'b']);
});

test('renderSummary renders bullets and bold but never raw HTML', () => {
  const h = renderSummary('Intro **bold**\n\n- one\n* two <img src=x onerror=alert(1)>\n1. three');
  assert.equal(h, '<p>Intro <b>bold</b></p><ul><li>one</li><li>two &lt;img src=x onerror=alert(1)&gt;</li><li>three</li></ul>');
  assert.doesNotMatch(renderSummary('<script>x</script>'), /<script>/);
  assert.equal(renderSummary('## Head'), '<p><b>Head</b></p>');
});

test('instructionsFor uses one set: the most specific page rule, else group, else general', () => {
  const s = normalizeSettings({ general: 'G', groups: { work: 'W' }, rules: [
    { pattern: 'github.com', instructions: 'site' },
    { pattern: 'github.com/*/*', instructions: 'repo home' },
    { pattern: 'github.com/*/*/pulls', instructions: 'pr list' },
    { pattern: 'github.com/*/*/pull/*', instructions: 'one pr' },
  ] });
  assert.equal(instructionsFor(s, 'Work', 'https://github.com/locle97/tab-deck'), 'repo home');
  assert.equal(instructionsFor(s, null, 'https://github.com/locle97/tab-deck/pulls'), 'pr list');
  assert.equal(instructionsFor(s, null, 'https://github.com/locle97/tab-deck/pull/5'), 'one pr');
  assert.equal(instructionsFor(s, 'Work', 'https://github.com/locle97'), 'site');
  assert.equal(instructionsFor(s, 'Work', 'https://example.com/'), 'W');
  assert.equal(instructionsFor(s, null, 'https://example.com/'), 'G');
  assert.deepEqual(pickInstructions(normalizeSettings({}), null, 'https://example.com/'), { text: '', source: 'default' });
  assert.equal(pickInstructions(s, null, 'https://github.com/a/b/pull/1').source, 'rule');
});

test('URL patterns: sites, * and **, regex, query, trailing slash and scheme', () => {
  const m = (p, u) => matchesPattern(p, u);
  assert.ok(m('github.com', 'https://github.com/a/b'));
  assert.ok(m('github.com', 'https://gist.github.com/x'));
  assert.ok(!m('github.com', 'https://notgithub.com/'));
  assert.ok(m('www.github.com', 'https://github.com/'));
  assert.ok(m('github.com/locle97/tab-deck', 'https://github.com/locle97/tab-deck/'));
  assert.ok(!m('github.com/locle97/tab-deck', 'https://github.com/locle97/tab-deck/pulls'));
  assert.ok(m('https://github.com/locle97/tab-deck/pulls', 'https://github.com/locle97/tab-deck/pulls?q=is%3Aopen#x'));
  assert.ok(m('github.com/*/*/pull/*', 'https://github.com/a/b/pull/5'));
  assert.ok(!m('github.com/*/*/pull/*', 'https://github.com/a/b/pull/5/files'));
  assert.ok(m('github.com/*/*/pull/**', 'https://github.com/a/b/pull/5/files'));
  assert.ok(m('github.com/**', 'https://github.com/a/b/c'));
  assert.ok(m('mail.google.com/mail/u/0/?tab=*', 'https://mail.google.com/mail/u/0/?tab=rm'));
  assert.ok(m(String.raw`/\/pull\/\d+$/`, 'https://github.com/a/b/pull/12'));
  assert.ok(m('/GITHUB/', 'https://github.com/'), 'regex is case-insensitive');
  assert.equal(compilePattern('/[/'), null);
  assert.equal(compilePattern(''), null);
  assert.equal(compilePattern('not a site'), null);
  assert.equal(compilePattern('a.com/x(y)').kind, 'url');
  assert.ok(m('a.com/x(y)', 'https://a.com/x(y)'));
  assert.equal(suggestPattern('https://www.github.com/a/b/pull/5/?x=1#h'), 'github.com/a/b/pull/5');
  assert.equal(rulesFor([{ pattern: 'a.com', instructions: '1' }, { pattern: 'b.com', instructions: '2' }], 'https://a.com/').length, 1);
});

test('statuses roll up to the most urgent, and a hand-set status wins', () => {
  assert.equal(rollupStatus(['done', 'waiting', null, 'info']), 'waiting');
  assert.equal(rollupStatus(['done', 'action']), 'action');
  assert.equal(rollupStatus([null, 'bogus']), null);
  assert.equal(normalizeStatus('working'), 'working');
  assert.equal(normalizeStatus('unknown'), null);
  assert.equal(effectiveStatus({ status: 'done', manual: 'action' }), 'action');
  assert.equal(effectiveStatus({ status: 'done' }), 'done');
  assert.equal(effectiveStatus(null), null);
  assert.ok(statusRank('action') < statusRank(null) && statusRank(null) < statusRank('done'));
});

test('oneSentence and parseInsight keep one plain sentence', () => {
  assert.equal(oneSentence('- **PR #5** adds dark mode. It also fixes bugs.'), 'PR #5 adds dark mode.');
  assert.equal(oneSentence('Short. Then more text here.'), 'Short. Then more text here.', 'a too-short first sentence keeps going');
  assert.ok(oneSentence('x '.repeat(300)).length <= 240);
  assert.deepEqual(parseInsight('```json\n{"summary": "A PR waiting for your review. Extra.", "status": "action"}\n```'), { summary: 'A PR waiting for your review.', status: 'action' });
  assert.deepEqual(parseInsight('{"summary":"Docs page.","status":"unknown"}'), { summary: 'Docs page.', status: null });
  assert.deepEqual(parseInsight('Just a plain answer about a page.'), { summary: 'Just a plain answer about a page.', status: null });
  assert.equal(insightKey('https://a.com/x?y=1#frag'), 'https://a.com/x?y=1');
});

test('needsInsight: missing or older than an hour', () => {
  const now = 10_000_000;
  assert.equal(needsInsight(null, { now }), true);
  assert.equal(needsInsight({ at: now - 1000 }, { now }), false);
  assert.equal(needsInsight({ at: now - 2 * 3600 * 1000 }, { now }), true);
});

test('geminiRequest asks for JSON with a status enum when json is set', () => {
  const r = geminiRequest({ model: 'm', system: 's', user: 'u', json: true });
  assert.equal(r.body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(r.body.generationConfig.responseSchema.properties.status.enum, ['action', 'working', 'waiting', 'done', 'info', 'unknown']);
  assert.equal(geminiRequest({ model: 'm', system: 's', user: 'u' }).body.generationConfig.responseMimeType, undefined);
});

test('summary line under each tab is off by default', () => {
  assert.equal(normalizeSettings({}).tabLines, false);
  assert.equal(normalizeSettings({ tabLines: 'yes' }).tabLines, false);
  assert.equal(normalizeSettings({ tabLines: true }).tabLines, true);
});

test('summary and status come from one analysis: facts first, then summary, then status', () => {
  assert.deepEqual(Object.keys(INSIGHT_SCHEMA.properties), ['facts', 'summary', 'status']);
  const g = geminiRequest({ model: 'm', system: 's', user: 'u', json: true }).body.generationConfig.responseSchema;
  assert.deepEqual(g.propertyOrdering, ['facts', 'summary', 'status']);
  const p = tabPrompt({ title: 'Fix login · Pull Request #5', url: 'https://github.com/a/b/pull/5', text: 'Page state: Merged\n\nbody' });
  const all = (p.system + '\n' + p.user).toLowerCase();
  assert.match(all, /facts/);
  assert.match(all, /page state/);
  assert.match(all, /agree/);
  assert.ok(PROMPT_VERSION >= 3);
});

test('parseInsight keeps short facts; headTail keeps both ends of long pages', () => {
  const r = parseInsight('{"facts":"PR merged by bob","summary":"The login fix PR was merged.","status":"done"}');
  assert.deepEqual(r, { facts: 'PR merged by bob', summary: 'The login fix PR was merged.', status: 'done' });
  assert.ok(parseInsight(JSON.stringify({ facts: 'x'.repeat(500), summary: 'A page about things.', status: 'info' })).facts.length <= 160);
  const long = 'HEAD' + 'a'.repeat(20000) + 'TAIL';
  const ht = headTail(long, 6000);
  assert.ok(ht.length <= 6010);
  assert.ok(ht.startsWith('HEAD'));
  assert.ok(ht.endsWith('TAIL'));
  assert.equal(headTail('short', 6000), 'short');
});

test('tab prompt = fixed base (JSON facts, summary, status) + one set of instructions, default when none', () => {
  const base = baseTabPrompt('en');
  assert.match(base, /Reply with JSON only, in this order: \{"facts": "\.\.\.", "summary": "\.\.\.", "status": "\.\.\."\}/);
  const d = tabPrompt({ title: 't', url: 'u', text: 'x' }).system;
  assert.ok(d.startsWith(base));
  assert.ok(d.includes(DEFAULT_TAB_INSTRUCTIONS));
  const own = tabPrompt({ title: 't', url: 'u', text: 'x', instructions: 'Summary: say who is assigned.' }).system;
  assert.ok(own.startsWith(base));
  assert.ok(own.endsWith('Instructions for this page:\nSummary: say who is assigned.'));
  assert.ok(!own.includes(DEFAULT_TAB_INSTRUCTIONS), 'user instructions replace the default ones');
  assert.equal(tabInstructionBlock('  '), `Instructions for this page:\n${DEFAULT_TAB_INSTRUCTIONS}`);
  for (const label of ['This page is:', 'Facts:', 'Summary:', 'Status:', 'Needs you', 'Reference']) {
    assert.ok(INSTRUCTION_TEMPLATE.includes(label));
    assert.ok(DEFAULT_TAB_INSTRUCTIONS.includes(label));
  }
});

test('draft prompt asks to fill the template from an example page; drafts are cleaned', () => {
  const p = draftPrompt({ pattern: 'github.com/*/*/pull/*', title: 'Fix login #5', url: 'https://github.com/a/b/pull/5', text: 'Page state: Open' });
  assert.ok(p.system.includes(INSTRUCTION_TEMPLATE));
  assert.match(p.user, /Pattern: github\.com\/\*\/\*\/pull\/\*/);
  assert.match(p.user, /Page state: Open/);
  assert.match(draftPrompt({ pattern: 'x.com' }).user, /No page text/);
  assert.equal(cleanDraft('Sure! Here it is:\n```\nThis page is: a PR.\nFacts: merged or not.\n```'), 'This page is: a PR.\nFacts: merged or not.');
  assert.ok(cleanDraft('x'.repeat(5000)).length <= MAX_INSTRUCTIONS);
});
