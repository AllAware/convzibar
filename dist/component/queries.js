import { v } from "convex/values";
import { buildScopeKey } from "../shared/keys";
import { query } from "./_generated/server";
import { objectValidator, subjectValidator } from "./validators";
async function fetchEffectiveForward(ctx, args) {
    const { subjects, relations, objectPoints, objectRange } = args;
    if (subjects.length === 0 || relations.length === 0)
        return [];
    const promises = subjects.flatMap((sub) => {
        const sKey = buildScopeKey(sub.type, sub.id);
        return relations.flatMap((rel) => {
            if (objectPoints) {
                return objectPoints.map((oKey) => ctx.db
                    .query("effectiveRelationships")
                    .withIndex("by_subject_relation_object", (q) => q.eq("subjectKey", sKey).eq("relation", rel).eq("objectKey", oKey))
                    .unique());
            }
            if (objectRange) {
                return [
                    ctx.db
                        .query("effectiveRelationships")
                        .withIndex("by_subject_relation_object", (q) => q
                        .eq("subjectKey", sKey)
                        .eq("relation", rel)
                        .gte("objectKey", `${objectRange.objectType}:`)
                        .lt("objectKey", `${objectRange.objectType}:\u{10FFFF}`))
                        .collect(),
                ];
            }
            return [];
        });
    });
    const results = await Promise.all(promises);
    return results.flat().filter((r) => r !== null);
}
async function fetchEffectiveReverse(ctx, args) {
    const { objects, relations, subjectPoints, subjectRange } = args;
    if (objects.length === 0 || relations.length === 0)
        return [];
    const promises = objects.flatMap((obj) => {
        const oKey = buildScopeKey(obj.type, obj.id);
        return relations.flatMap((rel) => {
            if (subjectPoints) {
                return subjectPoints.map((sKey) => ctx.db
                    .query("effectiveRelationships")
                    .withIndex("by_subject_relation_object", (q) => q.eq("subjectKey", sKey).eq("relation", rel).eq("objectKey", oKey))
                    .unique());
            }
            if (subjectRange) {
                return [
                    ctx.db
                        .query("effectiveRelationships")
                        .withIndex("by_object_relation_subject", (q) => q
                        .eq("objectKey", oKey)
                        .eq("relation", rel)
                        .gte("subjectKey", `${subjectRange.subjectType}:`)
                        .lt("subjectKey", `${subjectRange.subjectType}:\u{10FFFF}`))
                        .collect(),
                ];
            }
            return [];
        });
    });
    const results = await Promise.all(promises);
    return results.flat().filter((r) => r !== null);
}
// ============================================================================
// Public queries.
//
// The whole effective-graph read surface is two queries — forward (subject ×
// relation → objects) and reverse (object × relation → subjects) — each
// dispatching internally on whether far-side *points* or a type *range* was
// supplied. The client builds the `${type}:${id}` scope keys.
// ============================================================================
export const effectiveForward = query({
    args: {
        subjects: v.array(subjectValidator),
        relations: v.array(v.string()),
        objectPoints: v.optional(v.array(v.string())),
        objectRange: v.optional(v.string()), // objectType
    },
    handler: async (ctx, args) => {
        return fetchEffectiveForward(ctx, {
            subjects: args.subjects,
            relations: args.relations,
            objectPoints: args.objectPoints,
            objectRange: args.objectRange ? { objectType: args.objectRange } : undefined,
        });
    },
});
export const effectiveReverse = query({
    args: {
        objects: v.array(objectValidator),
        relations: v.array(v.string()),
        subjectPoints: v.optional(v.array(v.string())),
        subjectRange: v.optional(v.string()), // subjectType
    },
    handler: async (ctx, args) => {
        return fetchEffectiveReverse(ctx, {
            objects: args.objects,
            relations: args.relations,
            subjectPoints: args.subjectPoints,
            subjectRange: args.subjectRange ? { subjectType: args.subjectRange } : undefined,
        });
    },
});
/**
 * List direct (base) relationships from the `relationships` table.
 * Supports querying by subject only, object only, or both.
 */
export const listDirectRelationships = query({
    args: {
        subject: v.optional(subjectValidator),
        object: v.optional(objectValidator),
        relations: v.optional(v.array(v.string())),
        filterSubjectType: v.optional(v.string()),
        filterObjectType: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const { subject, object, relations, filterSubjectType, filterObjectType } = args;
        let rows;
        if (subject && object) {
            if (relations && relations.length > 0) {
                const promises = relations.map((rel) => ctx.db
                    .query("relationships")
                    .withIndex("by_subject_relation_object", (q) => q
                    .eq("subjectType", subject.type)
                    .eq("subjectId", subject.id)
                    .eq("relation", rel)
                    .eq("objectType", object.type)
                    .eq("objectId", object.id))
                    .collect());
                rows = (await Promise.all(promises)).flat();
            }
            else {
                rows = await ctx.db
                    .query("relationships")
                    .withIndex("by_subject_relation_object", (q) => q.eq("subjectType", subject.type).eq("subjectId", subject.id))
                    .collect();
                rows = rows.filter((r) => r.objectType === object.type && r.objectId === object.id);
            }
        }
        else if (object) {
            rows = await ctx.db
                .query("relationships")
                .withIndex("by_object", (q) => q.eq("objectType", object.type).eq("objectId", object.id))
                .collect();
        }
        else if (subject) {
            if (relations && relations.length > 0) {
                const promises = relations.map((rel) => ctx.db
                    .query("relationships")
                    .withIndex("by_subject_relation_object", (q) => {
                    let chain = q
                        .eq("subjectType", subject.type)
                        .eq("subjectId", subject.id)
                        .eq("relation", rel);
                    if (filterObjectType) {
                        chain = chain.eq("objectType", filterObjectType);
                    }
                    return chain;
                })
                    .collect());
                rows = (await Promise.all(promises)).flat();
            }
            else {
                rows = await ctx.db
                    .query("relationships")
                    .withIndex("by_subject_relation_object", (q) => q.eq("subjectType", subject.type).eq("subjectId", subject.id))
                    .collect();
            }
        }
        else {
            return [];
        }
        if (relations && relations.length > 0 && !subject) {
            const relSet = new Set(relations);
            rows = rows.filter((r) => relSet.has(r.relation));
        }
        if (filterSubjectType) {
            rows = rows.filter((r) => r.subjectType === filterSubjectType);
        }
        if (filterObjectType && !(subject && relations && relations.length > 0)) {
            rows = rows.filter((r) => r.objectType === filterObjectType);
        }
        return rows.map((r) => ({
            _id: r._id,
            _creationTime: r._creationTime,
            subjectType: r.subjectType,
            subjectId: r.subjectId,
            relation: r.relation,
            objectType: r.objectType,
            objectId: r.objectId,
            properties: r.properties,
        }));
    },
});
//# sourceMappingURL=queries.js.map