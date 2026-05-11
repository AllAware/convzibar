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
export interface EffectivePath {
    baseIds: string[];
    conditions?: Array<{
        condition: string;
        conditionContext?: unknown;
    }>;
}
export declare function canonicalizePath(p: {
    baseIds?: readonly string[];
    conditions?: Array<{
        condition: string;
        conditionContext?: unknown;
    }>;
}): EffectivePath;
/**
 * Stable string hash of a path, order-independent on baseIds and conditions.
 * Two paths with the same content produce the same key.
 */
export declare function pathKey(p: {
    baseIds?: readonly string[];
    conditions?: Array<{
        condition: string;
        conditionContext?: unknown;
    }>;
}): string;
//# sourceMappingURL=paths.d.ts.map