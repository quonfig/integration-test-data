import type { CaseContexts, ContextTypes } from '../types.js';

/**
 * Merge the three context tiers (global → block → local) into a single
 * `{ contextType: { prop: value, ... } }` map, with later tiers overriding
 * earlier ones at the property level. Mirrors the precedence used by every
 * SDK's runtime resolver and matches the reference Ruby implementation
 * (`merge_contexts` in the now-deleted Ruby generator).
 */
export function mergeContexts(contexts: CaseContexts | undefined | null): ContextTypes {
  if (!contexts || typeof contexts !== 'object') return {};

  const merged: ContextTypes = {};
  for (const tier of ['global', 'block', 'local'] as const) {
    const tierHash = contexts[tier];
    if (!tierHash || typeof tierHash !== 'object') continue;

    for (const [type, props] of Object.entries(tierHash)) {
      if (!props || typeof props !== 'object') continue;
      const dest = (merged[type] ??= {});
      for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
        dest[k] = v;
      }
    }
  }
  return merged;
}
