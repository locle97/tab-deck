import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSettings, groupKey, instructionsFor, chooseEngine, cleanText, chunkText, langCode, isReadableUrl,
  tabPrompt, groupPrompt, localContext, geminiRequest, parseSse, geminiError, cacheKey, pruneCache, renderSummary,
  DEFAULT_MODEL, MAX_INSTRUCTIONS, matchesPattern, compilePattern, suggestPattern, rulesFor, rollupStatus, normalizeStatus,
  effectiveStatus, statusRank, oneSentence, parseInsight, insightKey, staleCheck, addMark, nextRefreshAt, stableTitle, stableText, contentSig, REFRESH, EVERY_DEFAULT, headTail, INSIGHT_SCHEMA, PROMPT_VERSION,
  pickInstructions, previousBlock, tabUserText, baseTabPrompt, tabInstructionBlock, draftPrompt, cleanDraft, INSTRUCTION_TEMPLATE, DEFAULT_TAB_INSTRUCTIONS,
  mergeRemote, migrateInsightStatuses,
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
  assert.match(t.system, /"action" \(Need action\)/);
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
  assert.equal(rollupStatus(['idle', 'working', null, 'info']), 'working');
  assert.equal(rollupStatus(['idle', 'info']), 'idle');
  assert.equal(rollupStatus(['idle', 'action']), 'action');
  // Statuses saved by older versions still count: Done is Idle, Waiting is Working.
  assert.equal(rollupStatus(['done', 'waiting']), 'working');
  assert.equal(rollupStatus([null, 'bogus']), null);
  assert.equal(normalizeStatus('working'), 'working');
  assert.equal(normalizeStatus('unknown'), null);
  assert.equal(normalizeStatus('done'), 'idle');
  assert.equal(normalizeStatus('waiting'), 'working');
  assert.equal(effectiveStatus({ status: 'idle', manual: 'action' }), 'action');
  assert.equal(effectiveStatus({ status: 'done' }), 'idle');
  assert.equal(effectiveStatus({ status: 'working', manual: 'done' }), 'idle');
  assert.equal(effectiveStatus(null), null);
  assert.ok(statusRank('action') < statusRank(null) && statusRank(null) < statusRank('idle') && statusRank('idle') < statusRank('info'));
  assert.equal(statusRank('done'), statusRank('idle'));
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

test('staleCheck: only a summarized, not yet outdated tab is checked', () => {
  const mark = { reason: 'nav', due: 0 };
  assert.equal(staleCheck({ ins: null, mark, now: 1 }).reason, '');
  assert.equal(staleCheck({ ins: { summary: 's', stale: true }, mark, now: 1 }).reason, '');
});

test('staleCheck: a change signal waits until the tab settles', () => {
  const now = 1_000_000;
  const mark = addMark(undefined, 'nav', now);
  assert.equal(mark.due, now + REFRESH.settle);
  assert.deepEqual(staleCheck({ ins: { summary: 's', at: now }, mark, now: now + 1000 }), { reason: '', at: mark.due });
  assert.equal(staleCheck({ ins: { summary: 's', at: now }, mark, now: mark.due }).reason, 'nav');
});

test('staleCheck: on the active tab only navigation and reloads count; the rest waits until you leave', () => {
  const ins = { summary: 's', at: 0 };
  assert.deepEqual(staleCheck({ ins, mark: { reason: 'title', due: 0 }, active: true, now: 1 }), { reason: '', waiting: true });
  assert.equal(staleCheck({ ins, mark: { reason: 'title', due: 0 }, active: false, now: 1 }).reason, 'title');
  assert.equal(staleCheck({ ins, mark: { reason: 'reload', due: 0 }, active: true, now: 1 }).reason, 'reload');
  assert.equal(staleCheck({ ins, mark: { reason: 'nav', due: 0 }, active: true, now: 1 }).reason, 'nav');
});

test('staleCheck: without signals a tab is left alone, except one visited since its last check when Tab Desk opens', () => {
  const now = 10_000_000;
  const ins = { summary: 's', at: now - 60e3 };
  assert.equal(staleCheck({ ins, now: now + 10 * 3600e3 }).reason, '');
  assert.equal(staleCheck({ ins, lastAccessed: now - 1000, firstSight: true, now }).reason, 'visited');
  assert.equal(staleCheck({ ins, lastAccessed: now - 1000, firstSight: false, now }).reason, '');
  assert.equal(staleCheck({ ins, lastAccessed: now - 120e3, firstSight: true, now }).reason, '');
});

test('interval refresh: minutes setting, clamped, and when it is next due', () => {
  assert.equal(normalizeSettings({}).every, EVERY_DEFAULT);
  assert.equal(normalizeSettings({ every: '15' }).every, 15);
  assert.equal(normalizeSettings({ every: 1 }).every, 5);
  assert.equal(normalizeSettings({ every: 99999 }).every, 1440);
  assert.equal(normalizeSettings({ every: 'soon' }).every, EVERY_DEFAULT);
  assert.equal(nextRefreshAt(1000, 30), 1000 + 30 * 60e3);
});

test('addMark: the stronger reason wins and the wait restarts', () => {
  const a = addMark(undefined, 'nav', 0);
  const b = addMark(a, 'title', 1000);
  assert.deepEqual(b, { reason: 'nav', due: 1000 + REFRESH.settle });
  assert.equal(addMark({ reason: 'nav', due: 0 }, 'left', 0).reason, 'left');
  assert.equal(addMark({ reason: 'left', due: 0 }, 'title', 0).reason, 'left');
});

test('stableTitle drops unread counts in front', () => {
  assert.equal(stableTitle('(3) Inbox - Gmail'), 'Inbox - Gmail');
  assert.equal(stableTitle('[12+]  Chat'), 'Chat');
  assert.equal(stableTitle('Release 2.0 notes'), 'Release 2.0 notes');
});

test('contentSig ignores numbers, times and spacing but not words', () => {
  const a = contentSig({ title: '(1) PR #42', text: 'Opened 3 minutes ago\n12 comments' });
  assert.equal(contentSig({ title: '(4) PR #42', text: 'Opened  5 minutes ago 13 comments' }), a);
  assert.notEqual(contentSig({ title: 'PR #42', text: 'Merged 5 minutes ago 13 comments' }), a);
  assert.equal(stableText('At 10:45, 1,234 views'), 'at #, # views');
});

test('pruneCache keeps a summary that was checked recently even if written long ago', () => {
  const now = 1e12;
  const out = pruneCache({ a: { at: now - 40 * 86400e3, checkedAt: now - 1000 }, b: { at: now - 40 * 86400e3 } }, now, 30 * 86400e3, 10);
  assert.deepEqual(Object.keys(out), ['a']);
});

test('geminiRequest asks for JSON with a status enum when json is set', () => {
  const r = geminiRequest({ model: 'm', system: 's', user: 'u', json: true });
  assert.equal(r.body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(r.body.generationConfig.responseSchema.properties.status.enum, ['action', 'working', 'idle', 'info', 'unknown']);
  assert.equal(geminiRequest({ model: 'm', system: 's', user: 'u' }).body.generationConfig.responseMimeType, undefined);
});

test('summary line under each tab is off by default', () => {
  assert.equal(normalizeSettings({}).tabLines, false);
  assert.equal(normalizeSettings({ tabLines: 'yes' }).tabLines, false);
  assert.equal(normalizeSettings({ tabLines: true }).tabLines, true);
});

test('summary and status come from one analysis: facts first, then status, then the summary that explains it', () => {
  assert.deepEqual(Object.keys(INSIGHT_SCHEMA.properties), ['facts', 'status', 'summary']);
  const g = geminiRequest({ model: 'm', system: 's', user: 'u', json: true }).body.generationConfig.responseSchema;
  assert.deepEqual(g.propertyOrdering, ['facts', 'status', 'summary']);
  assert.deepEqual(g.required, ['facts', 'status', 'summary']);
  const p = tabPrompt({ title: 'Fix login · Pull Request #5', url: 'https://github.com/a/b/pull/5', text: 'Page state: Merged\n\nbody' });
  const all = (p.system + '\n' + p.user).toLowerCase();
  assert.match(all, /facts/);
  assert.match(all, /page state/);
  assert.match(all, /agree/);
  assert.ok(PROMPT_VERSION >= 7);
});

test('the summary explains the status with a concrete fact, not a page description', () => {
  const base = baseTabPrompt('en');
  assert.match(base, /"summary": why the tab has that status/);
  assert.match(base, /at most 15 words/);
  assert.match(base, /concrete fact that explains the status, not what the page is/);
  assert.match(base, /Needs you to create the D1 database/);
  assert.match(DEFAULT_TAB_INSTRUCTIONS, /Summary: the concrete fact that explains the status/);
  assert.match(localContext('tab'), /concrete fact/);
  assert.doesNotMatch(localContext('tab'), /what it is\.$/);
});

test('parseInsight keeps short facts; headTail keeps both ends of long pages', () => {
  const r = parseInsight('{"facts":"PR merged by bob","summary":"The login fix PR was merged.","status":"idle"}');
  assert.deepEqual(r, { facts: 'PR merged by bob', summary: 'The login fix PR was merged.', status: 'idle' });
  assert.equal(parseInsight('{"summary":"The login fix PR was merged.","status":"done"}').status, 'idle');
  assert.ok(parseInsight(JSON.stringify({ facts: 'x'.repeat(500), summary: 'A page about things.', status: 'info' })).facts.length <= 160);
  const long = 'HEAD' + 'a'.repeat(20000) + 'TAIL';
  const ht = headTail(long, 6000);
  assert.ok(ht.length <= 6010);
  assert.ok(ht.startsWith('HEAD'));
  assert.ok(ht.endsWith('TAIL'));
  assert.equal(headTail('short', 6000), 'short');
});

test('tab prompt = fixed base (JSON facts, status, summary) + one set of instructions, default when none', () => {
  const base = baseTabPrompt('en');
  assert.match(base, /Reply with JSON only, in this order: \{"facts": "\.\.\.", "status": "\.\.\.", "summary": "\.\.\."\}/);
  const d = tabPrompt({ title: 't', url: 'u', text: 'x' }).system;
  assert.ok(d.startsWith(base));
  assert.ok(d.includes(DEFAULT_TAB_INSTRUCTIONS));
  const own = tabPrompt({ title: 't', url: 'u', text: 'x', instructions: 'Summary: say who is assigned.' }).system;
  assert.ok(own.startsWith(base));
  assert.ok(own.endsWith('Instructions for this page:\nSummary: say who is assigned.'));
  assert.ok(!own.includes(DEFAULT_TAB_INSTRUCTIONS), 'user instructions replace the default ones');
  assert.equal(tabInstructionBlock('  '), `Instructions for this page:\n${DEFAULT_TAB_INSTRUCTIONS}`);
  for (const label of ['This page is:', 'Facts:', 'Summary:', 'Status:', 'Need action', 'Working', 'Idle', 'Reference']) {
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

test('mergeRemote: take the other page’s summaries, keep our unsaved ones, forget keys storage has', () => {
  const local = { a: { s: 'mine' }, b: { s: 'old' }, d: { s: 'same' } };
  const dirty = new Set(['a', 'd', 'gone']);
  const remote = { b: { s: 'theirs' }, c: { s: 'new' }, d: { s: 'same' }, gone: { s: 'x' } };
  const { merged, resave } = mergeRemote(remote, local, dirty);
  assert.deepEqual(merged, { a: { s: 'mine' }, b: { s: 'theirs' }, c: { s: 'new' }, d: { s: 'same' } });
  assert.equal(resave, true);
  assert.deepEqual([...dirty].sort(), ['a', 'gone']);
  // Our own write comes back: nothing left to merge.
  const again = mergeRemote(merged, merged, dirty);
  assert.equal(again.resave, false);
  assert.equal(dirty.size, 0);
  // Storage cleared elsewhere, nothing pending here.
  assert.deepEqual(mergeRemote(undefined, local, new Set()), { merged: {}, resave: false });
});

test('migrateInsightStatuses rewrites saved Done and Waiting statuses, AI-set and hand-set', () => {
  const map = { a: { status: 'done', manual: 'waiting' }, b: { status: 'action' }, c: null };
  assert.equal(migrateInsightStatuses(map), true);
  assert.deepEqual(map.a, { status: 'idle', manual: 'working' });
  assert.deepEqual(map.b, { status: 'action' });
  assert.equal(migrateInsightStatuses(map), false);
});

test('the previous status and summary go into the tab prompt as context', () => {
  const now = Date.parse('2026-11-27T10:00:00Z');
  const prev = { status: 'action', summary: 'Needs you to create the D1 database.', at: now - 3 * 3600e3 };
  const b = previousBlock(prev, now);
  assert.match(b, /^Previous analysis of this tab \(written 3 h ago; the page may have changed since\):/);
  assert.match(b, /Status: Need action\nSummary: Needs you to create the D1 database\./);
  assert.doesNotMatch(b, /by hand/);
  assert.match(previousBlock({ ...prev, manual: 'idle' }, now), /set the status to Idle by hand/);
  assert.match(previousBlock({ status: 'done', summary: 'x', at: now - 60e3 }, now), /1 min ago[\s\S]*Status: Idle/);
  assert.equal(previousBlock(null), '');
  assert.equal(previousBlock({ status: 'nope', summary: '  ' }), '');
  const p = tabPrompt({ title: 'T', url: 'u', text: 'body', previous: b });
  assert.ok(p.user.startsWith(b + '\n\nTitle: T'));
  assert.ok(p.user.indexOf('Previous analysis') < p.user.indexOf('<page>'), 'previous analysis sits outside the untrusted page block');
  assert.match(p.system, /keep its status while the page still supports it/);
  assert.match(p.system, /The page always wins/);
  assert.ok(!tabPrompt({ title: 'T', url: 'u', text: 'body' }).user.includes('Previous analysis'));
  assert.equal(tabUserText({ title: 'T', url: 'u', text: '' }), 'Title: T\nURL: u\n<page>\n(The page text could not be read. Work from the title and URL only.)\n</page>');
});
