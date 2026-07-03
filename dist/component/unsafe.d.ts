export declare const scanRelationships: import("convex/server").RegisteredQuery<"public", any, Promise<{
    rows: {
        _id: any;
        subjectType: any;
        subjectId: any;
        relation: any;
        objectType: any;
        objectId: any;
        properties: any;
    }[];
    cursor: any;
    isDone: boolean;
}>>;
export declare const countRelationships: import("convex/server").RegisteredQuery<"public", any, Promise<number>>;
export declare const insertRelationship: import("convex/server").RegisteredMutation<"public", any, Promise<any>>;
export declare const patchRelationship: import("convex/server").RegisteredMutation<"public", any, Promise<void>>;
export declare const deleteRelationship: import("convex/server").RegisteredMutation<"public", any, Promise<void>>;
export declare const clearEffectiveRelationships: import("convex/server").RegisteredMutation<"public", any, Promise<{
    removed: any;
}>>;
export declare const clearEffectiveRelationshipsChunked: import("convex/server").RegisteredMutation<"internal", any, Promise<{
    removed: any;
}>>;
/**
 * Rebuild effective relationships by replaying all base relationships through
 * the graph expansion engine. Processes in chunks and self-schedules.
 */
export declare const rebuildEffectiveChunk: import("convex/server").RegisteredMutation<"public", any, Promise<{
    done: boolean;
    stats: any;
}>>;
export declare const transformChunk: import("convex/server").RegisteredMutation<"public", any, Promise<{
    patched: number;
    inserted: number;
    deleted: number;
    skipped: number;
}>>;
export declare const renameRelation: import("convex/server").RegisteredMutation<"public", any, Promise<{
    updated: number;
}>>;
export declare const renameEntityType: import("convex/server").RegisteredMutation<"public", any, Promise<{
    updated: number;
}>>;
//# sourceMappingURL=unsafe.d.ts.map