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

    const results = [];

    for (const rel of relations) {
      const eff = await ctx.db
        .query("effectiveRelationships")
        .withIndex("by_tenant_subject_relation_object", (q: any) =>
          q
            .eq("tenantId", tenantId)
            .eq("subjectKey", sKey)
            .eq("relation", rel)
            .eq("objectKey", oKey),
        )
        .unique();

      if (eff) {
        results.push(eff);
      }
    }

    return results; // Return all matching effective relationships so conditions can be evaluated client-side
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

    const results = [];

    for (const rel of relations) {
      const matches = await ctx.db
        .query("effectiveRelationships")
        .withIndex("by_tenant_subject_relation", (q: any) =>
          q.eq("tenantId", tenantId).eq("subjectKey", sKey).eq("relation", rel),
        )
        .collect();

      for (const match of matches) {
        if (match.objectType === objectType) {
          results.push(match);
        }
      }
    }

    return results;
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

    const results = [];

    for (const rel of relations) {
      const matches = await ctx.db
        .query("effectiveRelationships")
        .withIndex("by_tenant_object_relation", (q: any) =>
          q.eq("tenantId", tenantId).eq("objectKey", oKey).eq("relation", rel),
        )
        .collect();

      for (const match of matches) {
        if (match.subjectType === "user") {
          // Hardcode user as subject type, or parameterize it
          results.push(match);
        }
      }
    }

    return results;
  },
});
