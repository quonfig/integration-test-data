import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wroteLine } from './progress.js';

// actions/setup-go's problem matcher (matchers.json, owner "go").
const GO_MATCHER = /^\s*(.+\.go):(?:(\d+):(\d+):)? (.*)/;
// actions/setup-dotnet's csc matcher and setup-node's tsc matcher, for good measure.
const CSC_MATCHER = /^([^\s].*)\((\d+)(?:,\d+|,\d+,\d+)?\):\s+(error|warning)\s+([a-zA-Z]+\d+):\s*(.*?)\s+\[(.*?)\]$/;
const TSC_MATCHER = /^([^\s].*)[(:](\d+)[,:](\d+)(?:\):\s+|\s+-\s+)(error|warning|info)\s+TS(\d+)\s*:\s*(.*)$/;

const paths = [
  '/home/runner/work/sdk-go/sdk-go/internal/fixtures/get_or_raise_generated_test.go',
  'D:\\a\\sdk-net\\sdk-net\\tests\\Quonfig.Sdk.Tests\\Integration\\GetOrRaiseTests.cs',
  '/w/sdk-node/test/integration/get_or_raise.generated.test.ts',
];

test('a wrote line names the target, the count and the path', () => {
  assert.equal(wroteLine('go', '/x/a_generated_test.go', 125), '[go] wrote 125 cases to /x/a_generated_test.go');
});

test('no wrote line matches a CI problem matcher', () => {
  for (const p of paths) {
    const line = wroteLine('t', p, 125);
    for (const m of [GO_MATCHER, CSC_MATCHER, TSC_MATCHER]) {
      assert.equal(m.test(line), false, `${m} matched ${line}`);
    }
  }
  // The shape it replaces did match: the regression this guards against.
  assert.equal(GO_MATCHER.test(`[go] wrote ${paths[0]}: 125 cases`), true);
});
