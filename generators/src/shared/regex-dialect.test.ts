import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import yaml from 'js-yaml';

// Self-check for tests/regex/dialect.yaml (qfg-ktkr.1). Re-derives
// "Quonfig regex v1" (project/plans/2026-10-12-regex-write-time-check.md
// section 2) independently of the writers: every `accept` row must pass,
// every `reject` row must fail with exactly its `reason`. The writers
// (cli src/verify/regex-dialect.ts, app-quonfig src/lib/domain/regex-dialect.ts)
// are held to the same rows.

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '../../../tests/regex/dialect.yaml');

const REASONS = [
  'too-long',
  'syntax',
  'lookaround',
  'named-group',
  'inline-flag',
  'group-extension',
  'backref',
  'octal',
  'possessive',
  'bad-repeat',
  'class-syntax',
  'unicode-shorthand',
  'unsupported-escape',
  'nested-quantifier',
  'too-many-unbounded',
] as const;
type Reason = (typeof REASONS)[number];

interface Fixture {
  dialect: string;
  limits: { max_length: number; max_repeat: number; max_unbounded_quantifiers: number };
  allowed: string[];
  rejected: string[];
  hints: Record<string, string>;
  accept: { pattern: string; note?: string }[];
  reject: { pattern: string; reason: string; note?: string }[];
  open_questions?: { pattern: string; question: string }[];
}

const MAX_LENGTH = 256;
const MAX_REPEAT = 1000;
const MAX_UNBOUNDED = 2;
const PUNCT = new Set(Array.from('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'));
const HEX = /^[0-9A-Fa-f]$/;
const CONTROL: Record<string, number> = { t: 9, n: 10, v: 11, f: 12, r: 13 };

type Step = { end: number; cp: number } | Reason;

/** One escape starting at cs[i] === '\\'. */
function escape(cs: string[], i: number): Step {
  const n = cs[i + 1];
  if (n === undefined) return 'syntax'; // trailing backslash
  if (/^[1-9]$/.test(n) || n === 'k') return 'backref';
  if (n === '0') return 'octal';
  if ('dDwWsSbB'.includes(n)) return 'unicode-shorthand';
  if (n in CONTROL) return { end: i + 2, cp: CONTROL[n]! };
  if (n === 'x') {
    const h1 = cs[i + 2];
    const h2 = cs[i + 3];
    if (h1 !== undefined && h2 !== undefined && HEX.test(h1) && HEX.test(h2)) {
      return { end: i + 4, cp: parseInt(h1 + h2, 16) };
    }
    return 'unsupported-escape';
  }
  if (PUNCT.has(n)) return { end: i + 2, cp: n.codePointAt(0)! };
  return 'unsupported-escape';
}

/** One class member (literal or escape) at cs[j]. */
function classAtom(cs: string[], j: number): Step {
  const c = cs[j];
  if (c === undefined) return 'syntax';
  if (c === '[') return 'class-syntax';
  if (c === '\\') return escape(cs, j);
  if ('&~|-'.includes(c) && cs[j + 1] === c) return 'class-syntax';
  return { end: j + 1, cp: c.codePointAt(0)! };
}

/** A class starting at cs[i] === '['. Returns the index after its ']'. */
function charClass(cs: string[], i: number): number | Reason {
  let j = i + 1;
  if (cs[j] === '^') j++;
  const start = j;
  if (cs[j] === ']') return 'class-syntax'; // empty class or leading literal ]
  for (;;) {
    if (cs[j] === undefined) return 'syntax';
    if (cs[j] === ']') break;
    const a = classAtom(cs, j);
    if (typeof a === 'string') return a;
    j = a.end;
    if (cs[j] === '-' && cs[j + 1] !== ']' && cs[j + 1] !== undefined) {
      if (cs[j + 1] === '-') return 'class-syntax';
      const b = classAtom(cs, j + 1);
      if (typeof b === 'string') return b;
      if (a.cp > b.cp) return 'syntax';
      j = b.end;
    }
  }
  const body = cs.slice(start, j);
  if (body.length >= 2 && body[0] === ':' && body[body.length - 1] === ':') return 'class-syntax';
  return j + 1;
}

function groupExtension(cs: string[], k: number): Reason {
  const c = cs[k];
  if (c === undefined) return 'syntax';
  if (c === '=' || c === '!') return 'lookaround';
  if (c === '<') return cs[k + 1] === '=' || cs[k + 1] === '!' ? 'lookaround' : 'named-group';
  if (c === 'P' || c === "'") return 'named-group';
  if ('imsxnuUJ^-'.includes(c)) return 'inline-flag';
  return 'group-extension';
}

/** Reference checker: null when the pattern is in Quonfig regex v1. */
export function checkPattern(pattern: string): Reason | null {
  const cs = Array.from(pattern); // length counts code points
  if (cs.length > MAX_LENGTH) return 'too-long';

  // One frame per open group; `inner` = it contains a quantifier or a `|`.
  const stack: { inner: boolean }[] = [{ inner: false }];
  const top = () => stack[stack.length - 1]!;
  // What a quantifier here would apply to.
  let last: 'none' | 'atom' | 'quantified' | { innerGroup: boolean } = 'none';
  let unbounded = 0;
  let i = 0;

  while (i < cs.length) {
    const c = cs[i];
    if (c === '\\') {
      const e = escape(cs, i);
      if (typeof e === 'string') return e;
      i = e.end;
      last = 'atom';
    } else if (c === '(') {
      if (cs[i + 1] === '?') {
        if (cs[i + 2] !== ':') return groupExtension(cs, i + 2);
        i += 3;
      } else {
        i += 1;
      }
      stack.push({ inner: false });
      last = 'none';
    } else if (c === ')') {
      if (stack.length === 1) return 'syntax';
      const frame = stack.pop()!;
      if (frame.inner) top().inner = true;
      last = { innerGroup: frame.inner };
      i += 1;
    } else if (c === '|') {
      top().inner = true;
      last = 'none';
      i += 1;
    } else if (c === '[') {
      const end = charClass(cs, i);
      if (typeof end === 'string') return end;
      i = end;
      last = 'atom';
    } else if (c === '*' || c === '+' || c === '?' || c === '{') {
      let j = i + 1;
      let isUnbounded = c !== '?';
      if (c === '{') {
        const m = /^\{(\d*)(,(\d*))?\}/.exec(cs.slice(i).join(''));
        if (!m || m[1] === '') return 'bad-repeat'; // bare brace, {}, {,m}
        const n = Number(m[1]);
        const hasMax = m[2] !== undefined && m[3] !== '';
        const max = hasMax ? Number(m[3]) : undefined;
        if (n > MAX_REPEAT || (max !== undefined && (max > MAX_REPEAT || n > max))) return 'bad-repeat';
        isUnbounded = m[2] !== undefined && m[3] === '';
        j = i + Array.from(m[0]).length;
      }
      if (last === 'none' || last === 'quantified') return 'syntax';
      if (cs[j] === '+') return 'possessive';
      if (cs[j] === '?') j += 1; // lazy
      if (typeof last === 'object' && last.innerGroup) return 'nested-quantifier';
      top().inner = true;
      if (isUnbounded) unbounded += 1;
      last = 'quantified';
      i = j;
    } else if (c === '^' || c === '$') {
      last = 'none';
      i += 1;
    } else {
      last = 'atom'; // literal, `.`, `]`, `}`
      i += 1;
    }
  }
  if (stack.length !== 1) return 'syntax';
  if (unbounded > MAX_UNBOUNDED) return 'too-many-unbounded';
  return null;
}

const fixture = yaml.load(readFileSync(fixturePath, 'utf8')) as Fixture;

test('fixture has the documented shape', () => {
  assert.equal(fixture.dialect, 'quonfig-regex-v1');
  assert.deepEqual(fixture.limits, {
    max_length: MAX_LENGTH,
    max_repeat: MAX_REPEAT,
    max_unbounded_quantifiers: MAX_UNBOUNDED,
  });
  assert.ok(Array.isArray(fixture.allowed) && fixture.allowed.length > 0);
  assert.ok(Array.isArray(fixture.rejected) && fixture.rejected.length > 0);
  assert.ok(Array.isArray(fixture.accept) && fixture.accept.length > 0);
  assert.ok(Array.isArray(fixture.reject) && fixture.reject.length > 0);
  for (const row of [...fixture.accept, ...fixture.reject]) assert.equal(typeof row.pattern, 'string');
});

test('every reason code has a hint, and every hint is a used reason code', () => {
  assert.deepEqual(Object.keys(fixture.hints).sort(), [...REASONS].sort());
  for (const [code, hint] of Object.entries(fixture.hints)) {
    assert.ok(typeof hint === 'string' && hint.length > 0, `${code}: empty hint`);
  }
  const used = new Set(fixture.reject.map((r) => r.reason));
  for (const code of REASONS) assert.ok(used.has(code), `no reject row exercises ${code}`);
});

test('no pattern is listed twice', () => {
  const all = [...fixture.accept, ...fixture.reject, ...(fixture.open_questions ?? [])].map((r) => r.pattern);
  assert.equal(new Set(all).size, all.length);
});

test('open questions are not pinned either way', () => {
  for (const q of fixture.open_questions ?? []) {
    assert.ok(q.question.length > 0, `${q.pattern}: open question needs text`);
  }
});

for (const { pattern } of fixture.accept) {
  test(`accept ${JSON.stringify(pattern)}`, () => {
    assert.equal(checkPattern(pattern), null);
  });
}

for (const { pattern, reason } of fixture.reject) {
  test(`reject ${JSON.stringify(pattern)} as ${reason}`, () => {
    assert.ok((REASONS as readonly string[]).includes(reason), `unknown reason ${reason}`);
    assert.equal(checkPattern(pattern), reason);
  });
}
