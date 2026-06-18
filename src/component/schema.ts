import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const schema = {
  relationships: defineTable({
    subjectType: v.string(),
    subjectId: v.string(),
    relation: v.string(),
    objectType: v.string(),
    objectId: v.string(),
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
    subjectKey: v.string(), // `${subjectType}:${subjectId}`
    relation: v.string(),
    objectKey: v.string(), // `${objectType}:${objectId}`

    // Each path carries the `baseIds` (lineage tokens) of the edges that
    // produced it. Removing a base edge surgically deletes only the paths
    // containing that id — an O(N) cascade instead of a full recomputation.
    paths: v.array(
      v.object({
        baseIds: v.array(v.string()),
      }),
    ),
  })
    .index("by_subject_relation_object", ["subjectKey", "relation", "objectKey"])
    .index("by_object_relation_subject", ["objectKey", "relation", "subjectKey"]),

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
  (schema as any).mockWorkpool = defineTable({
    mutationName: v.string(),
    args: v.any(),
  });
}

export default defineSchema(schema);
