import { v } from "convex/values";
import { buildScopeKey } from "../shared/keys";
import { query } from "./_generated/server";
import { objectValidator, subjectValidator } from "./validators";

// ============================================================================
// Shared effective-relationship fetchers.
//
// Every `queries:*` read of `effectiveRelationships` falls into one of two
// shapes: forward (subject × relation → object-scoped) or reverse (object ×
// relation → subject-scoped). Each shape has three modes — point on the
// far-side key, range on a type prefix, or many-candidate point lookups —
// which the helpers dispatch on internally. The top-level query handlers
// remain as thin wrappers so the test-suite's per-query call counts stay
// stable.
// ============================================================================

type EntityRef = { type: string; id: string };

async function fetchEffectiveForward(
  ctx: any,
  args: {
    tenantId: string | undefined;
    subjects: readonly EntityRef[];
    relations: readonly string[];
    objectPoints?: readonly string[];
    objectRange?: { objectType: string };
    uniquePoints?: boolean;
  },
): Promise<any[]> {
  const { tenantId, subjects, relations, objectPoints, objectRange } = args;
  if (subjects.length === 0 || relations.length === 0) return [];
  const promises = subjects.flatMap((sub: EntityRef) => {
    const sKey = buildScopeKey(sub.type, sub.id);
    return relations.flatMap((rel: string) => {
      if (objectPoints) {
        return objectPoints.map((oKey: string) =>
          ctx.db
            .query("effectiveRelationships")
            .withIndex("by_tenant_subject_relation_object", (q: any) =>
              q
                .eq("tenantId", tenantId)
                .eq("subjectKey", sKey)
                .eq("relation", rel)
                .eq("objectKey", oKey),
            )
            .unique(),
        );
      }
      if (objectRange) {
        return [
          ctx.db
            .query("effectiveRelationships")
            .withIndex("by_tenant_subject_relation_object", (q: any) =>
              q
                .eq("tenantId", tenantId)
                .eq("subjectKey", sKey)
                .eq("relation", rel)
                .gte("objectKey", `${objectRange.objectType}:`)
                .lt("objectKey", `${objectRange.objectType}:\u{10FFFF}`),
            )
            .collect(),
        ];
      }
      return [];
    });
  });
  const results = await Promise.all(promises);
  return results.flat().filter((r: any) => r !== null);
}

async function fetchEffectiveReverse(
  ctx: any,
  args: {
    tenantId: string | undefined;
    objects: readonly EntityRef[];
    relations: readonly string[];
    subjectPoints?: readonly string[];
    subjectRange?: { subjectType: string };
  },
): Promise<any[]> {
  const { tenantId, objects, relations, subjectPoints, subjectRange } = args;
  if (objects.length === 0 || relations.length === 0) return [];
  const promises = objects.flatMap((obj: EntityRef) => {
    const oKey = buildScopeKey(obj.type, obj.id);
    return relations.flatMap((rel: string) => {
      if (subjectPoints) {
        return subjectPoints.map((sKey: string) =>
          ctx.db
            .query("effectiveRelationships")
            .withIndex("by_tenant_subject_relation_object", (q: any) =>
              q
                .eq("tenantId", tenantId)
                .eq("subjectKey", sKey)
                .eq("relation", rel)
                .eq("objectKey", oKey),
            )
            .unique(),
        );
      }
      if (subjectRange) {
        return [
          ctx.db
            .query("effectiveRelationships")
            .withIndex("by_tenant_object_relation_subject", (q: any) =>
              q
                .eq("tenantId", tenantId)
                .eq("objectKey", oKey)
                .eq("relation", rel)
                .gte("subjectKey", `${subjectRange.subjectType}:`)
                .lt("subjectKey", `${subjectRange.subjectType}:\u{10FFFF}`),
            )
            .collect(),
        ];
      }
      return [];
    });
  });
  const results = await Promise.all(promises);
  return results.flat().filter((r: any) => r !== null);
}

// ============================================================================
// Public queries.
// ============================================================================

export const checkPermissionFast = query({
  args: {
    tenantId: v.optional(v.string()),
    subject: subjectValidator,
    relations: v.array(v.string()),
    object: objectValidator,
  },
  handler: async (ctx: any, args: any) => {
    return fetchEffectiveForward(ctx, {
      tenantId: args.tenantId,
      subjects: [args.subject],
      relations: args.relations,
      objectPoints: [buildScopeKey(args.object.type, args.object.id)],
    });
  },
});

export const listAccessibleObjectsFast = query({
  args: {
    tenantId: v.optional(v.string()),
    subject: subjectValidator,
    relations: v.array(v.string()),
    objectType: v.string(),
  },
  handler: async (ctx: any, args: any) => {
    return fetchEffectiveForward(ctx, {
      tenantId: args.tenantId,
      subjects: [args.subject],
      relations: args.relations,
      objectRange: { objectType: args.objectType },
    });
  },
});

/**
 * Batch-check whether a subject has any of the given relations with
 * each of several candidate objects.  Returns only the matches.
 * Used by the funnel-via optimisation so that a single Convex query
 * replaces N individual `checkPermissionFast` round-trips.
 */
export const checkPermissionBatchObjects = query({
  args: {
    tenantId: v.optional(v.string()),
    subject: subjectValidator,
    relations: v.array(v.string()),
    objectType: v.string(),
    candidateObjectIds: v.array(v.string()),
  },
  handler: async (ctx: any, args: any) => {
    return fetchEffectiveForward(ctx, {
      tenantId: args.tenantId,
      subjects: [args.subject],
      relations: args.relations,
      objectPoints: args.candidateObjectIds.map((id: string) =>
        buildScopeKey(args.objectType, id),
      ),
    });
  },
});

/**
 * Batch-check whether each of several candidate subjects has any of the
 * given relations with a specific object.  Returns only the matches.
 */
export const checkPermissionBatchSubjects = query({
  args: {
    tenantId: v.optional(v.string()),
    object: objectValidator,
    relations: v.array(v.string()),
    subjectType: v.string(),
    candidateSubjectIds: v.array(v.string()),
  },
  handler: async (ctx: any, args: any) => {
    return fetchEffectiveReverse(ctx, {
      tenantId: args.tenantId,
      objects: [args.object],
      relations: args.relations,
      subjectPoints: args.candidateSubjectIds.map((id: string) =>
        buildScopeKey(args.subjectType, id),
      ),
    });
  },
});

/**
 * List direct (base) relationships from the `relationships` table.
 * Supports querying by subject only, object only, or both.
 */
export const listDirectRelationships = query({
  args: {
    tenantId: v.optional(v.string()),
    subject: v.optional(subjectValidator),
    object: v.optional(objectValidator),
    relations: v.optional(v.array(v.string())),
    // Optional type-only filters — allow the server to narrow results
    // when the caller only has a type (no id) for subject or object.
    filterSubjectType: v.optional(v.string()),
    filterObjectType: v.optional(v.string()),
  },
  handler: async (ctx: any, args: any) => {
    const { tenantId, subject, object, relations, filterSubjectType, filterObjectType } = args;

    let rows: any[];

    if (subject && object) {
      // Both provided — use the compound index for a tight point query.
      // If relations are specified, query each; otherwise query all via
      // a prefix scan on subject fields.
      if (relations && relations.length > 0) {
        const promises = relations.map((rel: string) =>
          ctx.db
            .query("relationships")
            .withIndex("by_tenant_subject_relation_object", (q: any) =>
              q
                .eq("tenantId", tenantId)
                .eq("subjectType", subject.type)
                .eq("subjectId", subject.id)
                .eq("relation", rel)
                .eq("objectType", object.type)
                .eq("objectId", object.id),
            )
            .collect(),
        );
        rows = (await Promise.all(promises)).flat();
      } else {
        rows = await ctx.db
          .query("relationships")
          .withIndex("by_tenant_subject_relation_object", (q: any) =>
            q
              .eq("tenantId", tenantId)
              .eq("subjectType", subject.type)
              .eq("subjectId", subject.id),
          )
          .collect();
        // Post-filter to matching object
        rows = rows.filter(
          (r: any) => r.objectType === object.type && r.objectId === object.id,
        );
      }
    } else if (object) {
      // Object only — all relationships where this entity is the object.
      rows = await ctx.db
        .query("relationships")
        .withIndex("by_tenant_object", (q: any) =>
          q
            .eq("tenantId", tenantId)
            .eq("objectType", object.type)
            .eq("objectId", object.id),
        )
        .collect();
    } else if (subject) {
      // Subject only — all relationships where this entity is the subject.
      if (relations && relations.length > 0) {
        // Use the 4th index field (relation) for tighter scans.
        // When filterObjectType is also provided, extend to the 5th field.
        const promises = relations.map((rel: string) =>
          ctx.db
            .query("relationships")
            .withIndex("by_tenant_subject_relation_object", (q: any) => {
              let chain = q
                .eq("tenantId", tenantId)
                .eq("subjectType", subject.type)
                .eq("subjectId", subject.id)
                .eq("relation", rel);
              if (filterObjectType) {
                chain = chain.eq("objectType", filterObjectType);
              }
              return chain;
            })
            .collect(),
        );
        rows = (await Promise.all(promises)).flat();
      } else {
        rows = await ctx.db
          .query("relationships")
          .withIndex("by_tenant_subject_relation_object", (q: any) =>
            q
              .eq("tenantId", tenantId)
              .eq("subjectType", subject.type)
              .eq("subjectId", subject.id),
          )
          .collect();
      }
    } else {
      return [];
    }

    // Filter by relations if provided and not already filtered above.
    // The subject+object and subject-only branches handle relations via
    // the index; only the object-only branch needs post-filtering.
    if (relations && relations.length > 0 && !subject) {
      const relSet = new Set(relations);
      rows = rows.filter((r: any) => relSet.has(r.relation));
    }

    // Server-side type filtering for type-only parameters.
    // These narrow results that couldn't be handled by the index alone.
    if (filterSubjectType) {
      rows = rows.filter((r: any) => r.subjectType === filterSubjectType);
    }
    if (filterObjectType && !(subject && relations && relations.length > 0)) {
      // Skip when subject+relations already used filterObjectType in index.
      rows = rows.filter((r: any) => r.objectType === filterObjectType);
    }

    return rows.map((r: any) => ({
      _id: r._id,
      _creationTime: r._creationTime,
      tenantId: r.tenantId,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      relation: r.relation,
      objectType: r.objectType,
      objectId: r.objectId,
      condition: r.condition,
      conditionContext: r.conditionContext,
      properties: r.properties,
    }));
  },
});

export const listSubjectsWithAccessFast = query({
  args: {
    tenantId: v.optional(v.string()),
    subjectType: v.string(),
    relations: v.array(v.string()),
    object: objectValidator,
  },
  handler: async (ctx: any, args: any) => {
    return fetchEffectiveReverse(ctx, {
      tenantId: args.tenantId,
      objects: [args.object],
      relations: args.relations,
      subjectRange: { subjectType: args.subjectType },
    });
  },
});

/**
 * Batched forward expansion: for each `subject` × `relation`, return every
 * effective edge whose object is of `objectType`. One Convex query instead
 * of N client round-trips. Drives `Compose.expandObjects` so the planner's
 * forward fan-out collapses to a single round-trip.
 */
export const listAccessibleObjectsBatch = query({
  args: {
    tenantId: v.optional(v.string()),
    subjects: v.array(subjectValidator),
    relations: v.array(v.string()),
    objectType: v.string(),
  },
  handler: async (ctx: any, args: any) => {
    return fetchEffectiveForward(ctx, {
      tenantId: args.tenantId,
      subjects: args.subjects,
      relations: args.relations,
      objectRange: { objectType: args.objectType },
    });
  },
});

/**
 * Batched reverse expansion: for each `object` × `relation`, return every
 * effective edge whose subject is of `subjectType`. Drives
 * `Compose.expandSubjects` so the planner's reverse fan-out collapses to
 * a single round-trip.
 */
export const listSubjectsWithAccessBatch = query({
  args: {
    tenantId: v.optional(v.string()),
    objects: v.array(objectValidator),
    relations: v.array(v.string()),
    subjectType: v.string(),
  },
  handler: async (ctx: any, args: any) => {
    return fetchEffectiveReverse(ctx, {
      tenantId: args.tenantId,
      objects: args.objects,
      relations: args.relations,
      subjectRange: { subjectType: args.subjectType },
    });
  },
});
