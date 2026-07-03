/**
 * Helpers for canonicalising and keying an effective-relationship path.
 *
 * A `path` is `{ baseIds: string[] }`. The BFS code needs two canonical forms:
 *
 *   • A "canonical path" with de-duplicated / sorted `baseIds`, suitable for
 *     *writing* back into the `paths` array.
 *   • A "path key" — a stable string hash of a path, suitable for *comparing*
 *     two paths for equivalence (order-independent on baseIds).
 *
 * Both the hot add-path BFS (`processAddChunk`) and the rebuild walker
 * (`expandTraversalRules` in `unsafe.ts`) go through these helpers so the
 * canonical form stays consistent.
 */
export function canonicalizePath(p) {
    return {
        baseIds: [...new Set(p.baseIds || [])].sort(),
    };
}
/**
 * Stable string hash of a path, order-independent on baseIds. Two paths with
 * the same baseIds produce the same key.
 */
export function pathKey(p) {
    const baseIds = [...new Set(p.baseIds || [])].sort();
    return JSON.stringify({ baseIds });
}
//# sourceMappingURL=paths.js.map