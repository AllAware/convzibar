export declare const effectiveForward: import("convex/server").RegisteredQuery<"public", any, Promise<any[]>>;
export declare const effectiveReverse: import("convex/server").RegisteredQuery<"public", any, Promise<any[]>>;
/**
 * List direct (base) relationships from the `relationships` table.
 * Supports querying by subject only, object only, or both.
 */
export declare const listDirectRelationships: import("convex/server").RegisteredQuery<"public", any, Promise<{
    _id: any;
    _creationTime: any;
    subjectType: any;
    subjectId: any;
    relation: any;
    objectType: any;
    objectId: any;
    properties: any;
}[]>>;
//# sourceMappingURL=queries.d.ts.map