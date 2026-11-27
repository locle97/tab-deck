import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFields, parseStatusRules, decideStatus, testCond, factsLine, fieldsBlock, foundAny, fieldPlanFor, PRESETS, presetRule,
} from '../src/lib/fields.js';
import { normalizeSettings, pickInstructions, sentencePrompt, templateSentence, geminiRequest, compilePattern } from '../src/lib/ai-core.js';

test('parseFields reads selectors, attributes, lists and labels, and reports bad lines', () => {
  const { fields, errors } = parseFields(`# comment
viewer: meta[name="user-login"] @content
state: .State, [class*="StateLabel"]
reviewers[]: .reviewer .name
status: label: Status

bad line
url: .x
state: .again
x: div[
`);
  assert.deepEqual(fields, [
    { name: 'viewer', list: false, kind: 'css', selector: 'meta[name="user-login"]', attr: 'content' },
    { name: 'state', list: false, kind: 'css', selector: '.State, [class*="StateLabel"]' },
    { name: 'reviewers', list: true, kind: 'css', selector: '.reviewer .name' },
    { name: 'status', list: false, kind: 'label', label: 'Status' },
  ]);
  assert.deepEqual(errors.map(e => e.line), [7, 8, 9, 10]);
  assert.match(errors[1].message, /always available/);
  assert.match(errors[2].message, /twice/);
  assert.match(errors[3].message, /valid CSS/);
});

test('parseStatusRules accepts status keys and labels, several conditions, otherwise and ai', () => {
  const { rules, errors } = parseStatusRules(`idle when state matches /merged|closed/
Need action when reviewers has {viewer} and state is open
working when ci is not empty
reference when title does not contain "WIP"
ai otherwise
soon when x is y
done when nothing
done if x`);
  assert.deepEqual(rules, [
    { status: 'idle', conds: [{ field: 'state', op: 'matches', value: '/merged|closed/' }] },
    { status: 'action', conds: [{ field: 'reviewers', op: 'has', value: '{viewer}' }, { field: 'state', op: 'eq', value: 'open' }] },
    { status: 'working', conds: [{ field: 'ci', op: 'exists', value: '' }] },
    { status: 'info', conds: [{ field: 'title', op: 'ncontains', value: 'WIP' }] },
    { status: 'unknown', conds: [] },
  ]);
  assert.deepEqual(errors.map(e => e.line), [6, 7, 8]);
  assert.match(errors[0].message, /isn’t a status/);
});

test('conditions: case-insensitive, lists, references, regex, missing references never match', () => {
  const v = { state: 'Open', reviewers: ['Ann', 'locle97'], viewer: 'LocLe97', empty: '', none: [] };
  const c = s => parseStatusRules(`done when ${s}`).rules[0].conds[0];
  assert.equal(testCond(c('state is open'), v), true);
  assert.equal(testCond(c('state is not open'), v), false);
  assert.equal(testCond(c('reviewers has {viewer}'), v), true);
  assert.equal(testCond(c('reviewers has bob'), v), false);
  assert.equal(testCond(c('reviewers does not have bob'), v), true);
  assert.equal(testCond(c('reviewers contains ann'), v), true);
  assert.equal(testCond(c('state matches /^op/'), v), true);
  assert.equal(testCond(c('state does not match closed'), v), true);
  assert.equal(testCond(c('empty is empty'), v), true);
  assert.equal(testCond(c('none is empty'), v), true);
  assert.equal(testCond(c('missing is empty'), v), true);
  assert.equal(testCond(c('state is not empty'), v), true);
  // {nobody} isn't a field, so a comparison with it never holds (not even "is not").
  assert.equal(testCond(c('state is not {nobody}'), v), false);
  assert.equal(testCond(c('reviewers has {nobody}'), v), false);
});

test('decideStatus: first matching rule wins, null when none', () => {
  const { rules } = parseStatusRules('done when state is merged\naction when state is open\ninfo otherwise');
  assert.deepEqual(decideStatus(rules, { state: 'Merged' }), { status: 'idle', index: 0 });
  assert.deepEqual(decideStatus(rules, { state: 'open' }), { status: 'action', index: 1 });
  assert.deepEqual(decideStatus(rules, { state: 'draft' }), { status: 'info', index: 2 });
  assert.equal(decideStatus(parseStatusRules('done when state is merged').rules, { state: 'x' }), null);
});

test('factsLine and fieldsBlock list what was found; foundAny ignores built-ins', () => {
  const { fields } = parseFields('viewer: meta @content\nstate: .s\nchecks[]: .c\nnote: .n');
  const v = { viewer: 'me', state: 'Open', checks: ['ci failed', 'lint ok'], note: '' };
  assert.equal(factsLine(fields, v), 'state: Open · checks: ci failed, lint ok');
  assert.equal(fieldsBlock(fields, v), 'viewer: me\nstate: Open\nchecks: ci failed, lint ok\nnote: (not found)');
  assert.equal(foundAny(fields, v), true);
  assert.equal(foundAny(fields, { viewer: '', state: '', checks: [], note: '' }), false);
});

test('rules can have page fields without instructions; instructions come from rules that have them', () => {
  const s = normalizeSettings({
    general: 'G',
    rules: [
      { pattern: 'github.com/*/*/pull/*', fields: 'state: .State', statusRules: 'done when state is merged' },
      { pattern: 'github.com', instructions: 'Site' },
      { pattern: 'example.com', statusRules: 'done otherwise' }, // status rules alone: dropped
    ],
  });
  assert.equal(s.rules.length, 2);
  assert.equal(s.rules[0].fields, 'state: .State');
  assert.equal(s.presets, true);
  assert.equal(pickInstructions(s, null, 'https://github.com/a/b/pull/1').text, 'Site');
});

test('fieldPlanFor: your rule with fields wins, else a preset, unless presets are off', () => {
  const pr = 'https://github.com/a/b/pull/12/checks';
  const run = 'https://github.com/a/b/actions/runs/99/job/1';
  let s = normalizeSettings({});
  assert.equal(fieldPlanFor(s, pr).preset, 'github-pr');
  assert.equal(fieldPlanFor(s, 'https://github.com/a/b/pull/12').preset, 'github-pr');
  assert.equal(fieldPlanFor(s, run).preset, 'github-actions-run');
  assert.equal(fieldPlanFor(s, 'https://github.com/a/b/pulls'), null);
  assert.equal(fieldPlanFor(s, 'https://example.com/'), null);
  s = normalizeSettings({ rules: [{ pattern: 'github.com/**', fields: 'x: .x', statusRules: 'done otherwise' }] });
  assert.equal(fieldPlanFor(s, pr).source, 'rule');
  s = normalizeSettings({ presets: false });
  assert.equal(fieldPlanFor(s, pr), null);
});

test('presets parse cleanly and their patterns are valid', () => {
  for (const p of PRESETS) {
    assert.deepEqual(parseFields(p.fields).errors, [], p.id);
    assert.deepEqual(parseStatusRules(p.statusRules).errors, [], p.id);
    assert.ok(compilePattern(presetRule(p).pattern), p.id);
  }
});

test('GitHub PR preset: status follows who you are and what the page shows', () => {
  const p = PRESETS.find(x => x.id === 'github-pr');
  const { rules } = parseStatusRules(p.statusRules);
  const base = { viewer: 'me', author: 'ann', state: 'Open', requested: [], reviews: [], mergebox: [], ci: '' };
  const d = v => decideStatus(rules, { ...base, ...v })?.status;
  assert.equal(d({ state: 'Merged' }), 'idle');
  assert.equal(d({ state: 'Closed', author: 'me' }), 'idle');
  assert.equal(d({ requested: ['Awaiting requested review from me'] }), 'action');
  assert.equal(d({ requested: ['Awaiting requested review from someone'] }), 'info');
  assert.equal(d({ author: 'me', state: 'Draft' }), 'working');
  assert.equal(d({ author: 'me', mergebox: ['Changes requested'] }), 'action');
  assert.equal(d({ author: 'me', ci: 'https://github.githubassets.com/favicons/favicon-failure.svg' }), 'action');
  assert.equal(d({ author: 'me', mergebox: ['All checks have passed', 'This branch has no conflicts with the base branch'] }), 'action');
  assert.equal(d({ author: 'me', mergebox: ['Review required', 'All checks have passed'] }), 'working');
  assert.equal(d({ author: 'me', mergebox: ['Some checks haven’t completed yet'] }), 'working');
  assert.equal(d({ reviews: ['me approved these changes'] }), 'working');
  assert.equal(d({}), 'info');
  // No viewer found: nothing about "you" can match, so it isn't wrongly "Need action".
  assert.equal(d({ viewer: '', requested: ['Awaiting requested review from me'] }), 'info');
});

test('GitHub Actions preset: status from the run status, else the favicon, else the AI', () => {
  const p = PRESETS.find(x => x.id === 'github-actions-run');
  const { rules } = parseStatusRules(p.statusRules);
  const d = v => decideStatus(rules, { viewer: 'me', status: '', ci: '', failed: [], ...v })?.status;
  assert.equal(d({ status: 'In progress' }), 'working');
  assert.equal(d({ status: 'Queued' }), 'working');
  assert.equal(d({ status: 'Failure' }), 'action');
  assert.equal(d({ status: 'Success' }), 'idle');
  assert.equal(d({ status: 'Cancelled' }), 'idle');
  assert.equal(d({ ci: '/favicons/favicon-pending.svg' }), 'working');
  assert.equal(d({ ci: '/favicons/favicon-success.svg' }), 'idle');
  assert.equal(d({}), 'unknown');
});

test('sentence prompt: facts and status are given, the AI only writes the sentence', () => {
  const { system, user } = sentencePrompt({ title: 'Fix it', url: 'https://x/pull/1', facts: 'state: Open', status: 'action', excerpt: 'a'.repeat(5000), instructions: 'Mention the branch.' });
  assert.match(system, /ONE short sentence/);
  assert.match(system, /don't judge the status/);
  assert.match(system, /Mention the branch/);
  assert.match(system, /untrusted/);
  assert.match(user, /State: state: Open\nStatus: Need action/);
  assert.ok(user.length < 2000);
  assert.match(system, /says why the tab is "Need action"/);
  assert.equal(templateSentence({ title: 'Fix it', facts: 'state: Open' }), 'state: Open · Fix it');
  assert.equal(templateSentence({ title: 'Fix it', facts: '' }), 'Fix it');
  const req = geminiRequest({ model: 'm', system, user, json: 'sentence' });
  assert.deepEqual(req.body.generationConfig.responseSchema.required, ['summary']);
});

test('status rules written with the old names still work: Done is Idle, Waiting and In progress are Working', () => {
  const { rules, errors } = parseStatusRules('done when state is merged\nwaiting when state is open\nin progress when state is draft\nneeds you otherwise');
  assert.deepEqual(errors, []);
  assert.deepEqual(rules.map(r => r.status), ['idle', 'working', 'working', 'action']);
});
