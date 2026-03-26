import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  relationships: defineTable({
    tenantId: v.optional(v.string()),
    subjectType: v.string(),
    subjectId: v.string(),
    relation: v.string(),
    objectType: v.string(),
    objectId: v.string(),
    condition: v.optional(v.string()), // name of a registered condition
    conditionContext: v.optional(v.any()), // static context passed to condition
    createdBy: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_tenant_subject", ["tenantId", "subjectType", "subjectId"])
    .index("by_tenant_object", ["tenantId", "objectType", "objectId"])
    .index("by_tenant_subject_relation_object", [
      "tenantId",
      "subjectType",
      "subjectId",
      "relation",
      "objectType",
      "objectId",
    ])
    .index("by_tenant_object_relation", [
      "tenantId",
      "objectType",
      "objectId",
      "relation",
    ]),

  effectiveRelationships: defineTable({
    tenantId: v.optional(v.string()),
    subjectKey: v.string(), // `${subjectType}:${subjectId}`
    subjectType: v.string(),
    subjectId: v.string(),
    relation: v.string(),
    objectKey: v.string(), // `${objectType}:${objectId}`
    objectType: v.string(),
    objectId: v.string(),

    paths: v.array(
      v.object({
        isDirect: v.boolean(),
        tokens: v.array(v.string()),
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

    involvedTokens: v.optional(v.string()), // For search index cleanup
    createdBy: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_tenant_subject", ["tenantId", "subjectKey"])
    .index("by_tenant_object", ["tenantId", "objectKey"])
    .index("by_tenant_subject_relation", ["tenantId", "subjectKey", "relation"])
    .index("by_tenant_subject_relation_object", [
      "tenantId",
      "subjectKey",
      "relation",
      "objectKey",
    ])
    .index("by_tenant_object_relation", ["tenantId", "objectKey", "relation"])
    .searchIndex("search_involved_tokens", {
      searchField: "involvedTokens",
      filterFields: ["tenantId"],
    }),

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
  })
    .index("by_tenant_user", ["tenantId", "userId"])
    .index("by_tenant_action", ["tenantId", "action"])
    .index("by_tenant_timestamp", ["tenantId", "timestamp"]),
});
