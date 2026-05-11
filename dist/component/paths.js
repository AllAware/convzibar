/**
 * Helpers for canonicalising and keying an effective-relationship path.
 *
 * A `path` is `{ baseIds: string[], conditions?: {condition, conditionContext}[] }`.
 * The BFS code needs two canonical forms:
 *
 *   • A "canonical path" with de-duplicated / sorted `baseIds`, suitable for
 *     *writing* back into the `paths` array.
 *   • A "path key" — a stable string hash of a path, suitable for *comparing*
 *     two paths for equivalence (order-independent on both baseIds and
 *     conditions).
 *
 * Both the hot add-path BFS (`processAddChunk`) and the rebuild walker
 * (`expandTraversalRules` in `unsafe.ts`) go through these helpers so the
 * canonical form stays consistent.
 */
export function canonicalizePath(p) {
    return {
        baseIds: [...new Set(p.baseIds || [])].sort(),
        conditions: p.conditions,
    };
}
/**
 * Stable string hash of a path, order-independent on baseIds and conditions.
 * Two paths with the same content produce the same key.
 */
export function pathKey(p) {
    const baseIds = [...new Set(p.baseIds || [])].sort();
    const conditions = p.conditions
        ? [...p.conditions].map((c) => JSON.stringify(c)).sort()
        : undefined;
    return JSON.stringify({ baseIds, conditions });
}
//# sourceMappingURL=paths.js.map