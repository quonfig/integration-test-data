// Cross-SDK parity verifier.
//
// Layer 1 (local parity check):
//   For every YAML case in tests/eval/*.yaml, confirm a matching test exists in
//   each SDK's generated output. Then grep for skip patterns and reject empty
//   test files. Non-zero exit on any failure.
//
// Layer 2 (GitHub Actions status):
//   For each sibling SDK (and integration-test-data itself), use `gh run list`
//   to fetch the latest run on `main` for every active workflow and report
//   pass/fail. Missing `gh` or unauthenticated => fail loudly with instructions.
//
// Run from integration-test-data/generators/ with:
//   npm run verify
//
// Source: integration-test-data/generators/src/verify.ts

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadYamlFile } from './yaml-loader.js';
import { uniqueSuffix } from './shared/case-id.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface SdkSpec {
  name: string;
  repoDir: string; // absolute path to sibling repo
  testDir: string; // absolute path to generated tests dir
  filename: (suite: string) => string; // e.g. "test_get.rb"
  parser: 'ruby' | 'go' | 'node' | 'python';
  skipPatterns: { label: string; regex: RegExp }[];
}

const RUBY_SKIPS = [
  { label: 'skip(', regex: /^\s*skip\(/m },
  { label: 'pending', regex: /\bpending\b/ },
];

const GO_SKIPS = [
  { label: 't.Skip', regex: /\bt\.Skip\b(?!ow)/ },
  { label: 't.Skipf', regex: /\bt\.Skipf\b/ },
  { label: 't.SkipNow', regex: /\bt\.SkipNow\b/ },
];

const NODE_SKIPS = [
  { label: 'it.skip', regex: /\bit\.skip\b/ },
  { label: 'describe.skip', regex: /\bdescribe\.skip\b/ },
  { label: 'it.todo', regex: /\bit\.todo\b/ },
  { label: 'describe.todo', regex: /\bdescribe\.todo\b/ },
];

const PYTHON_SKIPS = [
  { label: 'pytest.skip(', regex: /\bpytest\.skip\(/ },
  { label: '@pytest.mark.skip', regex: /@pytest\.mark\.skip/ },
  { label: '@unittest.skip', regex: /@unittest\.skip/ },
];

function repoRoot(): string {
  // src/verify.ts -> integration-test-data/generators/
  return resolve(__dirname, '..', '..');
}

function siblingsRoot(): string {
  // parent of integration-test-data
  return resolve(repoRoot(), '..');
}

function buildSdks(): SdkSpec[] {
  const root = siblingsRoot();
  return [
    {
      name: 'sdk-ruby',
      repoDir: resolve(root, 'sdk-ruby'),
      testDir: resolve(root, 'sdk-ruby', 'test', 'integration'),
      filename: (s) => `test_${s}.rb`,
      parser: 'ruby',
      skipPatterns: RUBY_SKIPS,
    },
    {
      name: 'sdk-go',
      repoDir: resolve(root, 'sdk-go'),
      testDir: resolve(root, 'sdk-go', 'internal', 'fixtures'),
      filename: (s) => `${s}_generated_test.go`,
      parser: 'go',
      skipPatterns: GO_SKIPS,
    },
    {
      name: 'sdk-node',
      repoDir: resolve(root, 'sdk-node'),
      testDir: resolve(root, 'sdk-node', 'test', 'integration'),
      filename: (s) => `${s}.generated.test.ts`,
      parser: 'node',
      skipPatterns: NODE_SKIPS,
    },
    {
      name: 'sdk-python',
      repoDir: resolve(root, 'sdk-python'),
      testDir: resolve(root, 'sdk-python', 'tests', 'integration'),
      filename: (s) => `test_${s}.py`,
      parser: 'python',
      skipPatterns: PYTHON_SKIPS,
    },
  ];
}

interface YamlSuite {
  basename: string; // e.g. "get.yaml"
  suite: string; // e.g. "get"
  caseNames: string[]; // raw YAML names, in order, with `__N` disambiguator on duplicates
}

/**
 * Walk every YAML in tests/eval/ and produce the canonical case list per file.
 *
 * Duplicate names within a single YAML file get a `__2`, `__3`, ... suffix so
 * we can match them deterministically against the per-SDK output (which also
 * deduplicates via {@link uniqueSuffix} inside the language target). The
 * suffix is internal to the verifier — it doesn't appear in YAML or in
 * generated source.
 */
function loadYamlSuites(dataRoot: string): YamlSuite[] {
  const files = readdirSync(dataRoot)
    .filter((f) => f.endsWith('.yaml'))
    .sort();
  const out: YamlSuite[] = [];
  for (const basename of files) {
    const suite = basename.slice(0, -'.yaml'.length);
    const cases = loadYamlFile(resolve(dataRoot, basename), basename);
    const seen = new Map<string, number>();
    const caseNames: string[] = [];
    for (const c of cases) {
      const name = (c.raw?.name ?? '').toString();
      const tag = uniqueDupTag(seen, name);
      caseNames.push(tag);
    }
    out.push({ basename, suite, caseNames });
  }
  return out;
}

function uniqueDupTag(seen: Map<string, number>, name: string): string {
  const n = (seen.get(name) ?? 0) + 1;
  seen.set(name, n);
  return n > 1 ? `${name}__${n}` : name;
}

/**
 * Pull the list of test names out of a generated SDK file. Tags duplicates
 * with `__2`, `__3` (matching {@link uniqueDupTag}) so YAML and SDK lists are
 * directly comparable as multisets.
 *
 * For Ruby/Go/Python, every test method has a leading `# <yaml-name>` (or
 * `// <yaml-name>`) comment with the raw YAML name on the line above the
 * `def`/`func` line. That comment is the source of truth — we don't try to
 * reverse the camelCase/snake_case sanitization.
 *
 * For Node, the YAML name is the first arg of `it("...", ...)`. The test
 * string is escaped TypeScript, so we honor common escapes (\\ \" \n \t).
 */
function extractCaseNamesFromFile(parser: SdkSpec['parser'], path: string): string[] {
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/);
  const seen = new Map<string, number>();
  const out: string[] = [];

  if (parser === 'ruby') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const m = line.match(/^\s*def\s+test_/);
      if (!m) continue;
      // Walk back over preceding blank lines to find the # comment.
      const name = findCommentName(lines, i, '#');
      if (name === null) continue;
      out.push(uniqueDupTag(seen, name));
    }
    return out;
  }

  if (parser === 'go') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const m = line.match(/^func\s+Test[A-Za-z0-9_]+\s*\(t \*testing\.T\)/);
      if (!m) continue;
      const name = findCommentName(lines, i, '//');
      if (name === null) continue;
      out.push(uniqueDupTag(seen, name));
    }
    return out;
  }

  if (parser === 'python') {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const m = line.match(/^def\s+test_/);
      if (!m) continue;
      const name = findCommentName(lines, i, '#');
      if (name === null) continue;
      out.push(uniqueDupTag(seen, name));
    }
    return out;
  }

  // node
  // Match `it("...", ...)` allowing the name to include escaped chars.
  const itRe = /^\s*it\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*,/;
  for (const line of lines) {
    const m = line.match(itRe);
    if (!m) continue;
    const quote = m[1] ?? '"';
    const raw = m[2] ?? '';
    const name = decodeJsString(raw, quote);
    out.push(uniqueDupTag(seen, name));
  }
  return out;
}

/**
 * Look for the closest preceding `<commentMarker> <name>` comment to a test
 * definition line. Skips blank lines, but stops if it hits a non-comment
 * non-blank line — meaning the test has no leading-name comment, which we
 * treat as unparseable (the generators always emit one).
 */
function findCommentName(lines: string[], defLineIdx: number, commentMarker: string): string | null {
  for (let j = defLineIdx - 1; j >= 0; j--) {
    const trimmed = (lines[j] ?? '').trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith(commentMarker + ' ')) {
      return trimmed.slice(commentMarker.length + 1);
    }
    if (trimmed.startsWith(commentMarker)) {
      // bare "//" or "#" with no space — strip the marker
      return trimmed.slice(commentMarker.length).trim();
    }
    return null;
  }
  return null;
}

function decodeJsString(raw: string, quote: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === 'r') out += '\r';
      else if (next === '\\') out += '\\';
      else if (next === quote) out += quote;
      else out += next;
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

interface SkipHit {
  file: string;
  line: number;
  label: string;
  text: string;
}

function findSkips(filePath: string, patterns: SdkSpec['skipPatterns']): SkipHit[] {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const hits: SkipHit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const p of patterns) {
      if (p.regex.test(line)) {
        hits.push({ file: filePath, line: i + 1, label: p.label, text: line.trim() });
      }
    }
  }
  return hits;
}

interface SuiteResult {
  yaml: string;
  expected: number;
  found: number;
  missing: string[]; // case names absent from this SDK
  extra: string[]; // case names present in SDK but not YAML
  fileExists: boolean;
  empty: boolean; // file exists but no tests at all
  skipHits: SkipHit[];
}

interface SdkResult {
  name: string;
  suites: SuiteResult[];
  totalExpected: number;
  totalFound: number;
  totalSkips: number;
  emptyFiles: number;
  missingFiles: number;
  pass: boolean;
}

function checkSdk(sdk: SdkSpec, suites: YamlSuite[]): SdkResult {
  const result: SdkResult = {
    name: sdk.name,
    suites: [],
    totalExpected: 0,
    totalFound: 0,
    totalSkips: 0,
    emptyFiles: 0,
    missingFiles: 0,
    pass: true,
  };

  for (const yaml of suites) {
    const path = resolve(sdk.testDir, sdk.filename(yaml.suite));
    const expected = yaml.caseNames;
    const expectedSet = countNames(expected);

    let names: string[] = [];
    let fileExists = existsSync(path);
    let empty = false;
    let skipHits: SkipHit[] = [];

    if (fileExists) {
      names = extractCaseNamesFromFile(sdk.parser, path);
      if (names.length === 0) empty = true;
      skipHits = findSkips(path, sdk.skipPatterns);
    }

    const foundSet = countNames(names);
    const missing: string[] = [];
    const extra: string[] = [];
    for (const [name, count] of expectedSet) {
      const have = foundSet.get(name) ?? 0;
      for (let i = have; i < count; i++) missing.push(name);
    }
    for (const [name, count] of foundSet) {
      const need = expectedSet.get(name) ?? 0;
      for (let i = need; i < count; i++) extra.push(name);
    }

    const suiteResult: SuiteResult = {
      yaml: yaml.basename,
      expected: expected.length,
      found: names.length,
      missing,
      extra,
      fileExists,
      empty,
      skipHits,
    };
    result.suites.push(suiteResult);
    result.totalExpected += expected.length;
    result.totalFound += names.length;
    result.totalSkips += skipHits.length;
    if (empty) result.emptyFiles += 1;
    if (!fileExists) result.missingFiles += 1;
    if (!fileExists || empty || missing.length > 0 || extra.length > 0 || skipHits.length > 0) {
      result.pass = false;
    }
  }
  return result;
}

function countNames(names: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
  return m;
}

const PASS = '✓';
const FAIL = '✗';
const WARN = '⚠';
const PEND = '⏳';

function printParityReport(suites: YamlSuite[], results: SdkResult[]): boolean {
  const totalCases = suites.reduce((a, s) => a + s.caseNames.length, 0);
  const overallPass = results.every((r) => r.pass);

  console.log('');
  console.log('=== Parity check ===');
  console.log('');
  console.log(`YAML files: ${suites.length}`);
  console.log(`YAML cases total: ${totalCases}`);
  console.log('');

  for (const r of results) {
    const status = r.pass ? PASS : FAIL;
    const skipFrag = r.totalSkips === 0 ? '0 skips' : `${r.totalSkips} skips`;
    const missingFrag = r.missingFiles > 0 ? `, ${r.missingFiles} missing files` : '';
    const emptyFrag = r.emptyFiles > 0 ? `, ${r.emptyFiles} empty files` : '';
    console.log(
      `  ${status} ${r.name.padEnd(12)} ${r.totalFound}/${r.totalExpected} (${skipFrag}${missingFrag}${emptyFrag})`,
    );
  }
  console.log('');

  for (const r of results) {
    const failingSuites = r.suites.filter(
      (s) => !s.fileExists || s.empty || s.missing.length > 0 || s.extra.length > 0 || s.skipHits.length > 0,
    );
    if (failingSuites.length === 0) continue;
    console.log(`-- ${r.name} --`);
    for (const s of failingSuites) {
      if (!s.fileExists) {
        console.log(`  ${FAIL} ${s.yaml}: file missing`);
        continue;
      }
      if (s.empty) {
        console.log(`  ${FAIL} ${s.yaml}: file is empty (no tests)`);
        continue;
      }
      for (const m of s.missing) {
        console.log(`  ${FAIL} ${s.yaml}: MISSING in ${r.name}: "${m}"`);
      }
      for (const m of s.extra) {
        console.log(`  ${FAIL} ${s.yaml}: EXTRA in ${r.name}: "${m}"`);
      }
      for (const sh of s.skipHits) {
        console.log(`  ${FAIL} ${shortPath(sh.file)}:${sh.line} skip "${sh.label}" -> ${sh.text}`);
      }
    }
    console.log('');
  }

  console.log(`Parity check: ${overallPass ? 'PASS' : 'FAIL'}`);
  return overallPass;
}

function shortPath(p: string): string {
  const root = resolve(siblingsRoot());
  return p.startsWith(root + '/') ? p.slice(root.length + 1) : p;
}

interface WorkflowRun {
  databaseId?: number;
  status?: string;
  conclusion?: string | null;
  name?: string;
  headSha?: string;
  event?: string;
  url?: string;
}

interface Workflow {
  id: number;
  name: string;
  state: string;
  path: string;
}

function ghAvailable(): { ok: true } | { ok: false; reason: string } {
  try {
    execFileSync('gh', ['--version'], { stdio: 'pipe' });
  } catch {
    return {
      ok: false,
      reason:
        "`gh` CLI not found. Install with `brew install gh` (macOS) or see https://cli.github.com/, then `gh auth login`.",
    };
  }
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      reason: `\`gh auth status\` failed (run \`gh auth login\` to authenticate): ${(msg.split('\n')[0] ?? msg)}`,
    };
  }
  return { ok: true };
}

function getRepoSlug(repoDir: string): string | null {
  if (!existsSync(repoDir)) return null;
  try {
    const url = execFileSync('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
    return parseRepoSlug(url);
  } catch {
    return null;
  }
}

export function parseRepoSlug(url: string): string | null {
  // ssh: git@github.com:owner/repo.git
  // https: https://github.com/owner/repo(.git)
  let m = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (m) return `${m[1]}/${m[2]}`;
  m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (m) return `${m[1]}/${m[2]}`;
  return null;
}

function listWorkflows(slug: string): Workflow[] {
  const stdout = execFileSync(
    'gh',
    ['api', `repos/${slug}/actions/workflows`, '--jq', '.workflows[] | select(.state=="active")'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ).toString();
  const out: Workflow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Workflow;
      out.push(obj);
    } catch {
      // ignore parse errors
    }
  }
  return out;
}

function latestRun(slug: string, workflowId: number, branch: string): WorkflowRun | null {
  const stdout = execFileSync(
    'gh',
    [
      'run',
      'list',
      '--repo',
      slug,
      '--branch',
      branch,
      '--workflow',
      String(workflowId),
      '--limit',
      '1',
      '--json',
      'status,conclusion,name,headSha,event,url,databaseId',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ).toString();
  const arr = JSON.parse(stdout) as WorkflowRun[];
  return arr[0] ?? null;
}

function defaultBranch(repoDir: string): string {
  try {
    const ref = execFileSync('git', ['-C', repoDir, 'symbolic-ref', 'refs/remotes/origin/HEAD'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
    const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (m && m[1]) return m[1];
  } catch {
    // fall through
  }
  return 'main';
}

interface ActionsCheckResult {
  pass: boolean;
  perRepo: { name: string; slug: string | null; rows: ActionsRow[] }[];
}

interface ActionsRow {
  workflow: string;
  symbol: string;
  text: string;
  ok: boolean;
}

function checkGithubActions(sdks: SdkSpec[]): ActionsCheckResult {
  const result: ActionsCheckResult = { pass: true, perRepo: [] };

  // Include integration-test-data itself if it has workflows.
  const itd: SdkSpec = {
    name: 'integration-test-data',
    repoDir: repoRoot(),
    testDir: '',
    filename: () => '',
    parser: 'ruby',
    skipPatterns: [],
  };
  const all: SdkSpec[] = [...sdks, itd];

  for (const sdk of all) {
    const slug = getRepoSlug(sdk.repoDir);
    if (!slug) {
      result.perRepo.push({
        name: sdk.name,
        slug: null,
        rows: [
          {
            workflow: '(no remote)',
            symbol: WARN,
            text: `cannot resolve GitHub slug from ${sdk.repoDir}`,
            ok: false,
          },
        ],
      });
      // Don't fail the actions check just because integration-test-data isn't
      // a sibling repo — only flag it as a warning. Other SDKs do count.
      if (sdk.name !== 'integration-test-data') result.pass = false;
      continue;
    }

    const branch = defaultBranch(sdk.repoDir);
    let workflows: Workflow[] = [];
    try {
      workflows = listWorkflows(slug);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.perRepo.push({
        name: sdk.name,
        slug,
        rows: [{ workflow: '(api error)', symbol: WARN, text: (msg.split('\n')[0] ?? msg), ok: false }],
      });
      result.pass = false;
      continue;
    }

    if (workflows.length === 0) {
      result.perRepo.push({
        name: sdk.name,
        slug,
        rows: [
          {
            workflow: '(none)',
            symbol: WARN,
            text: 'no active workflows',
            ok: false,
          },
        ],
      });
      // Treat missing workflows as a real fail for SDK repos; informational
      // for integration-test-data (it may genuinely not have CI yet).
      if (sdk.name !== 'integration-test-data') result.pass = false;
      continue;
    }

    const rows: ActionsRow[] = [];
    for (const wf of workflows) {
      let run: WorkflowRun | null = null;
      try {
        run = latestRun(slug, wf.id, branch);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        rows.push({
          workflow: wf.name,
          symbol: WARN,
          text: `gh error: ${(msg.split('\n')[0] ?? msg)}`,
          ok: false,
        });
        result.pass = false;
        continue;
      }
      if (!run) {
        rows.push({
          workflow: wf.name,
          symbol: WARN,
          text: `no recent runs on ${branch}`,
          ok: false,
        });
        result.pass = false;
        continue;
      }
      rows.push(formatRunRow(wf, run, slug));
      if (!isPassingRun(run)) result.pass = false;
    }
    result.perRepo.push({ name: sdk.name, slug, rows });
  }
  return result;
}

function isPassingRun(run: WorkflowRun): boolean {
  return run.status === 'completed' && run.conclusion === 'success';
}

function formatRunRow(wf: Workflow, run: WorkflowRun, slug: string): ActionsRow {
  const sha = (run.headSha ?? '').slice(0, 7);
  const url = run.url ?? `https://github.com/${slug}/actions/runs/${run.databaseId}`;
  if (run.status === 'completed') {
    if (run.conclusion === 'success') {
      return {
        workflow: wf.name,
        symbol: PASS,
        text: `"${wf.name}" success (${sha})`,
        ok: true,
      };
    }
    return {
      workflow: wf.name,
      symbol: FAIL,
      text: `"${wf.name}" ${run.conclusion ?? 'unknown'} (${sha}) -- ${url}`,
      ok: false,
    };
  }
  return {
    workflow: wf.name,
    symbol: PEND,
    text: `"${wf.name}" ${run.status ?? 'unknown'} (${sha}) -- ${url}`,
    ok: false,
  };
}

function printActionsReport(report: ActionsCheckResult): void {
  console.log('');
  console.log('=== GitHub Actions ===');
  console.log('');
  for (const repo of report.perRepo) {
    const slugStr = repo.slug ? ` (${repo.slug})` : '';
    console.log(`  ${repo.name}${slugStr}`);
    for (const row of repo.rows) {
      console.log(`    ${row.symbol} ${row.text}`);
    }
  }
  console.log('');
  console.log(`GitHub Actions: ${report.pass ? 'PASS' : 'FAIL'}`);
}

async function main(): Promise<void> {
  const sdks = buildSdks();
  const dataRoot = resolve(repoRoot(), 'tests', 'eval');
  if (!existsSync(dataRoot)) {
    console.error(`tests/eval not found at ${dataRoot}`);
    process.exit(2);
  }

  const suites = loadYamlSuites(dataRoot);

  const sdkResults: SdkResult[] = [];
  for (const sdk of sdks) {
    if (!existsSync(sdk.testDir)) {
      console.warn(`[${sdk.name}] WARN: test dir not found at ${sdk.testDir}`);
    }
    sdkResults.push(checkSdk(sdk, suites));
  }
  const parityPass = printParityReport(suites, sdkResults);

  // Layer 2: GitHub Actions
  const gh = ghAvailable();
  let actionsPass = false;
  if (!gh.ok) {
    console.log('');
    console.log('=== GitHub Actions ===');
    console.log('');
    console.log(`  ${FAIL} ${gh.reason}`);
    console.log('');
    console.log('GitHub Actions: FAIL');
  } else {
    const report = checkGithubActions(sdks);
    printActionsReport(report);
    actionsPass = report.pass;
  }

  console.log('');
  console.log('=== Summary ===');
  console.log(`  Parity check:    ${parityPass ? 'PASS' : 'FAIL'}`);
  console.log(`  GitHub Actions:  ${actionsPass ? 'PASS' : 'FAIL'}`);

  if (!parityPass || !actionsPass) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error((e as Error).stack ?? (e as Error).message);
  process.exit(1);
});

// Quiet unused-import warnings under strict tsc:
void statSync;
