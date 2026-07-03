export declare const addRelation: import("convex/server").RegisteredMutation<"public", any, Promise<string>>;
export declare const processAddChunk: import("convex/server").RegisteredMutation<"internal", any, Promise<void>>;
export declare const processRemoveChunk: import("convex/server").RegisteredMutation<"internal", any, Promise<void>>;
export declare const removeRelation: import("convex/server").RegisteredMutation<"public", any, Promise<boolean>>;
export declare const updateRelation: import("convex/server").RegisteredMutation<"public", any, Promise<string>>;
export declare const setRelation: import("convex/server").RegisteredMutation<"public", any, Promise<string>>;
export declare const deleteEntity: import("convex/server").RegisteredMutation<"public", any, Promise<{
    relationshipsRemoved: number;
    effectiveRelationshipsRemoved: number;
}>>;
export declare const popMockWorkpool: import("convex/server").RegisteredMutation<"internal", {}, Promise<any>>;
export declare const getMockWorkpool: import("convex/server").RegisteredMutation<"internal", {}, Promise<any>>;
export declare const deleteMockWorkpoolTask: import("convex/server").RegisteredMutation<"internal", any, Promise<void>>;
//# sourceMappingURL=mutations.d.ts.map