import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMalformedDurationWithDefault } from './malformed-duration.js';

test('malformed duration key read with its default -> Reason=ERROR case', () => {
  assert.equal(
    isMalformedDurationWithDefault('DURATION', 'test.duration.malformed.30s', { default: 7000 }, 7000),
    true,
  );
  assert.equal(
    isMalformedDurationWithDefault('DURATION', 'provided.duration.malformed.P1DT', { default: 7000 }, 7000),
    true,
  );
});

test('no default or non-DURATION -> not a malformed-with-default case', () => {
  assert.equal(isMalformedDurationWithDefault('DURATION', 'test.duration.malformed.30s', {}, undefined), false);
  assert.equal(isMalformedDurationWithDefault('STRING', 'x', { default: 'a' }, undefined), false);
});

test('DURATION default on a non-malformed key fails the generator', () => {
  assert.throws(() => isMalformedDurationWithDefault('DURATION', 'test.duration.PT1S', { default: 7000 }, 1000));
});

test('malformed key that does not expect its default fails the generator', () => {
  assert.throws(() =>
    isMalformedDurationWithDefault('DURATION', 'test.duration.malformed.30s', { default: 7000 }, 30000),
  );
});
