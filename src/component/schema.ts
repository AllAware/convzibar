import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const schema = {
  relationships: defineTable({
    tenantId: v.optional(v.string()),
    subjectType: v.string(),
    subjectId: v.string(),
    relation: v.string(),
    objectType: v.string(),
    objectId: v.string(),
    condition: v.optional(v.string()), // name of a registered condition
    conditionContext: v.optional(v.any()), // static context passed to condition
    properties: v.optional(v.any()), // user-defined edge properties
  })
    .index("by_tenant_object", ["tenantId", "objectType", "objectId"])
    .index("by_tenant_subject_relation_object", [
      "tenantId",
      "subjectType",
      "subjectId",
      "relation",
      "objectType",
      "objectId",
    ]),

  effectiveRelationships: defineTable({
    tenantId: v.optional(v.string()),
    subjectKey: v.string(), // `${subjectType}:${subjectId}`
    relation: v.string(),
    objectKey: v.string(), // `${objectType}:${objectId}`

    paths: v.array(
      v.object({
        baseIds: v.array(v.string()),
        conditions: v.optional(
          v.array(
            v.object({
              condition: v.string(),
              conditionContext: v.optional(v.any()),
            }),
          ),
        ),
      }),
    ),
  })
    .index("by_tenant_subject_relation_object", [
      "tenantId",
      "subjectKey",
      "relation",
      "objectKey",
    ])
    .index("by_tenant_object_relation_subject", [
      "tenantId",
      "objectKey",
      "relation",
      "subjectKey",
    ]),

  auditLog: defineTable({
    tenantId: v.optional(v.string()),
    timestamp: v.number(),
    action: v.union(
      v.literal("permission_check"),
      v.literal("relation_added"),
      v.literal("relation_removed"),
    ),
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
};

// ============================================================================
// Test-Time Only Schema
// ============================================================================

// The mockWorkpool table is strictly used for testing async worker logic locally.
// It is intentionally stripped from production schemas to avoid database pollution.
if (process.env.NODE_ENV === "test") {
  (schema as any).mockWorkpool = defineTable({
    mutationName: v.string(),
    args: v.any(),
  });
}

export default defineSchema(schema);
