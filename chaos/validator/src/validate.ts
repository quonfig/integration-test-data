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

export function validateObject(doc: unknown): ValidationResult {
  const validate = getValidator();
  const ok = validate(doc);
  if (ok) return { valid: true, errors: null };
  const errs = (validate.errors ?? []).map(formatError);
  return { valid: false, errors: errs.length > 0 ? errs : ['unknown validation error'] };
}
