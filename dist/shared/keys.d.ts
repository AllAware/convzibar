/**
 * Shared helpers for the `${type}:${id}` scope-key convention used by
 * `effectiveRelationships.subjectKey` / `objectKey`. One module — one
 * implementation — so the convention can't silently drift.
 */
export declare function buildScopeKey(type: string, id: string): string;
/**
 * Decode `${type}:${id}` preserving any colons in `id`. The naive
 * `split(":")` truncates ids that themselves contain a colon, silently
 * matching the wrong row.
 */
export declare function decodeScopeKey(scopeKey: string): [type: string, id: string];
export declare function entityFromKey(scopeKey: string): {
    type: string;
    id: string;
};
export declare function idFromKey(scopeKey: string): string;
//# sourceMappingURL=keys.d.ts.map