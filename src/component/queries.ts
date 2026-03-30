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
