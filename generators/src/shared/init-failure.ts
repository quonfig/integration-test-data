// Init-failure cases (qfg-9p4i.6). Spec:
// project/plans/2026-10-05-init-failure-design.md, its "Decisions" section and
// sections B.1-B.4 and D. Every target parses an init-failure case through
// this module so the YAML shape is read identically everywhere and a case the
// target cannot express fails the generator instead of turning vacuous.
//
// client_overrides keys:
//   on_init_failure  fail | wait | continue, or the deprecated aliases
//                    raise (= fail) and return (= continue). A leading ':'
//                    (the old Ruby-symbol spelling) is stripped. Absent means
//                    "do not set the option": the SDK default, which is fail
//                    in every SDK (Decision 1). Targets pass the spelling
//                    through VERBATIM so an alias case exercises the SDK's
//                    alias path, not a generator-side rename.
//   init_timeout_ms  the SDK's initTimeout, in ms. Required.
//   api_urls         every delivery leg, in order (primary, secondary).
//   api_status       instead of api_urls: the test stands up one local HTTP
//                    server per leg (two legs) that answers EVERY request
//                    with this status (e.g. 401).
//
// The Prefab-era keys initialization_timeout_sec and prefab_api_url were
// dropped in the same tag (Decision 5). A case still carrying them fails here.

import type { YamlCase } from '../types.js';

export type InitFailureMode = 'fail' | 'wait' | 'continue';

const CANONICAL: readonly InitFailureMode[] = ['fail', 'wait', 'continue'];
const ALIASES: Readonly<Record<string, InitFailureMode>> = { raise: 'fail', return: 'continue' };

const INIT_KEYS = ['on_init_failure', 'init_timeout_ms', 'api_urls', 'api_status'] as const;
// Keys an init-failure case may carry next to INIT_KEYS: on_no_default only
// picks how a getter without a default reports "no value".
const COMPATIBLE_KEYS = new Set<string>(['on_no_default']);
const LEGACY_KEYS: Readonly<Record<string, string>> = {
  initialization_timeout_sec: 'init_timeout_ms',
  prefab_api_url: 'api_urls',
};

export interface InitFailureClient {
  /** Spelling to pass to the SDK (leading ':' stripped), or null for the SDK default. */
  onInitFailure: string | null;
  /** Canonical behavior the case expects (alias resolved; null spelling = fail). */
  mode: InitFailureMode;
  /** Delivery legs, in order. Empty when apiStatus is set. */
  apiUrls: string[];
  /** Status every local leg answers with, or null when apiUrls is used. */
  apiStatus: number | null;
  initTimeoutMs: number;
}

export type InitErrorKey = 'init_failed' | 'initialization_timeout';
export type InitFailureReason = 'unavailable' | 'unauthorized' | 'timeout';

export interface InitRaise {
  /**
   * initialization_timeout: the SDK's init-timeout error (go: errors.Is
   * ErrInitializationTimeout; elsewhere the QuonfigInitTimeout* subclass of
   * the init error). init_failed: the SDK's init error (QuonfigInitError
   * family, go: a non-nil error from NewClient) that is NOT the timeout one.
   */
  error: InitErrorKey;
  reason: InitFailureReason;
  /** Upper bound on the init call, start to raise, in ms; null = unbounded. */
  raisesWithinMs: number | null;
}

/** True when the case drives client construction through the init-failure keys. */
export function isInitFailureCase(kase: YamlCase): boolean {
  const o = kase.client_overrides;
  if (!o || typeof o !== 'object') return false;
  return [...INIT_KEYS, ...Object.keys(LEGACY_KEYS)].some((k) => k in o);
}

function positiveInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new Error(`client_overrides.${field} must be a positive integer (ms), got ${JSON.stringify(v)}`);
  }
  return v;
}

/** Parse and validate an init-failure case's client_overrides. */
export function initFailureClient(kase: YamlCase): InitFailureClient {
  const o = (kase.client_overrides ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k in LEGACY_KEYS) {
      throw new Error(`client_overrides.${k} is a Prefab-era key; use ${LEGACY_KEYS[k]}`);
    }
    if (!(INIT_KEYS as readonly string[]).includes(k) && !COMPATIBLE_KEYS.has(k)) {
      throw new Error(`client_overrides.${k} is not supported on an init-failure case`);
    }
  }

  let onInitFailure: string | null = null;
  let mode: InitFailureMode = 'fail';
  if ('on_init_failure' in o) {
    const raw = o.on_init_failure;
    if (typeof raw !== 'string') throw new Error('client_overrides.on_init_failure must be a string');
    const v = raw.replace(/^:/, '');
    if ((CANONICAL as readonly string[]).includes(v)) mode = v as InitFailureMode;
    else if (v in ALIASES) mode = ALIASES[v] as InitFailureMode;
    else throw new Error(`unknown on_init_failure ${JSON.stringify(raw)} (fail | wait | continue | raise | return)`);
    onInitFailure = v;
  }

  if (!('init_timeout_ms' in o)) throw new Error('init-failure case needs client_overrides.init_timeout_ms');
  const initTimeoutMs = positiveInt(o.init_timeout_ms, 'init_timeout_ms');

  const hasUrls = 'api_urls' in o;
  const hasStatus = 'api_status' in o;
  if (hasUrls === hasStatus) {
    throw new Error('init-failure case needs exactly one of client_overrides.api_urls or api_status');
  }
  let apiUrls: string[] = [];
  let apiStatus: number | null = null;
  if (hasUrls) {
    const u = o.api_urls;
    if (!Array.isArray(u) || u.length === 0 || u.some((s) => typeof s !== 'string' || !/^https?:\/\//.test(s))) {
      throw new Error('client_overrides.api_urls must be a non-empty list of http(s) URLs');
    }
    apiUrls = u as string[];
  } else {
    const s = o.api_status;
    if (typeof s !== 'number' || !Number.isInteger(s) || s < 400 || s > 599) {
      throw new Error(`client_overrides.api_status must be an HTTP error status, got ${JSON.stringify(s)}`);
    }
    apiStatus = s;
  }
  return { onInitFailure, mode, apiUrls, apiStatus, initTimeoutMs };
}

/** Parse the expectation of a `function: init` init-failure case. */
export function initRaiseExpectation(kase: YamlCase): InitRaise {
  const client = initFailureClient(kase);
  const e = kase.expected ?? {};
  if (e.status !== 'raise') throw new Error('function: init case needs expected.status: raise');
  if (client.mode === 'continue') throw new Error('on_init_failure continue never raises from init');
  if (client.mode === 'wait') throw new Error('on_init_failure wait blocks; it has no eval-case raise');
  const error = e.error;
  const reason = e.reason;
  if (error !== 'init_failed' && error !== 'initialization_timeout') {
    throw new Error(`init case expected.error must be init_failed or initialization_timeout, got ${JSON.stringify(error)}`);
  }
  if (reason !== 'unavailable' && reason !== 'unauthorized' && reason !== 'timeout') {
    throw new Error(`init case expected.reason must be unavailable, unauthorized or timeout, got ${JSON.stringify(reason)}`);
  }
  if ((error === 'initialization_timeout') !== (reason === 'timeout')) {
    throw new Error('expected.reason timeout goes with error initialization_timeout, and only with it');
  }
  let raisesWithinMs: number | null = null;
  if ('raises_within_ms' in e) {
    const w = e.raises_within_ms;
    if (typeof w !== 'number' || !Number.isInteger(w) || w <= 0) {
      throw new Error('expected.raises_within_ms must be a positive integer');
    }
    raisesWithinMs = w;
  }
  return { error, reason, raisesWithinMs };
}

/**
 * For a getter case (function get / get_or_raise) on an init-failure client:
 * init must return, which only continue guarantees.
 */
export function assertGetterAfterContinue(client: InitFailureClient): void {
  if (client.mode !== 'continue') {
    throw new Error(`a getter case on an init-failure client needs on_init_failure continue (or return), got ${client.mode}`);
  }
}
