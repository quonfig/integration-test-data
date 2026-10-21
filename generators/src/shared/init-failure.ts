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
//   init_timeout_ms  the SDK's initTimeout, in ms. Required. 0 is allowed:
//                    Decision 8 (qfg-9p4i.17), initTimeout <= 0 runs exactly
//                    one attempt and then applies on_init_failure.
//   api_urls         every delivery leg, in order (primary, secondary). May
//                    carry URL userinfo (http://user:pass@host) to prove the
//                    SDK never echoes it (Decision 9).
//   api_status       instead of api_urls: the test stands up one local HTTP
//                    server per leg that answers EVERY request with a status.
//                    A number = two legs answering that status (e.g. 401). A
//                    list = one leg per entry, in order, e.g. [401, 503] =
//                    primary 401, secondary 503. A list entry may instead be
//                    an http(s) URL, used as that leg verbatim, to mix a
//                    local status leg with an unreachable one: [401,
//                    "http://192.0.2.1:8002"] = primary 401, secondary hangs.
//                    The list needs at least one status entry.
//   api_body         with api_status only: the response body every local leg
//                    sends (e.g. a marker the init error must not echo).
//
// expected keys on a function: init case (initRaiseExpectation):
//   error, reason, raises_within_ms, and message_excludes: substrings that
//   must appear in neither the init error's message nor any message in its
//   cause chain (go: Error() of every errors.Unwrap step; node: .cause;
//   python: __cause__/__context__; ruby: #cause; java: getCause();
//   net: InnerException). message_contains is not supported on init cases.
//
// The Prefab-era keys initialization_timeout_sec and prefab_api_url were
// dropped in the same tag (Decision 5). A case still carrying them fails here.

import type { YamlCase } from '../types.js';
import { messageExpectations } from './message-and-redaction.js';

export type InitFailureMode = 'fail' | 'wait' | 'continue';

const CANONICAL: readonly InitFailureMode[] = ['fail', 'wait', 'continue'];
const ALIASES: Readonly<Record<string, InitFailureMode>> = { raise: 'fail', return: 'continue' };

const INIT_KEYS = ['on_init_failure', 'init_timeout_ms', 'api_urls', 'api_status', 'api_body'] as const;
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
  /**
   * Delivery legs, in order. When apiStatuses is set this is empty, or (a
   * mixed list) the same length as apiStatuses with the verbatim URL of each
   * leg whose status is 0 and '' for each local status leg.
   */
  apiUrls: string[];
  /**
   * One local leg per entry, answering every request with that status, in
   * leg order; 0 = the leg is apiUrls[i] instead. null when apiUrls alone
   * is used. A scalar api_status is two equal entries.
   */
  apiStatuses: number[] | null;
  /** Response body of every local leg (api_body), or null for an empty body. */
  apiBody: string | null;
  /** >= 0; 0 = exactly one attempt (Decision 8). */
  initTimeoutMs: number;
}

/** The single status every local leg answers when they all agree and send no body, else null. */
export function uniformStatus(ic: InitFailureClient): number | null {
  const s = ic.apiStatuses;
  if (s === null || ic.apiBody !== null || s.length !== 2 || s[0] === 0) return null;
  return s.every((v) => v === s[0]) ? (s[0] as number) : null;
}

/** True when an api_status list mixes local status legs with verbatim URL legs. */
export function hasUrlLegs(ic: InitFailureClient): boolean {
  return ic.apiStatuses !== null && ic.apiStatuses.some((v) => v === 0);
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
  /** Substrings absent from the init error's message and its whole cause chain. */
  messageExcludes: string[];
}

/** True when the case drives client construction through the init-failure keys. */
export function isInitFailureCase(kase: YamlCase): boolean {
  const o = kase.client_overrides;
  if (!o || typeof o !== 'object') return false;
  return [...INIT_KEYS, ...Object.keys(LEGACY_KEYS)].some((k) => k in o);
}

function nonNegativeInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new Error(`client_overrides.${field} must be a non-negative integer (ms), got ${JSON.stringify(v)}`);
  }
  return v;
}

function httpErrorStatus(s: unknown): number {
  if (typeof s !== 'number' || !Number.isInteger(s) || s < 400 || s > 599) {
    throw new Error(`client_overrides.api_status must be an HTTP error status (or a list of them), got ${JSON.stringify(s)}`);
  }
  return s;
}

const HTTP_URL = /^https?:\/\//;

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
  const initTimeoutMs = nonNegativeInt(o.init_timeout_ms, 'init_timeout_ms');

  const hasUrls = 'api_urls' in o;
  const hasStatus = 'api_status' in o;
  if (hasUrls === hasStatus) {
    throw new Error('init-failure case needs exactly one of client_overrides.api_urls or api_status');
  }
  let apiUrls: string[] = [];
  let apiStatuses: number[] | null = null;
  let apiBody: string | null = null;
  if (hasUrls) {
    const u = o.api_urls;
    if (!Array.isArray(u) || u.length === 0 || u.some((s) => typeof s !== 'string' || !HTTP_URL.test(s))) {
      throw new Error('client_overrides.api_urls must be a non-empty list of http(s) URLs');
    }
    apiUrls = u as string[];
    if ('api_body' in o) throw new Error('client_overrides.api_body needs api_status (it is the local legs\' body)');
  } else {
    const s = o.api_status;
    if (Array.isArray(s)) {
      if (s.length === 0) throw new Error('client_overrides.api_status list must name at least one leg');
      const isUrl = (v: unknown): v is string => typeof v === 'string' && HTTP_URL.test(v);
      apiStatuses = s.map((v) => (isUrl(v) ? 0 : httpErrorStatus(v)));
      if (apiStatuses.every((v) => v === 0)) {
        throw new Error('client_overrides.api_status list needs at least one status leg (use api_urls for URLs only)');
      }
      if (apiStatuses.some((v) => v === 0)) apiUrls = s.map((v) => (isUrl(v) ? v : ''));
    } else {
      const v = httpErrorStatus(s);
      apiStatuses = [v, v];
    }
    if ('api_body' in o) {
      const b = o.api_body;
      if (typeof b !== 'string' || b.length === 0) throw new Error('client_overrides.api_body must be a non-empty string');
      apiBody = b;
    }
  }
  return { onInitFailure, mode, apiUrls, apiStatuses, apiBody, initTimeoutMs };
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
  const msg = messageExpectations(e);
  if (msg.contains.length > 0) throw new Error('expected.message_contains is not supported on a function: init case');
  return { error, reason, raisesWithinMs, messageExcludes: msg.excludes };
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
