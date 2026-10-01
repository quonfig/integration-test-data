import type { CaseContexts, ContextTypes } from '../types.js';

/**
 * Merge the three context tiers (global → block → local) into a single
 * `{ contextType: { prop: value, ... } }` map.
 *
 * Rule (docs: explanations/concepts/context.md, "Advanced: Adding to and
 * Merging Contexts"; decided in qfg-2agi.24): a later tier that supplies a
 * named context REPLACES that whole named context — the earlier tier's
 * attributes in it are dropped, not merged property by property. Named
 * contexts the later tier does not mention survive unchanged.
 *
 * Example: global `user{email}` + local `user{plan}` → `user{plan}` only.
 */
export function mergeContexts(contexts: CaseContexts | undefined | null): ContextTypes {
  if (!contexts || typeof contexts !== 'object') return {};

  const merged: ContextTypes = {};
  for (const tier of ['global', 'block', 'local'] as const) {
    const tierHash = contexts[tier];
    if (!tierHash || typeof tierHash !== 'object') continue;

    for (const [type, props] of Object.entries(tierHash)) {
      if (!props || typeof props !== 'object') continue;
      merged[type] = { ...(props as Record<string, unknown>) };
    }
  }
  return merged;
}
