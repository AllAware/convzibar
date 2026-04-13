import { query } from "./_generated/server";
import { v } from "convex/values";
import { objectValidator, subjectValidator } from "./validators";

function buildScopeKey(type: string, id: string) {
  return `${type}:${id}`;
}

export const checkPermissionFast = query({
  args: {
    tenantId: v.optional(v.string()),
    subject: subjectValidator,
    relations: v.array(v.string()), // Acceptable relations based on schema expansion
    object: objectValidator,
  },
  handler: async (ctx: any, args: any) => {
    const { tenantId, subject, relations, object } = args;

    const sKey = buildScopeKey(subject.type, subject.id);
    const oKey = buildScopeKey(object.type, object.id);

    const promises = relations.map((rel: string) =>
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

    const results = await Promise.all(promises);

    return results.filter((eff: any) => eff !== null);
  },
});

export const listAccessibleObjectsFast = query({
  args: {
    tenantId: v.optional(v.string()),
    subject: subjectValidator,
    relations: v.array(v.string()), // Acceptable relations based on schema expansion
    objectType: v.string(),
  },
  handler: async (ctx: any, args: any) => {
    const { tenantId, subject, relations, objectType } = args;

    const sKey = buildScopeKey(subject.type, subject.id);

    const promises = relations.map(async (rel: string) => {
      return await ctx.db
        .query("effectiveRelationships")
        .withIndex("by_tenant_subject_relation_object", (q: any) =>
          q
            .eq("tenantId", tenantId)
            .eq("subjectKey", sKey)
            .eq("relation", rel)
            .gte("objectKey", `${objectType}:`)
            .lt("objectKey", `${objectType}:\u{10FFFF}`),
        )
        .collect();
    });

    const results = await Promise.all(promises);
    return results.flat();
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
    const { tenantId, subject, relations, objectType, candidateObjectIds } =
      args;
    const sKey = buildScopeKey(subject.type, subject.id);

    // For every (candidateId, relation) pair, do a point lookup.
    // All lookups run in parallel inside one query transaction.
    const promises = candidateObjectIds.flatMap((id: string) => {
      const oKey = buildScopeKey(objectType, id);
      return relations.map((rel: string) =>
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
    });

    const results = await Promise.all(promises);
    return results.filter((eff: any) => eff !== null);
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
    const { tenantId, object, relations, subjectType, candidateSubjectIds } =
      args;
    const oKey = buildScopeKey(object.type, object.id);

    const promises = candidateSubjectIds.flatMap((id: string) => {
      const sKey = buildScopeKey(subjectType, id);
      return relations.map((rel: string) =>
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
    });

    const results = await Promise.all(promises);
    return results.filter((eff: any) => eff !== null);
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
  handler: async (ctx, args) => {
    const { tenantId, object, relations, subjectType } = args;

    const oKey = buildScopeKey(object.type, object.id);

    const promises = relations.map(async (rel: string) => {
      return await ctx.db
        .query("effectiveRelationships")
        .withIndex("by_tenant_object_relation_subject", (q: any) =>
          q
            .eq("tenantId", tenantId)
            .eq("objectKey", oKey)
            .eq("relation", rel)
            .gte("subjectKey", `${subjectType}:`)
            .lt("subjectKey", `${subjectType}:\u{10FFFF}`),
        )
        .collect();
    });

    const results = await Promise.all(promises);
    return results.flat();
  },
});
