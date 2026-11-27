// Page fields and status rules: read a few specific values from a page instead of all of its text,
// and decide the status from them in code. Works on any site; GitHub comes as a built-in preset.
// Pure helpers only (no chrome.* here), so they can be unit tested in Node.
//
// Fields, one per line:            Status rules, one per line, first match wins:
//   state: .State                    idle when state matches /merged|closed/
//   viewer: meta[name=user-login] @content
//   reviewers[]: .reviewer .name     action when reviewers has {viewer}   (has: a whole word or item, not part of one)
//   status: label: Status            working when status is In progress
//                                    info otherwise

import { STATUSES, STATUS_ORDER, LEGACY_STATUS, mostSpecificRule } from './ai-core.js';

export const MAX_FIELDS = 20;
export const MAX_FIELD_VALUE = 200;
export const MAX_LIST_ITEMS = 20;

const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/i;
/** Fields every page has, without defining them. */
export const BUILTIN_FIELDS = ['title', 'url'];

/**
 * Parse field definitions. Each line is `name: source`, where source is
 *  - a CSS selector (commas allowed), optionally ending in ` @attribute` to read that attribute instead of the text;
 *  - `label: Some label` for the value shown next to a label (handy for "Status  Success" layouts).
 * `name[]` reads every match as a list. Blank lines and lines starting with # are ignored.
 * Returns { fields: [{ name, list, kind: 'css'|'label', selector?, attr?, label? }], errors: [{ line, message }] }.
 */
export function parseFields(text) {
  const fields = [], errors = [];
  const seen = new Set();
  String(text || '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^([^:\s[\]]+)(\[\])?\s*:\s*(.+)$/.exec(line);
    if (!m) { errors.push({ line: i + 1, message: 'Write it as name: selector' }); return; }
    const [, name, list, rest] = m;
    if (!NAME_RE.test(name)) { errors.push({ line: i + 1, message: `“${name}” isn’t a usable name (letters, digits, - and _)` }); return; }
    if (BUILTIN_FIELDS.includes(name.toLowerCase())) { errors.push({ line: i + 1, message: `“${name}” is always available; pick another name` }); return; }
    if (seen.has(name.toLowerCase())) { errors.push({ line: i + 1, message: `“${name}” is defined twice` }); return; }
    const lab = /^label\s*:\s*(.+)$/i.exec(rest);
    let f;
    if (lab) f = { name, list: !!list, kind: 'label', label: lab[1].trim() };
    else {
      const at = /^(.*?)\s+@([a-z_:][-a-z0-9_:.]*)$/i.exec(rest);
      const selector = (at ? at[1] : rest).trim();
      if (!selector) { errors.push({ line: i + 1, message: 'Missing selector' }); return; }
      if (!isSelector(selector)) { errors.push({ line: i + 1, message: `“${selector}” isn’t a valid CSS selector` }); return; }
      f = { name, list: !!list, kind: 'css', selector, ...(at ? { attr: at[2] } : {}) };
    }
    if (fields.length >= MAX_FIELDS) { errors.push({ line: i + 1, message: `At most ${MAX_FIELDS} fields` }); return; }
    seen.add(name.toLowerCase());
    fields.push(f);
  });
  return { fields, errors };
}

// In the page (and in tests with a DOM), check selectors for real. In Node there is no DOM, so only
// catch the obvious mistakes.
function isSelector(sel) {
  if (typeof document !== 'undefined' && document.createDocumentFragment) {
    try { document.createDocumentFragment().querySelector(sel); return true; } catch { return false; }
  }
  let depth = 0;
  for (const c of sel) { if (c === '[' || c === '(') depth++; else if (c === ']' || c === ')') depth--; if (depth < 0) return false; }
  return depth === 0 && !/^[,>+~]|[,>+~]\s*$/.test(sel.trim());
}

/* ---------- status rules ---------- */

const STATUS_WORDS = (() => {
  const m = {};
  for (const k of STATUS_ORDER) { m[k] = k; m[STATUSES[k].label.toLowerCase()] = k; }
  Object.assign(m, {
    'need-action': 'action', reference: 'info', unknown: 'unknown', ai: 'unknown',
    // Names from older versions, so rules written before still work.
    ...LEGACY_STATUS, 'needs you': 'action', 'needs-you': 'action', 'in progress': 'working', 'in-progress': 'working',
  });
  return m;
})();

// Longest first, so "is not empty" wins over "is not" and "is".
const OPS = [
  ['is not empty', 'exists'], ['is empty', 'empty'], ['exists', 'exists'],
  ['does not contain', 'ncontains'], ['not contains', 'ncontains'], ['contains', 'contains'],
  ['does not have', 'nhas'], ['has', 'has'],
  ['does not match', 'nmatches'], ['matches', 'matches'],
  ['is not', 'neq'], ['is', 'eq'],
];

/**
 * Parse status rules. Each line is `<status> when <condition> [and <condition>…]` or `<status> otherwise`.
 * Status: action/working/idle/info, or their labels (Need action, Working, Idle, Reference),
 * older names (Needs you, In progress, Waiting → Working, Done → Idle),
 * or `ai` to let the AI decide. Condition: `<field> <op> <value>` with op one of
 * is, is not, contains, does not contain, has, does not have (list items), matches /re/, does not match, is empty, is not empty.
 * A value can use {field} to compare with another field, e.g. `reviewers has {viewer}`.
 * Returns { rules: [{ status, conds: [{ field, op, value }] }], errors: [{ line, message }] }.
 */
export function parseStatusRules(text) {
  const rules = [], errors = [];
  String(text || '').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const other = /^(.+?)\s+otherwise$/i.exec(line);
    const when = /^(.+?)\s+when\s+(.+)$/i.exec(line);
    const head = (other || when)?.[1];
    const status = head ? STATUS_WORDS[head.trim().toLowerCase()] : null;
    if (!head) { errors.push({ line: i + 1, message: 'Write it as “<status> when <field> is <value>” or “<status> otherwise”' }); return; }
    if (!status) { errors.push({ line: i + 1, message: `“${head.trim()}” isn’t a status. Use ${STATUS_ORDER.map(k => STATUSES[k].label).join(', ')} or AI` }); return; }
    if (other) { rules.push({ status, conds: [] }); return; }
    const conds = [];
    for (const part of when[2].split(/\s+and\s+/i)) {
      const c = parseCond(part.trim());
      if (c.error) { errors.push({ line: i + 1, message: c.error }); return; }
      conds.push(c);
    }
    rules.push({ status, conds });
  });
  return { rules, errors };
}

function parseCond(s) {
  const m = /^([a-z][a-z0-9_-]*)\s+(.+)$/i.exec(s);
  if (!m) return { error: `“${s}” needs a field and a test, e.g. state is Open` };
  const field = m[1];
  const rest = m[2];
  for (const [word, op] of OPS) {
    const re = new RegExp(`^${word.replace(/ /g, '\\s+')}(?:\\s+(.*))?$`, 'i');
    const mm = re.exec(rest);
    if (!mm) continue;
    let value = (mm[1] || '').trim().replace(/^"(.*)"$/, '$1');
    if (op === 'empty' || op === 'exists') {
      if (value) continue;
      return { field, op, value: '' };
    }
    if (!value) return { error: `“${s}” is missing a value after “${word}”` };
    if (op === 'matches' || op === 'nmatches') {
      const rx = /^\/(.+)\/([a-z]*)$/.exec(value);
      try { new RegExp(rx ? rx[1] : value, 'i'); } catch { return { error: `“${value}” isn’t a valid regular expression` }; }
    }
    return { field, op, value };
  }
  return { error: `“${s}”: unknown test. Use is, is not, contains, has, matches, is empty or is not empty` };
}

const norm = v => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const asList = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
const asText = v => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));

/** Fill {field} references in a value from the extracted fields. */
function fill(value, values) {
  return value.replace(/\{([a-z][a-z0-9_-]*)\}/gi, (_, k) => asText(lookup(values, k)));
}
function lookup(values, k) {
  const key = Object.keys(values).find(x => x.toLowerCase() === k.toLowerCase());
  return key ? values[key] : undefined;
}

export function testCond(c, values) {
  const v = lookup(values, c.field);
  const text = norm(asText(v));
  const val = fill(c.value, values);
  // A comparison with a missing reference ("{viewer}" when no viewer was found) never matches.
  const missingRef = /\{[a-z]/i.test(c.value) && !norm(val);
  switch (c.op) {
    case 'empty': return !text;
    case 'exists': return !!text;
    case 'eq': return !missingRef && text === norm(val);
    case 'neq': return !missingRef && text !== norm(val);
    case 'contains': return !missingRef && text.includes(norm(val));
    case 'ncontains': return !missingRef && !text.includes(norm(val));
    case 'has': return !missingRef && asList(v).some(x => norm(x) === norm(val) || norm(x).split(/[\s,]+/).includes(norm(val)));
    case 'nhas': return !missingRef && !asList(v).some(x => norm(x) === norm(val) || norm(x).split(/[\s,]+/).includes(norm(val)));
    case 'matches': case 'nmatches': {
      const rx = /^\/(.+)\/([a-z]*)$/.exec(val);
      let re;
      try { re = new RegExp(rx ? rx[1] : val, rx ? (rx[2].includes('i') ? rx[2] : rx[2] + 'i') : 'i'); } catch { return false; }
      const hit = asList(v).some(x => re.test(String(x))) || re.test(asText(v));
      return c.op === 'matches' ? hit : !hit;
    }
    default: return false;
  }
}

/**
 * The first status rule whose conditions all hold. Returns { status, index } or null when none matches.
 * status 'unknown' means a rule said to leave it to the AI.
 */
export function decideStatus(rules, values) {
  for (let i = 0; i < (rules || []).length; i++) {
    const r = rules[i];
    if (r.conds.every(c => testCond(c, values))) return { status: r.status, index: i };
  }
  return null;
}

/** Did the page give us anything? Built-in fields don't count. */
export function foundAny(fields, values) {
  return fields.some(f => asList(values[f.name]).some(x => String(x).trim()));
}

/** A short "name: value · name: value" line from the fields that were found, for the facts and the prompt. */
export function factsLine(fields, values, { max = 160, skip = ['viewer'] } = {}) {
  const parts = [];
  for (const f of fields) {
    if (skip.includes(f.name.toLowerCase())) continue;
    const v = asText(values[f.name]).replace(/\s+/g, ' ').trim();
    if (v) parts.push(`${f.name}: ${v}`);
  }
  let s = parts.join(' · ');
  if (s.length > max) s = s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  return s;
}

/** All fields as "name: value" lines, for the AI prompt (built-ins excluded; they're in the prompt already). */
export function fieldsBlock(fields, values) {
  return fields.map(f => {
    const v = asText(values[f.name]).replace(/\s+/g, ' ').trim();
    return `${f.name}: ${v || '(not found)'}`;
  }).join('\n');
}

/* ---------- built-in presets ---------- */
// Used for pages no rule of yours with fields matches. Copy one into your rules to change it.
// GitHub's markup changes often, so each field lists the older and the newer page's selectors.
// The favicon is a steady signal: GitHub swaps it to favicon-success / -failure / -pending on PR and Actions pages.

export const PRESETS = [
  {
    id: 'github-pr',
    name: 'GitHub pull request',
    pattern: '/^https?:\\/\\/github\\.com\\/[^/]+\\/[^/]+\\/pull\\/\\d+(?:[/?#]|$)/',
    fields: [
      'viewer: meta[name="user-login"] @content',
      'state: .gh-header-meta .State, [class*="StateLabel"]',
      'author: .gh-header-meta .author, [class*="PullRequestHeader"] a[data-hovercard-type="user"], [data-testid="author-link"]',
      'requested[]: [aria-label*="Awaiting requested review from"] @aria-label',
      'reviews[]: .reviewers-status-icon @aria-label, [data-testid*="reviewer"] [aria-label] @aria-label',
      'mergebox[]: .merge-status-list .status-heading, .mergeability-details .status-heading, .branch-action-item .status-heading, [class*="MergeBox"] h3, [class*="mergeBox"] h3',
      'ci: link[rel~="icon"][href*="favicon"] @href',
    ].join('\n'),
    statusRules: [
      'idle when state matches /merged|closed/',
      'need action when requested has {viewer}',
      'working when state is draft and author is {viewer}',
      'need action when author is {viewer} and mergebox matches /changes requested|conflict|not successful|failing|failed/',
      'need action when author is {viewer} and ci contains failure',
      'need action when author is {viewer} and mergebox matches /ready to merge|can be merged|all checks have passed/ and mergebox does not match /review required|changes requested|blocked/',
      'working when author is {viewer}',
      'working when reviews has {viewer}',
      'reference otherwise',
    ].join('\n'),
  },
  {
    id: 'github-actions-run',
    name: 'GitHub Actions run',
    pattern: '/^https?:\\/\\/github\\.com\\/[^/]+\\/[^/]+\\/actions\\/runs\\/\\d+(?:[/?#]|$)/',
    fields: [
      'viewer: meta[name="user-login"] @content',
      'status: label: Status',
      'ci: link[rel~="icon"][href*="favicon"] @href',
      'failed[]: [aria-label*="failed" i] @aria-label',
    ].join('\n'),
    statusRules: [
      'working when status matches /queued|in progress|waiting|pending|requested/',
      'need action when status matches /failure|failed|timed out|startup failure|action required/',
      'idle when status matches /success|skipped|neutral/',
      'idle when status matches /cancel/',
      'working when ci contains pending',
      'need action when ci contains failure',
      'idle when ci contains success',
      'ai otherwise',
    ].join('\n'),
  },
];

/** A rule-like object for a preset, in the same shape as the user's rules. */
export const presetRule = p => ({ pattern: p.pattern, instructions: '', fields: p.fields, statusRules: p.statusRules, preset: p.id });

/**
 * The page fields and status rules for a URL: the most specific rule of yours that has fields,
 * else a matching built-in preset (unless presets are turned off). Returns null when none applies.
 * { pattern, preset?, fields: [...parsed], rules: [...parsed], source: 'rule'|'preset' }
 */
export function fieldPlanFor(settings, url) {
  if (!url) return null;
  let r = mostSpecificRule((settings?.rules || []).filter(x => x.fields), url);
  let source = 'rule';
  if (!r && settings?.presets !== false) { r = mostSpecificRule(PRESETS.map(presetRule), url); source = 'preset'; }
  if (!r) return null;
  const { fields } = parseFields(r.fields);
  if (!fields.length) return null;
  const { rules } = parseStatusRules(r.statusRules);
  return { pattern: r.pattern, ...(r.preset ? { preset: r.preset } : {}), fields, rules, source };
}
