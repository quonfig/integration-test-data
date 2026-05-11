#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateYaml } from './validate.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCENARIOS = join(HERE, '..', '..', 'scenarios');

function collectYamlFiles(path: string): string[] {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => join(path, f));
}

function main(): void {
  const target = resolve(process.argv[2] ?? DEFAULT_SCENARIOS);
  const files = collectYamlFiles(target);
  if (files.length === 0) {
    console.error(`no YAML files found at ${target}`);
    process.exit(2);
  }
  let failed = 0;
  for (const f of files) {
    const r = validateYaml(readFileSync(f, 'utf8'));
    if (r.valid) {
      console.log(`ok ${f}`);
    } else {
      failed += 1;
      console.error(`FAIL ${f}`);
      for (const e of r.errors!) console.error(`  - ${e}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed}/${files.length} scenarios failed validation`);
    process.exit(1);
  }
  console.log(`\n${files.length}/${files.length} scenarios valid`);
}

main();
