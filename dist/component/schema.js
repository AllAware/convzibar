import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
// ============================================================================
// TRANSITIONAL v1 COMPATIBILITY (remove after data cleanup)
//
// v1 rows carry fields the engine no longer reads or writes: `tenantId`
// (multi-tenancy), `condition`/`conditionContext` and per-path `conditions`
// (ABAC), and an `auditLog` table. Convex schema validation runs against
// existing documents on deploy, so v2 must still *declare* those shapes for
// an in-place upgrade of a v1 deployment to succeed. Nothing reads them; new
// rows never contain them. Once the deployment's rows have been rewritten
// (or the graph re-provisioned) these declarations can be deleted.
// ============================================================================
/** @deprecated v1 leftover — never read or written by v2. */
const legacyTenantId = v.optional(v.string());
/** @deprecated v1 ABAC leftovers — never read or written by v2. */
const legacyCondition = v.optional(v.string());
const legacyConditionContext = v.optional(v.any());
const schema = {
    relationships: defineTable({
        tenantId: legacyTenantId,
        subjectType: v.string(),
        subjectId: v.string(),
        relation: v.string(),
        objectType: v.string(),
        objectId: v.string(),
        condition: legacyCondition,
        conditionContext: legacyConditionContext,
        properties: v.optional(v.any()), // user-defined edge properties
    })
        .index("by_object", ["objectType", "objectId"])
        .index("by_subject_relation_object", [
        "subjectType",
        "subjectId",
        "relation",
        "objectType",
        "objectId",
    ]),
    effectiveRelationships: defineTable({
        tenantId: legacyTenantId,
        subjectKey: v.string(), // `${subjectType}:${subjectId}`
        relation: v.string(),
        objectKey: v.string(), // `${objectType}:${objectId}`
        // Each path carries the `baseIds` (lineage tokens) of the edges that
        // produced it. Removing a base edge surgically deletes only the paths
        // containing that id — an O(N) cascade instead of a full recomputation.
        paths: v.array(v.object({
            baseIds: v.array(v.string()),
            conditions: v.optional(v.array(v.object({
                condition: v.string(),
                conditionContext: v.optional(v.any()),
            }))), // @deprecated v1 leftover
        })),
    })
        .index("by_subject_relation_object", ["subjectKey", "relation", "objectKey"])
        .index("by_object_relation_subject", ["objectKey", "relation", "subjectKey"]),
    // @deprecated v1 leftover, kept only so deployments with historical audit
    // rows pass schema validation. The engine never writes to it. Clear the
    // table and delete this block whenever convenient.
    auditLog: defineTable({
        tenantId: legacyTenantId,
        timestamp: v.number(),
        action: v.union(v.literal("permission_check"), v.literal("relation_added"), v.literal("relation_removed")),
        userId: v.string(),
        actorId: v.optional(v.string()),
        details: v.object({
            permission: v.optional(v.string()),
            result: v.optional(v.boolean()),
            relation: v.optional(v.string()),
            subject: v.optional(v.string()),
            object: v.optional(v.string()),
            reason: v.optional(v.string()),
        }),
    }),
    // Compiled graph configuration, stored once and referenced by a stable
    // content hash so mutations ship only the hash instead of the full rule set.
    configs: defineTable({
        hash: v.string(),
        config: v.any(), // GraphConfig
    }).index("by_hash", ["hash"]),
};
// ============================================================================
// Test-Time Only Schema
// ============================================================================
// The mockWorkpool table is strictly used for testing async worker logic
// locally. It is intentionally stripped from production schemas.
if (process.env.NODE_ENV === "test") {
    schema.mockWorkpool = defineTable({
        mutationName: v.string(),
        args: v.any(),
    });
}
export default defineSchema(schema);
//# sourceMappingURL=schema.js.map