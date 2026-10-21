// sdk-ruby runs rubocop over test/integration with Style/NumericLiterals on
// (MinDigits 5): an integer literal of five or more digits needs `_`
// separators (10_000, not 10000). Render every suite and check the code
// outside string literals and comments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRubyTarget } from '../targets/ruby.js';

const dataRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'eval');

/** Ruby source with string literals, %w[] arrays and comments blanked out. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .map((line) =>
      line
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/%w\[[^\]]*\]/g, '%w[]')
        .replace(/#.*$/, ''),
    )
    .join('\n');
}

test('generated Ruby has no unseparated integer literal of five or more digits', () => {
  const out = mkdtempSync(join(tmpdir(), 'itd-ruby-'));
  try {
    const { written } = runRubyTarget(dataRoot, out);
    assert.ok(written.length > 0);
    let sawSeparated = false;
    for (const w of written) {
      const code = codeOnly(readFileSync(w.path, 'utf8'));
      const bad = code.match(/(?<![\w.])\d{5,}(?![\w])/g);
      assert.equal(bad, null, `${w.path}: ${bad?.join(', ')}`);
      if (/\b\d{1,3}(?:_\d{3})+\b/.test(code)) sawSeparated = true;
    }
    // get_or_raise.yaml carries init_timeout_ms 10000, which must render as 10_000.
    assert.ok(sawSeparated, 'expected at least one separated literal such as 10_000');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
