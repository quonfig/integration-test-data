// CLI entry point. Selects targets via `--target=<name>` (repeatable) or
// runs all known targets when no flag is given. Unimplemented targets emit
// a friendly TBD note and exit 0 so the default invocation doesn't fail.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRubyTarget } from './targets/ruby.js';
import { runNodeTarget } from './targets/node.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const KNOWN_TARGETS = ['ruby', 'go', 'node', 'python'] as const;
type Target = (typeof KNOWN_TARGETS)[number];

interface CliArgs {
  targets: Target[];
}

function parseArgs(argv: string[]): CliArgs {
  const targets: Target[] = [];
  for (const arg of argv) {
    if (arg.startsWith('--target=')) {
      const v = arg.slice('--target='.length);
      if (!(KNOWN_TARGETS as readonly string[]).includes(v)) {
        throw new Error(
          `unknown --target=${v}. Known: ${KNOWN_TARGETS.join(', ')}`,
        );
      }
      targets.push(v as Target);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg.length > 0) {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  if (targets.length === 0) {
    return { targets: [...KNOWN_TARGETS] };
  }
  return { targets };
}

function printHelp(): void {
  console.log(
    [
      'Usage: npm run generate -- [--target=<name>]',
      '',
      'Targets:',
      '  ruby     sdk-ruby/test/integration/test_*.rb (Minitest)',
      '  go       not yet implemented',
      '  node     sdk-node/test/integration/*.generated.test.ts (Vitest)',
      '  python   not yet implemented',
      '',
      'Pass --target multiple times to run a subset; default is all.',
    ].join('\n'),
  );
}

function repoRoot(): string {
  // src/index.ts lives at integration-test-data/generators/src/index.ts; go up
  // two levels to land on integration-test-data/.
  return resolve(__dirname, '..', '..');
}

async function main(): Promise<void> {
  const { targets } = parseArgs(process.argv.slice(2));
  const dataRoot = resolve(repoRoot(), 'tests', 'eval');

  let hadError = false;
  for (const target of targets) {
    try {
      switch (target) {
        case 'ruby': {
          const outDir = resolve(repoRoot(), '..', 'sdk-ruby', 'test', 'integration');
          console.log(`[ruby] reading ${dataRoot}`);
          console.log(`[ruby] writing to ${outDir}`);
          const result = runRubyTarget(dataRoot, outDir);
          for (const w of result.written) {
            console.log(`[ruby] wrote ${w.path}: ${w.cases} cases`);
          }
          break;
        }
        case 'node': {
          const outDir = resolve(repoRoot(), '..', 'sdk-node', 'test', 'integration');
          console.log(`[node] reading ${dataRoot}`);
          console.log(`[node] writing to ${outDir}`);
          const result = runNodeTarget(dataRoot, outDir);
          for (const w of result.written) {
            console.log(`[node] wrote ${w.path}: ${w.cases} cases`);
          }
          break;
        }
        case 'go':
        case 'python':
          console.log(`[${target}] not yet implemented — coming in a follow-up agent.`);
          break;
      }
    } catch (e) {
      hadError = true;
      console.error(`[${target}] FAILED: ${(e as Error).message}`);
    }
  }
  if (hadError) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
