import { v } from "convex/values";
import { buildScopeKey, decodeScopeKey } from "../shared/keys";
import { api } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { applyTraversalRulesToItem } from "./expand";
import { canonicalizePath, pathKey } from "./paths";
import { expansionPool } from "./workpool";
// ============================================================================
// Step 1: Read Primitives
// ============================================================================
export const scanRelationships = query({
    args: {
        filter: v.optional(v.object({
            subjectType: v.optional(v.string()),
            subjectId: v.optional(v.string()),
            relation: v.optional(v.string()),
            objectType: v.optional(v.string()),
            objectId: v.optional(v.string()),
        })),
        cursor: v.optional(v.string()),
        limit: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
        const { filter, limit: rawLimit } = args;
        const limit = Math.min(rawLimit ?? 100, 1000);
        let results;
        if (filter?.subjectType &&
            filter?.subjectId &&
            filter?.relation &&
            filter?.objectType &&
            filter?.objectId) {
            const row = await ctx.db
                .query("relationships")
                .withIndex("by_subject_relation_object", (q) => q
                .eq("subjectType", filter.subjectType)
                .eq("subjectId", filter.subjectId)
                .eq("relation", filter.relation)
                .eq("objectType", filter.objectType)
                .eq("objectId", filter.objectId))
                .unique();
            results = row ? [row] : [];
        }
        else if (filter?.subjectType && filter?.subjectId) {
            results = await ctx.db
                .query("relationships")
                .withIndex("by_subject_relation_object", (q) => {
                let q2 = q.eq("subjectType", filter.subjectType).eq("subjectId", filter.subjectId);
                if (filter.relation)
                    q2 = q2.eq("relation", filter.relation);
                return q2;
            })
                .collect();
        }
        else if (filter?.objectType && filter?.objectId) {
            results = await ctx.db
                .query("relationships")
                .withIndex("by_object", (q) => q.eq("objectType", filter.objectType).eq("objectId", filter.objectId))
                .collect();
        }
        else if (filter?.objectType) {
            results = await ctx.db
                .query("relationships")
                .withIndex("by_object", (q) => q.eq("objectType", filter.objectType))
                .collect();
        }
        else {
            results = await ctx.db.query("relationships").collect();
        }
        if (filter) {
            results = results.filter((r) => {
                if (filter.subjectType && r.subjectType !== filter.subjectType)
                    return false;
                if (filter.subjectId && r.subjectId !== filter.subjectId)
                    return false;
                if (filter.relation && r.relation !== filter.relation)
                    return false;
                if (filter.objectType && r.objectType !== filter.objectType)
                    return false;
                if (filter.objectId && r.objectId !== filter.objectId)
                    return false;
                return true;
            });
        }
        let startIndex = 0;
        if (args.cursor) {
            const cursorIdx = results.findIndex((r) => r._id === args.cursor);
            if (cursorIdx >= 0)
                startIndex = cursorIdx + 1;
        }
        const page = results.slice(startIndex, startIndex + limit);
        const nextCursor = startIndex + limit < results.length ? page[page.length - 1]?._id : undefined;
        return {
            rows: page.map((r) => ({
                _id: r._id,
                subjectType: r.subjectType,
                subjectId: r.subjectId,
                relation: r.relation,
                objectType: r.objectType,
                objectId: r.objectId,
                properties: r.properties,
            })),
            cursor: nextCursor,
            isDone: nextCursor === undefined,
        };
    },
});
export const countRelationships = query({
    args: {
        filter: v.optional(v.object({
            subjectType: v.optional(v.string()),
            objectType: v.optional(v.string()),
            relation: v.optional(v.string()),
        })),
    },
    handler: async (ctx, args) => {
        const { filter } = args;
        let results;
        if (filter?.objectType) {
            results = await ctx.db
                .query("relationships")
                .withIndex("by_object", (q) => q.eq("objectType", filter.objectType))
                .collect();
        }
        else {
            results = await ctx.db.query("relationships").collect();
        }
        if (filter) {
            results = results.filter((r) => {
                if (filter.subjectType && r.subjectType !== filter.subjectType)
                    return false;
                if (filter.relation && r.relation !== filter.relation)
                    return false;
                if (filter.objectType && r.objectType !== filter.objectType)
                    return false;
                return true;
            });
        }
        return results.length;
    },
});
// ============================================================================
// Step 2: Raw Write Primitives
// ============================================================================
export const insertRelationship = mutation({
    args: {
        subjectType: v.string(),
        subjectId: v.string(),
        relation: v.string(),
        objectType: v.string(),
        objectId: v.string(),
        properties: v.optional(v.any()),
    },
    handler: async (ctx, args) => {
        return await ctx.db.insert("relationships", {
            subjectType: args.subjectType,
            subjectId: args.subjectId,
            relation: args.relation,
            objectType: args.objectType,
            objectId: args.objectId,
            properties: args.properties,
        });
    },
});
export const patchRelationship = mutation({
    args: {
        relationshipId: v.id("relationships"),
        patch: v.object({
            subjectType: v.optional(v.string()),
            subjectId: v.optional(v.string()),
            relation: v.optional(v.string()),
            objectType: v.optional(v.string()),
            objectId: v.optional(v.string()),
            properties: v.optional(v.union(v.any(), v.null())),
        }),
    },
    handler: async (ctx, args) => {
        const existing = await ctx.db.get(args.relationshipId);
        if (!existing) {
            throw new Error(`Relationship ${args.relationshipId} not found`);
        }
        const patchData = {};
        for (const [key, value] of Object.entries(args.patch)) {
            if (value === undefined)
                continue;
            patchData[key] = value === null ? undefined : value;
        }
        await ctx.db.patch(args.relationshipId, patchData);
    },
});
export const deleteRelationship = mutation({
    args: { relationshipId: v.id("relationships") },
    handler: async (ctx, args) => {
        const existing = await ctx.db.get(args.relationshipId);
        if (!existing)
            return;
        await ctx.db.delete(args.relationshipId);
    },
});
// ============================================================================
// Step 3: Effective Relationship Control
// ============================================================================
export const clearEffectiveRelationships = mutation({
    args: {
        filter: v.optional(v.object({
            subjectType: v.optional(v.string()),
            objectType: v.optional(v.string()),
            relation: v.optional(v.string()),
        })),
    },
    handler: async (ctx, args) => {
        return await clearEffectiveRelationshipsInternal(ctx, args);
    },
});
async function clearEffectiveRelationshipsInternal(ctx, args) {
    const { filter } = args;
    const allEffective = await ctx.db.query("effectiveRelationships").collect();
    let toDelete = allEffective;
    if (filter) {
        toDelete = allEffective.filter((eff) => {
            if (filter.relation && eff.relation !== filter.relation)
                return false;
            if (filter.subjectType) {
                const [sType] = decodeScopeKey(eff.subjectKey);
                if (sType !== filter.subjectType)
                    return false;
            }
            if (filter.objectType) {
                const [oType] = decodeScopeKey(eff.objectKey);
                if (oType !== filter.objectType)
                    return false;
            }
            return true;
        });
    }
    for (const eff of toDelete) {
        await ctx.db.delete(eff._id);
    }
    return { removed: toDelete.length };
}
export const clearEffectiveRelationshipsChunked = internalMutation({
    args: {
        filter: v.optional(v.object({
            subjectType: v.optional(v.string()),
            objectType: v.optional(v.string()),
            relation: v.optional(v.string()),
        })),
        asyncWrites: v.optional(v.boolean()),
    },
    handler: async (ctx, args) => {
        return await clearEffectiveRelationshipsInternal(ctx, args);
    },
});
/**
 * Rebuild effective relationships by replaying all base relationships through
 * the graph expansion engine. Processes in chunks and self-schedules.
 */
export const rebuildEffectiveChunk = mutation({
    args: {
        graphConfig: v.any(),
        cursor: v.optional(v.string()),
        batchSize: v.optional(v.number()),
        stats: v.optional(v.object({ processed: v.number(), total: v.number() })),
        mockWorkpool: v.optional(v.boolean()),
    },
    handler: async (ctx, args) => {
        const { graphConfig, cursor, mockWorkpool } = args;
        const batchSize = args.batchSize ?? 25;
        const stats = args.stats ?? { processed: 0, total: 0 };
        const allRels = await ctx.db.query("relationships").collect();
        let startIdx = 0;
        if (cursor) {
            const cursorIdx = allRels.findIndex((r) => r._id === cursor);
            if (cursorIdx >= 0)
                startIdx = cursorIdx + 1;
        }
        if (stats.total === 0)
            stats.total = allRels.length;
        const batch = allRels.slice(startIdx, startIdx + batchSize);
        if (batch.length === 0)
            return { done: true, stats };
        for (const rel of batch) {
            const sKey = buildScopeKey(rel.subjectType, rel.subjectId);
            const oKey = buildScopeKey(rel.objectType, rel.objectId);
            const pathItem = { baseIds: [rel._id] };
            const existing = await ctx.db
                .query("effectiveRelationships")
                .withIndex("by_subject_relation_object", (q) => q.eq("subjectKey", sKey).eq("relation", rel.relation).eq("objectKey", oKey))
                .unique();
            if (!existing) {
                await ctx.db.insert("effectiveRelationships", {
                    subjectKey: sKey,
                    relation: rel.relation,
                    objectKey: oKey,
                    paths: [pathItem],
                });
            }
            else {
                const itemKey = pathKey(pathItem);
                if (!existing.paths.some((p) => pathKey(p) === itemKey)) {
                    await ctx.db.patch(existing._id, { paths: [...existing.paths, pathItem] });
                }
            }
            await expandTraversalRules(ctx, {
                subject: { type: rel.subjectType, id: rel.subjectId },
                relation: rel.relation,
                object: { type: rel.objectType, id: rel.objectId },
                path: pathItem,
                graphConfig,
            });
            stats.processed++;
        }
        const lastId = batch[batch.length - 1]._id;
        const isDone = startIdx + batchSize >= allRels.length;
        if (!isDone) {
            if (mockWorkpool) {
                await ctx.db.insert("mockWorkpool", {
                    mutationName: "rebuildEffectiveChunk",
                    args: { graphConfig, cursor: lastId, batchSize, stats, mockWorkpool },
                });
            }
            else {
                await expansionPool.enqueueMutation(ctx, api.unsafe.rebuildEffectiveChunk, {
                    graphConfig,
                    cursor: lastId,
                    batchSize,
                    stats,
                });
            }
        }
        return { done: isDone, stats };
    },
});
async function expandTraversalRules(ctx, args) {
    const { subject, relation, object, path, graphConfig } = args;
    const queue = [
        {
            subject,
            relation,
            object,
            path,
            depth: 1,
            // Rebuild walks every base row independently, so both sides of a
            // reverse-edge declaration are already scheduled. Skip the depth-1
            // reverse push to avoid creating duplicate effective paths.
            skipReverse: true,
        },
    ];
    while (queue.length > 0) {
        const current = queue.shift();
        const sKey = buildScopeKey(current.subject.type, current.subject.id);
        const oKey = buildScopeKey(current.object.type, current.object.id);
        if (current.depth > 1) {
            const canonicalPath = canonicalizePath(current.path);
            const currentPathKey = pathKey(canonicalPath);
            const existing = await ctx.db
                .query("effectiveRelationships")
                .withIndex("by_subject_relation_object", (q) => q.eq("subjectKey", sKey).eq("relation", current.relation).eq("objectKey", oKey))
                .unique();
            let isNew = false;
            if (!existing) {
                await ctx.db.insert("effectiveRelationships", {
                    subjectKey: sKey,
                    relation: current.relation,
                    objectKey: oKey,
                    paths: [canonicalPath],
                });
                isNew = true;
            }
            else if (!existing.paths.some((p) => pathKey(p) === currentPathKey)) {
                await ctx.db.patch(existing._id, { paths: [...existing.paths, canonicalPath] });
                isNew = true;
            }
            if (!isNew)
                continue;
        }
        await applyTraversalRulesToItem(ctx, { current, queue, graphConfig });
    }
}
// ============================================================================
// Step 4: Bulk Transform
// ============================================================================
export const transformChunk = mutation({
    args: {
        operations: v.array(v.object({
            id: v.id("relationships"),
            action: v.union(v.literal("patch"), v.literal("delete"), v.literal("replace"), v.literal("skip")),
            patch: v.optional(v.object({
                subjectType: v.optional(v.string()),
                subjectId: v.optional(v.string()),
                relation: v.optional(v.string()),
                objectType: v.optional(v.string()),
                objectId: v.optional(v.string()),
                properties: v.optional(v.union(v.any(), v.null())),
            })),
            inserts: v.optional(v.array(v.object({
                subjectType: v.string(),
                subjectId: v.string(),
                relation: v.string(),
                objectType: v.string(),
                objectId: v.string(),
                properties: v.optional(v.any()),
            }))),
        })),
    },
    handler: async (ctx, args) => {
        let patched = 0;
        let inserted = 0;
        let deleted = 0;
        let skipped = 0;
        for (const op of args.operations) {
            if (op.action === "skip") {
                skipped++;
                continue;
            }
            if (op.action === "delete") {
                const existing = await ctx.db.get(op.id);
                if (existing) {
                    await ctx.db.delete(op.id);
                    deleted++;
                }
                continue;
            }
            if (op.action === "patch") {
                const existing = await ctx.db.get(op.id);
                if (!existing)
                    continue;
                const patchData = {};
                for (const [key, value] of Object.entries(op.patch || {})) {
                    if (value === undefined)
                        continue;
                    patchData[key] = value === null ? undefined : value;
                }
                await ctx.db.patch(op.id, patchData);
                patched++;
                continue;
            }
            if (op.action === "replace") {
                const existing = await ctx.db.get(op.id);
                if (existing) {
                    await ctx.db.delete(op.id);
                    deleted++;
                }
                for (const ins of op.inserts || []) {
                    await ctx.db.insert("relationships", ins);
                    inserted++;
                }
                continue;
            }
        }
        return { patched, inserted, deleted, skipped };
    },
});
// ============================================================================
// Step 5: Convenience Rename Helpers
// ============================================================================
export const renameRelation = mutation({
    args: {
        objectType: v.string(),
        oldRelation: v.string(),
        newRelation: v.string(),
    },
    handler: async (ctx, args) => {
        const { objectType, oldRelation, newRelation } = args;
        const matches = await ctx.db
            .query("relationships")
            .withIndex("by_object", (q) => q.eq("objectType", objectType))
            .collect();
        let updated = 0;
        for (const rel of matches) {
            if (rel.relation === oldRelation) {
                await ctx.db.patch(rel._id, { relation: newRelation });
                updated++;
            }
        }
        return { updated };
    },
});
export const renameEntityType = mutation({
    args: {
        oldType: v.string(),
        newType: v.string(),
    },
    handler: async (ctx, args) => {
        const { oldType, newType } = args;
        let updated = 0;
        const objectMatches = await ctx.db
            .query("relationships")
            .withIndex("by_object", (q) => q.eq("objectType", oldType))
            .collect();
        for (const rel of objectMatches) {
            await ctx.db.patch(rel._id, { objectType: newType });
            updated++;
        }
        const subjectMatches = await ctx.db
            .query("relationships")
            .withIndex("by_subject_relation_object", (q) => q.eq("subjectType", oldType))
            .collect();
        for (const rel of subjectMatches) {
            await ctx.db.patch(rel._id, { subjectType: newType });
            if (rel.objectType !== oldType)
                updated++;
        }
        return { updated };
    },
});
//# sourceMappingURL=unsafe.js.map