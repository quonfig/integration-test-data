// Regenerate (or check) the qf1 test data from the vectors (bead qfg-8seuf.3).
//
//   npm run qf1:sync                      rewrite the fixtures from tests/secrets/qf1-vectors.json
//   npm run qf1:sync -- --from <path>     first copy <path> (project/plans/secrets-qf1/vectors.json)
//                                         to tests/secrets/qf1-vectors.json byte for byte
//   npm run qf1:check [-- --from <path>]  write nothing; exit 1 if the copy differs from <path>,
//                                         a fixture differs from what the vectors give, or
//                                         data/integration-tests/secrets/ holds a file the
//                                         manifest (src/shared/qf1-fixtures.ts) does not list
//
// Source: integration-test-data/generators/src/qf1-sync.ts

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_ROOT, QF1_VECTORS_PATH, renderQf1Fixtures, type Qf1Vectors } from './shared/qf1-fixtures.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface Qf1Drift {
  problems: string[];
}

/** Compare the repo's qf1 data with what the vectors give. `from`: the project vectors file, optional. */
export function qf1Drift(from?: string): Qf1Drift {
  const problems: string[] = [];
  const copyPath = resolve(repoRoot, QF1_VECTORS_PATH);
  const copy = readFileSync(copyPath);
  if (from !== undefined) {
    const source = readFileSync(resolve(from));
    if (!source.equals(copy)) problems.push(`${QF1_VECTORS_PATH} differs from ${from}; run npm run qf1:sync -- --from ${from}`);
  }
  const files = renderQf1Fixtures(JSON.parse(copy.toString('utf8')) as Qf1Vectors);
  for (const [rel, want] of files) {
    const abs = resolve(repoRoot, rel);
    if (!existsSync(abs)) problems.push(`${rel} is missing`);
    else if (readFileSync(abs, 'utf8') !== want) problems.push(`${rel} differs from what ${QF1_VECTORS_PATH} gives`);
  }
  const secretsDir = resolve(repoRoot, FIXTURE_ROOT, 'secrets');
  if (existsSync(secretsDir)) {
    for (const name of readdirSync(secretsDir)) {
      if (!files.has(`${FIXTURE_ROOT}/secrets/${name}`)) problems.push(`${FIXTURE_ROOT}/secrets/${name} is not in the qf1 fixture manifest`);
    }
  }
  return { problems };
}

function main(argv: string[]): void {
  let mode: 'sync' | 'check' | undefined;
  let from: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === 'sync' || a === 'check') mode = a;
    else if (a === '--from') from = argv[++i];
    else if (a.startsWith('--from=')) from = a.slice('--from='.length);
    else throw new Error(`unexpected argument: ${a}`);
  }
  if (!mode) throw new Error('usage: qf1-sync.ts sync|check [--from <vectors.json>]');
  if (from !== undefined && !existsSync(resolve(from))) throw new Error(`--from ${from}: no such file`);

  if (mode === 'check') {
    const { problems } = qf1Drift(from);
    for (const p of problems) console.error(`[qf1] ${p}`);
    if (problems.length > 0) process.exit(1);
    console.log(`[qf1] fixtures match ${QF1_VECTORS_PATH}${from ? ` and it matches ${from}` : ''}`);
    return;
  }

  const copyPath = resolve(repoRoot, QF1_VECTORS_PATH);
  if (from !== undefined) {
    mkdirSync(dirname(copyPath), { recursive: true });
    writeFileSync(copyPath, readFileSync(resolve(from)));
    console.log(`[qf1] copied ${from} -> ${QF1_VECTORS_PATH}`);
  }
  const files = renderQf1Fixtures(JSON.parse(readFileSync(copyPath, 'utf8')) as Qf1Vectors);
  for (const [rel, content] of files) {
    const abs = resolve(repoRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  console.log(`[qf1] wrote ${files.size} files under ${FIXTURE_ROOT}`);
  const { problems } = qf1Drift(from);
  for (const p of problems) console.error(`[qf1] ${p}`);
  if (problems.length > 0) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`[qf1] ${(e as Error).message}`);
    process.exit(1);
  }
}
