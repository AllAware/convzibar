export declare const checkPermissionFast: import("convex/server").RegisteredQuery<"public", any, Promise<any[]>>;
export declare const listAccessibleObjectsFast: import("convex/server").RegisteredQuery<"public", any, Promise<any[]>>;
/**
 * Batch-check whether a subject has any of the given relations with
 * each of several candidate objects.  Returns only the matches.
 * Used by the funnel-via optimisation so that a single Convex query
 * replaces N individual `checkPermissionFast` round-trips.
 */
export declare const checkPermissionBatchObjects: import("convex/server").RegisteredQuery<"public", any, Promise<any[]>>;
/**
 * Batch-check whether each of several candidate subjects has any of the
 * given relations with a specific object.  Returns only the matches.
 */
export declare const checkPermissionBatchSubjects: import("convex/server").RegisteredQuery<"public", any, Promise<any[]>>;
/**
 * List direct (base) relationships from the `relationships` table.
 * Supports querying by subject only, object only, or both.
 */
export declare const listDirectRelationships: import("convex/server").RegisteredQuery<"public", any, Promise<{
    _id: any;
    _creationTime: any;
    tenantId: any;
    subjectType: any;
    subjectId: any;
    relation: any;
    objectType: any;
    objectId: any;
    condition: any;
    conditionContext: any;
    properties: any;
}[]>>;
export declare const listSubjectsWithAccessFast: import("convex/server").RegisteredQuery<"public", any, Promise<any[]>>;
/**
 * Batched forward expansion: for each `subject` × `relation`, return every
 * effective edge whose object is of `objectType`. One Convex query instead
 * of N client round-trips. Drives `Compose.expandObjects` so the planner's
 * forward fan-out collapses to a single round-trip.
 */
export declare const listAccessibleObjectsBatch: import("convex/server").RegisteredQuery<"public", any, Promise<any[]>>;
/**
 * Batched reverse expansion: for each `object` × `relation`, return every
 * effective edge whose subject is of `subjectType`. Drives
 * `Compose.expandSubjects` so the planner's reverse fan-out collapses to
 * a single round-trip.
 */
export declare const listSubjectsWithAccessBatch: import("convex/server").RegisteredQuery<"public", any, Promise<any[]>>;
//# sourceMappingURL=queries.d.ts.map