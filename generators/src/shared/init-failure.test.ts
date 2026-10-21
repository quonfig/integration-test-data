import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { YamlCase } from '../types.js';
import { hasUrlLegs, initFailureClient, initRaiseExpectation, isInitFailureCase, uniformStatus } from './init-failure.js';

const refused = ['http://127.0.0.1:1', 'http://127.0.0.1:2'];

function kase(overrides: Record<string, unknown>, extra: Partial<YamlCase> = {}): YamlCase {
  return { name: 'c', function: 'init', client_overrides: overrides, ...extra };
}

test('init-failure overrides mark a case; plain eval cases are not', () => {
  assert.equal(isInitFailureCase(kase({ init_timeout_ms: 500, api_urls: refused })), true);
  assert.equal(isInitFailureCase(kase({ api_status: 401, init_timeout_ms: 500 })), true);
  assert.equal(isInitFailureCase(kase({ on_no_default: 2 })), false);
  assert.equal(isInitFailureCase({ name: 'plain' }), false);
});

test('canonical values pass through; absent means the SDK default (fail)', () => {
  const c = initFailureClient(kase({ init_timeout_ms: 500, api_urls: refused }));
  assert.deepEqual(c, { onInitFailure: null, mode: 'fail', apiUrls: refused, apiStatuses: null, apiBody: null, initTimeoutMs: 500 });
  assert.equal(initFailureClient(kase({ on_init_failure: 'continue', init_timeout_ms: 1, api_urls: refused })).mode, 'continue');
  assert.equal(initFailureClient(kase({ on_init_failure: 'wait', init_timeout_ms: 1, api_urls: refused })).mode, 'wait');
});

test('deprecated aliases keep their spelling and map to the canonical mode', () => {
  const r = initFailureClient(kase({ on_init_failure: ':raise', init_timeout_ms: 1, api_urls: refused }));
  assert.equal(r.onInitFailure, 'raise');
  assert.equal(r.mode, 'fail');
  const t = initFailureClient(kase({ on_init_failure: 'return', init_timeout_ms: 1, api_urls: refused }));
  assert.equal(t.onInitFailure, 'return');
  assert.equal(t.mode, 'continue');
});

test('api_status replaces api_urls with a local status server per leg', () => {
  const c = initFailureClient(kase({ api_status: 401, init_timeout_ms: 8000 }));
  assert.deepEqual(c.apiStatuses, [401, 401]);
  assert.equal(c.apiBody, null);
  assert.equal(uniformStatus(c), 401);
  assert.deepEqual(c.apiUrls, []);
});

test('api_status list sets one status per leg, in order', () => {
  const c = initFailureClient(kase({ api_status: [401, 503], init_timeout_ms: 1500 }));
  assert.deepEqual(c.apiStatuses, [401, 503]);
  assert.equal(uniformStatus(c), null);
  assert.equal(uniformStatus(initFailureClient(kase({ api_status: [404, 404], init_timeout_ms: 1 }))), 404);
  assert.throws(() => initFailureClient(kase({ api_status: [], init_timeout_ms: 1 })), /at least one leg/);
  assert.throws(() => initFailureClient(kase({ api_status: [401, 200], init_timeout_ms: 1 })), /HTTP error status/);
  assert.throws(() => initFailureClient(kase({ api_status: [401, '503'], init_timeout_ms: 1 })), /HTTP error status/);
});

test('api_status list may mix a local status leg with a verbatim URL leg', () => {
  const hung = 'http://192.0.2.1:8002';
  const c = initFailureClient(kase({ api_status: [401, hung], init_timeout_ms: 10000 }));
  assert.deepEqual(c.apiStatuses, [401, 0]);
  assert.deepEqual(c.apiUrls, ['', hung]);
  assert.equal(hasUrlLegs(c), true);
  assert.equal(uniformStatus(c), null);
  const r = initFailureClient(kase({ api_status: [hung, 503], init_timeout_ms: 1 }));
  assert.deepEqual(r.apiStatuses, [0, 503]);
  assert.deepEqual(r.apiUrls, [hung, '']);
  // Pure status lists keep apiUrls empty and have no URL legs.
  const p = initFailureClient(kase({ api_status: [401, 503], init_timeout_ms: 1 }));
  assert.deepEqual(p.apiUrls, []);
  assert.equal(hasUrlLegs(p), false);
  assert.throws(() => initFailureClient(kase({ api_status: [hung, hung], init_timeout_ms: 1 })), /at least one status leg/);
  assert.throws(() => initFailureClient(kase({ api_status: [401, 'ftp://x'], init_timeout_ms: 1 })), /HTTP error status/);
});

test('api_body is the local legs\' body and needs api_status', () => {
  const c = initFailureClient(kase({ api_status: 503, api_body: 'marker', init_timeout_ms: 500 }));
  assert.equal(c.apiBody, 'marker');
  assert.equal(uniformStatus(c), null, 'a body needs the full leg helper');
  assert.equal(isInitFailureCase(kase({ api_body: 'x' })), true);
  assert.throws(() => initFailureClient(kase({ api_urls: refused, api_body: 'marker', init_timeout_ms: 1 })), /needs api_status/);
  assert.throws(() => initFailureClient(kase({ api_status: 503, api_body: '', init_timeout_ms: 1 })), /non-empty/);
  assert.throws(() => initFailureClient(kase({ api_status: 503, api_body: 7, init_timeout_ms: 1 })), /non-empty/);
});

test('init_timeout_ms 0 is one attempt (Decision 8); negative fails', () => {
  assert.equal(initFailureClient(kase({ init_timeout_ms: 0, api_urls: refused })).initTimeoutMs, 0);
  assert.throws(() => initFailureClient(kase({ init_timeout_ms: -1, api_urls: refused })), /non-negative/);
  assert.throws(() => initFailureClient(kase({ init_timeout_ms: 1.5, api_urls: refused })), /non-negative/);
});

test('Prefab-era keys fail the generator with the new name', () => {
  assert.throws(() => initFailureClient(kase({ initialization_timeout_sec: 0.01, api_urls: refused })), /init_timeout_ms/);
  assert.throws(() => initFailureClient(kase({ prefab_api_url: 'http://x', init_timeout_ms: 1 })), /api_urls/);
});

test('malformed init-failure overrides fail the generator', () => {
  assert.throws(() => initFailureClient(kase({ on_init_failure: 'explode', init_timeout_ms: 1, api_urls: refused })));
  assert.throws(() => initFailureClient(kase({ api_urls: refused })), /init_timeout_ms/);
  assert.throws(() => initFailureClient(kase({ init_timeout_ms: 1 })), /api_urls or api_status/);
  assert.throws(() => initFailureClient(kase({ init_timeout_ms: 1, api_urls: refused, api_status: 401 })));
  assert.throws(() => initFailureClient(kase({ init_timeout_ms: 1, api_urls: [] })));
  assert.throws(() => initFailureClient(kase({ init_timeout_ms: 1, api_urls: refused, datadir: 'x' })), /datadir/);
});

test('init raise expectation: error, reason, bound', () => {
  const k = kase(
    { on_init_failure: 'fail', init_timeout_ms: 200, api_urls: ['http://192.0.2.1:1'] },
    { expected: { status: 'raise', error: 'initialization_timeout', reason: 'timeout', raises_within_ms: 2000 } },
  );
  assert.deepEqual(initRaiseExpectation(k), {
    error: 'initialization_timeout',
    reason: 'timeout',
    raisesWithinMs: 2000,
    messageExcludes: [],
  });
  const u = kase(
    { api_status: 401, init_timeout_ms: 8000 },
    { expected: { status: 'raise', error: 'init_failed', reason: 'unauthorized' } },
  );
  assert.deepEqual(initRaiseExpectation(u), { error: 'init_failed', reason: 'unauthorized', raisesWithinMs: null, messageExcludes: [] });
});

test('init raise expectation: message_excludes covers the message and cause chain; contains is rejected', () => {
  const overrides = { on_init_failure: 'fail', init_timeout_ms: 500, api_urls: ['http://u:secret@127.0.0.1:1'] };
  const raise = { status: 'raise', error: 'init_failed', reason: 'unavailable' };
  assert.deepEqual(initRaiseExpectation(kase(overrides, { expected: { ...raise, message_excludes: ['secret', 'u:'] } })).messageExcludes, [
    'secret',
    'u:',
  ]);
  assert.deepEqual(initRaiseExpectation(kase(overrides, { expected: { ...raise, message_excludes: 'secret' } })).messageExcludes, ['secret']);
  assert.throws(() => initRaiseExpectation(kase(overrides, { expected: { ...raise, message_excludes: [''] } })));
  assert.throws(() => initRaiseExpectation(kase(overrides, { expected: { ...raise, message_contains: 'init' } })), /message_contains/);
});

test('init raise expectation rejects inconsistent shapes', () => {
  const base = { on_init_failure: 'fail', init_timeout_ms: 200, api_urls: refused };
  // timeout error must carry reason timeout, and init_failed must not.
  assert.throws(() => initRaiseExpectation(kase(base, { expected: { status: 'raise', error: 'initialization_timeout', reason: 'unavailable' } })));
  assert.throws(() => initRaiseExpectation(kase(base, { expected: { status: 'raise', error: 'init_failed', reason: 'timeout' } })));
  assert.throws(() => initRaiseExpectation(kase(base, { expected: { status: 'raise', error: 'missing_default', reason: 'timeout' } })));
  // continue never raises from init.
  assert.throws(() =>
    initRaiseExpectation(kase({ ...base, on_init_failure: 'continue' }, { expected: { status: 'raise', error: 'init_failed', reason: 'unavailable' } })),
  );
  // function: init needs a raise expectation.
  assert.throws(() => initRaiseExpectation(kase(base, { expected: { value: 'x' } })));
});
