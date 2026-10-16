import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import Ajv, { type ErrorObject } from 'ajv';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, '..', '..', 'schema', 'scenario.schema.json');

export type ValidationResult =
  | { valid: true; errors: null }
  | { valid: false; errors: string[] };

let cachedValidator: ((data: unknown) => boolean) & { errors?: ErrorObject[] | null };

function getValidator(): typeof cachedValidator {
  if (!cachedValidator) {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const ajv = new Ajv({ allErrors: true, strict: false });
    cachedValidator = ajv.compile(schema);
  }
  return cachedValidator;
}

function formatError(e: ErrorObject): string {
  const path = e.instancePath || '/';
  const detail = e.params ? JSON.stringify(e.params) : '';
  return `${path} ${e.message ?? 'invalid'} ${detail}`.trim();
}

export function validateYaml(source: string): ValidationResult {
  let doc: unknown;
  try {
    doc = yaml.load(source);
  } catch (err) {
    return { valid: false, errors: [`yaml parse error: ${(err as Error).message}`] };
  }
  return validateObject(doc);
}

type Expectation = { within_ms: number; after_ms?: number; must_hold_for_ms?: number };

// Cross-field timing checks draft-07 cannot express. Runs only on a
// schema-valid doc, so the fields are known to be integers.
function timingErrors(doc: unknown): string[] {
  const errs: string[] = [];
  const tests = (doc as { tests?: { expectations?: Expectation[] }[] }).tests ?? [];
  tests.forEach((t, ti) => {
    (t.expectations ?? []).forEach((e, ei) => {
      const path = `/tests/${ti}/expectations/${ei}`;
      const after = e.after_ms ?? 0;
      const hold = e.must_hold_for_ms ?? 0;
      if (e.after_ms !== undefined && after >= e.within_ms) {
        errs.push(`${path} after_ms (${after}) must be < within_ms (${e.within_ms})`);
      } else if (after + hold > e.within_ms) {
        errs.push(
          e.after_ms === undefined
            ? `${path} must_hold_for_ms (${hold}) must be <= within_ms (${e.within_ms})`
            : `${path} after_ms + must_hold_for_ms (${after} + ${hold}) must be <= within_ms (${e.within_ms})`,
        );
      }
    });
  });
  return errs;
}

export function validateObject(doc: unknown): ValidationResult {
  const validate = getValidator();
  const ok = validate(doc);
  if (!ok) {
    const errs = (validate.errors ?? []).map(formatError);
    return { valid: false, errors: errs.length > 0 ? errs : ['unknown validation error'] };
  }
  const timing = timingErrors(doc);
  if (timing.length > 0) return { valid: false, errors: timing };
  return { valid: true, errors: null };
}
