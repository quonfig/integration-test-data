import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeContexts } from './contexts.js';

// Documented rule (docs: concepts/context.md, "Adding to and Merging
// Contexts"; decided in qfg-2agi.24): a newer tier that supplies a named
// context REPLACES that whole named context. Named contexts the newer tier
// does not mention survive.

test('newer tier replaces the whole same-named context (disjoint attributes)', () => {
  const merged = mergeContexts({
    global: { user: { email: 'a@prefab.cloud' } },
    local: { user: { plan: 'pro' } },
  });
  assert.deepEqual(merged, { user: { plan: 'pro' } });
});

test('block tier replaces global, local replaces block', () => {
  const merged = mergeContexts({
    global: { user: { email: 'a@prefab.cloud', name: 'g' } },
    block: { user: { name: 'b' } },
    local: { user: { plan: 'pro' } },
  });
  assert.deepEqual(merged, { user: { plan: 'pro' } });
});

test('named contexts the newer tier does not mention survive', () => {
  const merged = mergeContexts({
    global: { user: { email: 'a@prefab.cloud' }, team: { key: 't1' } },
    local: { team: { key: 't2' } },
  });
  assert.deepEqual(merged, { user: { email: 'a@prefab.cloud' }, team: { key: 't2' } });
});

test('missing / empty input yields an empty map', () => {
  assert.deepEqual(mergeContexts(undefined), {});
  assert.deepEqual(mergeContexts(null), {});
  assert.deepEqual(mergeContexts({}), {});
});
