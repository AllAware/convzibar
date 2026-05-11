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
        tenantId: v.optional(v.string()),
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
        const { tenantId, filter, limit: rawLimit } = args;
        const limit = Math.min(rawLimit ?? 100, 1000);
        // Choose the best index based on available filters
        let results;
        if (filter?.subjectType && filter?.subjectId && filter?.relation && filter?.objectType && filter?.objectId) {
            // Fully specified — use the most selective index
            const row = await ctx.db
                .query("relationships")
                .withIndex("by_tenant_subject_relation_object", (q) => q
                .eq("tenantId", tenantId)
                .eq("subjectType", filter.subjectType)
                .eq("subjectId", filter.subjectId)
                .eq("relation", filter.relation)
                .eq("objectType", filter.objectType)
                .eq("objectId", filter.objectId))
                .unique();
            results = row ? [row] : [];
        }
        else if (filter?.subjectType && filter?.subjectId) {
            // Subject-scoped scan
            results = await ctx.db
                .query("relationships")
                .withIndex("by_tenant_subject_relation_object", (q) => {
                let q2 = q
                    .eq("tenantId", tenantId)
                    .eq("subjectType", filter.subjectType)
                    .eq("subjectId", filter.subjectId);
                if (filter.relation)
                    q2 = q2.eq("relation", filter.relation);
                return q2;
            })
                .collect();
        }
        else if (filter?.objectType && filter?.objectId) {
            // Object-scoped scan
            results = await ctx.db
                .query("relationships")
                .withIndex("by_tenant_object", (q) => q
                .eq("tenantId", tenantId)
                .eq("objectType", filter.objectType)
                .eq("objectId", filter.objectId))
                .collect();
        }
        else if (filter?.objectType) {
            // Object type scan
            results = await ctx.db
                .query("relationships")
                .withIndex("by_tenant_object", (q) => q.eq("tenantId", tenantId).eq("objectType", filter.objectType))
                .collect();
        }
        else {
            // Full table scan for this tenant — use the object index as a prefix scan
            results = await ctx.db
                .query("relationships")
                .withIndex("by_tenant_object", (q) => q.eq("tenantId", tenantId))
                .collect();
        }
        // Apply remaining client-side filters that weren't covered by the index
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
        // Apply cursor-based pagination
        let startIndex = 0;
        if (args.cursor) {
            const cursorIdx = results.findIndex((r) => r._id === args.cursor);
            if (cursorIdx >= 0) {
                startIndex = cursorIdx + 1;
            }
        }
        const page = results.slice(startIndex, startIndex + limit);
        const nextCursor = startIndex + limit < results.length
            ? page[page.length - 1]?._id
            : undefined;
        return {
            rows: page.map((r) => ({
                _id: r._id,
                tenantId: r.tenantId,
                subjectType: r.subjectType,
                subjectId: r.subjectId,
                relation: r.relation,
                objectType: r.objectType,
                objectId: r.objectId,
                condition: r.condition,
                conditionContext: r.conditionContext,
                properties: r.properties,
            })),
            cursor: nextCursor,
            isDone: nextCursor === undefined,
        };
    },
});
export const countRelationships = query({
    args: {
        tenantId: v.optional(v.string()),
        filter: v.optional(v.object({
            subjectType: v.optional(v.string()),
            objectType: v.optional(v.string()),
            relation: v.optional(v.string()),
        })),
    },
    handler: async (ctx, args) => {
        const { tenantId, filter } = args;
        let results;
        if (filter?.objectType) {
            results = await ctx.db
                .query("relationships")
                .withIndex("by_tenant_object", (q) => q.eq("tenantId", tenantId).eq("objectType", filter.objectType))
                .collect();
        }
        else {
            results = await ctx.db
                .query("relationships")
                .withIndex("by_tenant_object", (q) => q.eq("tenantId", tenantId))
                .collect();
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
        tenantId: v.optional(v.string()),
        subjectType: v.string(),
        subjectId: v.string(),
        relation: v.string(),
        objectType: v.string(),
        objectId: v.string(),
        condition: v.optional(v.string()),
        conditionContext: v.optional(v.any()),
        properties: v.optional(v.any()),
    },
    handler: async (ctx, args) => {
        return await ctx.db.insert("relationships", {
            tenantId: args.tenantId,
            subjectType: args.subjectType,
            subjectId: args.subjectId,
            relation: args.relation,
            objectType: args.objectType,
            objectId: args.objectId,
            condition: args.condition,
            conditionContext: args.conditionContext,
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
            condition: v.optional(v.union(v.string(), v.null())),
            conditionContext: v.optional(v.any()),
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
            if (value === null) {
                // null means clear the field
                patchData[key] = undefined;
            }
            else {
                patchData[key] = value;
            }
        }
        await ctx.db.patch(args.relationshipId, patchData);
    },
});
export const deleteRelationship = mutation({
    args: {
        relationshipId: v.id("relationships"),
    },
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
        tenantId: v.optional(v.string()),
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
    const { tenantId, filter } = args;
    // Collect all effective relationships for this tenant
    const allEffective = await ctx.db
        .query("effectiveRelationships")
        .withIndex("by_tenant_subject_relation_object", (q) => q.eq("tenantId", tenantId))
        .collect();
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
        tenantId: v.optional(v.string()),
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
 * the graph expansion engine. This is an internal mutation that processes in
 * chunks and self-schedules for continuation.
 */
export const rebuildEffectiveChunk = mutation({
    args: {
        tenantId: v.optional(v.string()),
        graphConfig: v.any(),
        cursor: v.optional(v.string()), // last processed relationship _id
        batchSize: v.optional(v.number()),
        stats: v.optional(v.object({
            processed: v.number(),
            total: v.number(),
        })),
        mockWorkpool: v.optional(v.boolean()),
    },
    handler: async (ctx, args) => {
        const { tenantId, graphConfig, cursor, mockWorkpool } = args;
        const batchSize = args.batchSize ?? 25;
        const stats = args.stats ?? { processed: 0, total: 0 };
        // Fetch a batch of base relationships
        let query = ctx.db
            .query("relationships")
            .withIndex("by_tenant_object", (q) => q.eq("tenantId", tenantId));
        const allRels = await query.collect();
        // Find our start position
        let startIdx = 0;
        if (cursor) {
            const cursorIdx = allRels.findIndex((r) => r._id === cursor);
            if (cursorIdx >= 0)
                startIdx = cursorIdx + 1;
        }
        if (stats.total === 0) {
            stats.total = allRels.length;
        }
        const batch = allRels.slice(startIdx, startIdx + batchSize);
        if (batch.length === 0) {
            return { done: true, stats };
        }
        // For each base relationship, create the direct effective relationship
        for (const rel of batch) {
            const sKey = buildScopeKey(rel.subjectType, rel.subjectId);
            const oKey = buildScopeKey(rel.objectType, rel.objectId);
            const pathItem = {
                baseIds: [rel._id],
                conditions: rel.condition
                    ? [
                        {
                            condition: rel.condition,
                            conditionContext: rel.conditionContext,
                        },
                    ]
                    : undefined,
            };
            // Check if this effective relationship already exists
            const existing = await ctx.db
                .query("effectiveRelationships")
                .withIndex("by_tenant_subject_relation_object", (q) => q
                .eq("tenantId", tenantId)
                .eq("subjectKey", sKey)
                .eq("relation", rel.relation)
                .eq("objectKey", oKey))
                .unique();
            if (!existing) {
                await ctx.db.insert("effectiveRelationships", {
                    tenantId,
                    subjectKey: sKey,
                    relation: rel.relation,
                    objectKey: oKey,
                    paths: [pathItem],
                });
            }
            else {
                const itemKey = pathKey(pathItem);
                if (!existing.paths.some((p) => pathKey(p) === itemKey)) {
                    await ctx.db.patch(existing._id, {
                        paths: [...existing.paths, pathItem],
                    });
                }
            }
            // Now expand traversal rules for this relationship
            await expandTraversalRules(ctx, {
                tenantId,
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
                    args: {
                        tenantId,
                        graphConfig,
                        cursor: lastId,
                        batchSize,
                        stats,
                        mockWorkpool,
                    },
                });
            }
            else {
                await expansionPool.enqueueMutation(ctx, api.unsafe.rebuildEffectiveChunk, {
                    tenantId,
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
    const { tenantId, subject, relation, object, path, graphConfig } = args;
    const queue = [
        {
            subject,
            relation,
            object,
            path,
            depth: 1,
            // Rebuild walks every base row independently, so both sides of a
            // reverse-edge declaration are already scheduled. Skip the depth-1
            // reverse push to avoid creating duplicate effective paths for the
            // same underlying base pair.
            skipReverse: true,
        },
    ];
    while (queue.length > 0) {
        const current = queue.shift();
        const sKey = buildScopeKey(current.subject.type, current.subject.id);
        const oKey = buildScopeKey(current.object.type, current.object.id);
        // For items beyond depth 1, upsert the effective relationship. Depth 1
        // was already written by the caller (rebuildEffectiveChunk) so we only
        // need to check the dedup and short-circuit when nothing changes.
        if (current.depth > 1) {
            const canonicalPath = canonicalizePath(current.path);
            const currentPathKey = pathKey(canonicalPath);
            const existing = await ctx.db
                .query("effectiveRelationships")
                .withIndex("by_tenant_subject_relation_object", (q) => q
                .eq("tenantId", tenantId)
                .eq("subjectKey", sKey)
                .eq("relation", current.relation)
                .eq("objectKey", oKey))
                .unique();
            let isNew = false;
            if (!existing) {
                await ctx.db.insert("effectiveRelationships", {
                    tenantId,
                    subjectKey: sKey,
                    relation: current.relation,
                    objectKey: oKey,
                    paths: [canonicalPath],
                });
                isNew = true;
            }
            else if (!existing.paths.some((p) => pathKey(p) === currentPathKey)) {
                await ctx.db.patch(existing._id, {
                    paths: [...existing.paths, canonicalPath],
                });
                isNew = true;
            }
            if (!isNew)
                continue;
        }
        await applyTraversalRulesToItem(ctx, {
            tenantId,
            current,
            queue,
            graphConfig,
        });
    }
}
// ============================================================================
// Step 4: Bulk Transform
// ============================================================================
export const transformChunk = mutation({
    args: {
        tenantId: v.optional(v.string()),
        // Array of operations: { id, action: "patch"|"delete"|"skip", patch?, inserts? }
        operations: v.array(v.object({
            id: v.id("relationships"),
            action: v.union(v.literal("patch"), v.literal("delete"), v.literal("replace"), v.literal("skip")),
            patch: v.optional(v.object({
                subjectType: v.optional(v.string()),
                subjectId: v.optional(v.string()),
                relation: v.optional(v.string()),
                objectType: v.optional(v.string()),
                objectId: v.optional(v.string()),
                condition: v.optional(v.union(v.string(), v.null())),
                conditionContext: v.optional(v.any()),
                properties: v.optional(v.union(v.any(), v.null())),
            })),
            inserts: v.optional(v.array(v.object({
                tenantId: v.optional(v.string()),
                subjectType: v.string(),
                subjectId: v.string(),
                relation: v.string(),
                objectType: v.string(),
                objectId: v.string(),
                condition: v.optional(v.string()),
                conditionContext: v.optional(v.any()),
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
                    if (value === null) {
                        patchData[key] = undefined;
                    }
                    else {
                        patchData[key] = value;
                    }
                }
                await ctx.db.patch(op.id, patchData);
                patched++;
                continue;
            }
            if (op.action === "replace") {
                // Delete original, insert replacements
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
        tenantId: v.optional(v.string()),
        objectType: v.string(),
        oldRelation: v.string(),
        newRelation: v.string(),
    },
    handler: async (ctx, args) => {
        const { tenantId, objectType, oldRelation, newRelation } = args;
        // Find all relationships where this object type has the old relation
        const matches = await ctx.db
            .query("relationships")
            .withIndex("by_tenant_object", (q) => q.eq("tenantId", tenantId).eq("objectType", objectType))
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
        tenantId: v.optional(v.string()),
        oldType: v.string(),
        newType: v.string(),
    },
    handler: async (ctx, args) => {
        const { tenantId, oldType, newType } = args;
        let updated = 0;
        // Update relationships where entity appears as object
        const objectMatches = await ctx.db
            .query("relationships")
            .withIndex("by_tenant_object", (q) => q.eq("tenantId", tenantId).eq("objectType", oldType))
            .collect();
        for (const rel of objectMatches) {
            await ctx.db.patch(rel._id, { objectType: newType });
            updated++;
        }
        // Update relationships where entity appears as subject
        const subjectMatches = await ctx.db
            .query("relationships")
            .withIndex("by_tenant_subject_relation_object", (q) => q.eq("tenantId", tenantId).eq("subjectType", oldType))
            .collect();
        for (const rel of subjectMatches) {
            // Don't double-count if same row was already patched as object
            await ctx.db.patch(rel._id, { subjectType: newType });
            // Only count if this wasn't already counted above
            if (rel.objectType !== oldType) {
                updated++;
            }
        }
        return { updated };
    },
});
//# sourceMappingURL=unsafe.js.map