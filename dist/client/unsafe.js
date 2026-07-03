import { parseSchemaToGraphConfig } from "../component/helpers";
// ============================================================================
// ZbarUnsafe Client
// ============================================================================
/**
 * Unsafe migration client for convzibar. Provides raw access to the
 * relationship tuple store and materialized view, bypassing all schema
 * validation. Import separately for tree-shaking:
 *
 * ```ts
 * import { ZbarUnsafe } from "convzibar/unsafe";
 * ```
 */
export class ZbarUnsafe {
    component;
    options;
    graphConfig;
    constructor(component, options) {
        this.component = component;
        this.options = options;
        this.graphConfig = parseSchemaToGraphConfig(options.schema);
        this.options.asyncWrites = options.asyncWrites ?? true;
    }
    // ==========================================================================
    // Step 1: Read Primitives
    // ==========================================================================
    async scanRelationships(ctx, filter, options) {
        return ctx.runQuery(this.component.unsafe.scanRelationships, {
            filter: filter ?? undefined,
            cursor: options?.cursor,
            limit: options?.limit,
        });
    }
    async countRelationships(ctx, filter) {
        return ctx.runQuery(this.component.unsafe.countRelationships, {
            filter: filter ?? undefined,
        });
    }
    // ==========================================================================
    // Step 2: Raw Write Primitives
    // ==========================================================================
    /**
     * Insert a base relationship tuple directly. No schema validation, no
     * effective relationship expansion, and no auto-insertion of the declared
     * reverse base row. `rebuildEffectiveRelationships()` will still materialise
     * derived effectives via BFS.
     */
    async insertRelationship(ctx, row) {
        return ctx.runMutation(this.component.unsafe.insertRelationship, { ...row });
    }
    /** Patch fields on an existing base relationship in-place. */
    async patchRelationship(ctx, relationshipId, patch) {
        return ctx.runMutation(this.component.unsafe.patchRelationship, {
            relationshipId,
            patch,
        });
    }
    /** Delete a base relationship by ID. No cascading removal of effectives. */
    async deleteRelationship(ctx, relationshipId) {
        return ctx.runMutation(this.component.unsafe.deleteRelationship, {
            relationshipId,
        });
    }
    // ==========================================================================
    // Step 3: Effective Relationship Control
    // ==========================================================================
    /**
     * Wipe ALL effective relationships and rebuild them from base relationships
     * using the current graph config. The "nuclear option" — always correct,
     * potentially slow. Call after transforming base relationships.
     */
    async rebuildEffectiveRelationships(ctx, options) {
        const graphConfig = options?.graphConfig ?? this.graphConfig;
        const { removed } = await ctx.runMutation(this.component.unsafe.clearEffectiveRelationships, {});
        const result = await ctx.runMutation(this.component.unsafe.rebuildEffectiveChunk, {
            graphConfig,
            batchSize: options?.batchSize,
            mockWorkpool: graphConfig.mockWorkpool,
        });
        return { removed, rebuilt: result?.stats?.processed ?? 0 };
    }
    /** Wipe effective relationships without rebuilding. */
    async clearEffectiveRelationships(ctx, filter) {
        return ctx.runMutation(this.component.unsafe.clearEffectiveRelationships, {
            filter: filter ?? undefined,
        });
    }
    // ==========================================================================
    // Step 4: Bulk Transform
    // ==========================================================================
    /**
     * Apply a transform function to every relationship matching the filter,
     * processing in chunks to stay within Convex mutation limits.
     */
    async transformRelationships(ctx, filter, transform, options) {
        const batchSize = options?.batchSize ?? 50;
        const totals = { patched: 0, inserted: 0, deleted: 0, skipped: 0 };
        let cursor = undefined;
        const scanFilter = {};
        if (filter.subjectType)
            scanFilter.subjectType = filter.subjectType;
        if (filter.objectType)
            scanFilter.objectType = filter.objectType;
        if (filter.relation)
            scanFilter.relation = filter.relation;
        while (true) {
            const page = await this.scanRelationships(ctx, scanFilter, {
                cursor,
                limit: batchSize,
            });
            if (page.rows.length === 0)
                break;
            const operations = [];
            for (const row of page.rows) {
                const result = transform(row);
                if (result === null) {
                    operations.push({ id: row._id, action: "skip" });
                }
                else if ("delete" in result) {
                    operations.push({ id: row._id, action: "delete" });
                }
                else if ("patch" in result) {
                    operations.push({ id: row._id, action: "patch", patch: result.patch });
                }
                else if ("replace" in result) {
                    operations.push({
                        id: row._id,
                        action: "replace",
                        inserts: result.replace.map((r) => ({ ...r })),
                    });
                }
            }
            const chunkResult = await ctx.runMutation(this.component.unsafe.transformChunk, { operations });
            totals.patched += chunkResult.patched;
            totals.inserted += chunkResult.inserted;
            totals.deleted += chunkResult.deleted;
            totals.skipped += chunkResult.skipped;
            if (page.isDone)
                break;
            cursor = page.cursor;
        }
        return totals;
    }
    // ==========================================================================
    // Step 5: Convenience Helpers
    // ==========================================================================
    /** Rename a relation across all base relationships for a given object type. */
    async renameRelation(ctx, objectType, oldRelation, newRelation) {
        return ctx.runMutation(this.component.unsafe.renameRelation, {
            objectType,
            oldRelation,
            newRelation,
        });
    }
    /** Rename an entity type across all base relationships (subject + object). */
    async renameEntityType(ctx, oldType, newType) {
        return ctx.runMutation(this.component.unsafe.renameEntityType, {
            oldType,
            newType,
        });
    }
}
//# sourceMappingURL=unsafe.js.map