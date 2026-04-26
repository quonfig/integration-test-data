import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import type { NormalizedCase, YamlDoc } from './types.js';

/**
 * Load a single YAML file, parse it, and flatten the
 *   { tests: [{ cases: [...] }, ...] }
 * structure into a single iterable of {@link NormalizedCase}.
 *
 * Group `name` is preserved on each case (the precedence YAMLs use named
 * groups; most other suites have unnamed groups). The YAML basename is also
 * preserved so generator errors can point at the source.
 */
export function loadYamlFile(filePath: string, yamlBasename: string): NormalizedCase[] {
  const raw = readFileSync(filePath, 'utf8');
  const doc = yaml.load(raw) as YamlDoc | null | undefined;
  if (!doc || typeof doc !== 'object') return [];

  const out: NormalizedCase[] = [];
  for (const group of doc.tests ?? []) {
    if (!group || typeof group !== 'object') continue;
    const groupName = typeof group.name === 'string' ? group.name : undefined;
    for (const c of group.cases ?? []) {
      if (!c || typeof c !== 'object') continue;
      out.push({
        yamlBasename,
        ...(groupName !== undefined ? { groupName } : {}),
        raw: c,
      });
    }
  }
  return out;
}
