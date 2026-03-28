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
      const matches = await ctx.db
        .query("effectiveRelationships")
        .withIndex("by_tenant_subject_relation_object", (q: any) =>
          q.eq("tenantId", tenantId).eq("subjectKey", sKey).eq("relation", rel),
        )
        .collect();

      return matches.filter((match: any) => {
        const [matchObjectType, _matchObjectId] = match.objectKey.split(":");
        return matchObjectType === objectType;
      });
    });

    const results = await Promise.all(promises);
    return results.flat();
  },
});

export const listUsersWithAccessFast = query({
  args: {
    tenantId: v.optional(v.string()),
    object: objectValidator,
    relations: v.array(v.string()), // Acceptable relations based on schema expansion
  },
  handler: async (ctx: any, args: any) => {
    const { tenantId, object, relations } = args;

    const oKey = buildScopeKey(object.type, object.id);

    const promises = relations.map(async (rel: string) => {
      const matches = await ctx.db
        .query("effectiveRelationships")
        .withIndex("by_tenant_object_relation", (q: any) =>
          q.eq("tenantId", tenantId).eq("objectKey", oKey).eq("relation", rel),
        )
        .collect();

      return matches.filter((match: any) => {
        const [matchSubjectType, _matchSubjectId] = match.subjectKey.split(":");
        return matchSubjectType === "user";
      });
    });

    const results = await Promise.all(promises);
    return results.flat();
  },
});
