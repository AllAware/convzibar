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
    /**
     * Scan base relationships with flexible filtering.
     * No schema validation. Returns raw rows with cursor-based pagination.
     */
    async scanRelationships(ctx, filter, options) {
        return ctx.runQuery(this.component.unsafe.scanRelationships, {
            tenantId: this.options.tenantId,
            filter: filter ?? undefined,
            cursor: options?.cursor,
            limit: options?.limit,
        });
    }
    /**
     * Count base relationships matching a filter.
     * Useful for migration progress tracking.
     */
    async countRelationships(ctx, filter) {
        return ctx.runQuery(this.component.unsafe.countRelationships, {
            tenantId: this.options.tenantId,
            filter: filter ?? undefined,
        });
    }
    // ==========================================================================
    // Step 2: Raw Write Primitives
    // ==========================================================================
    /**
     * Insert a base relationship tuple directly. No schema validation,
     * no effective relationship expansion, and — unlike the production
     * `addRelation` path — no auto-insertion of the declared reverse base
     * row. Callers that want both sides of a `{ type, reverse }` declaration
     * as base rows must insert both explicitly. `rebuildEffectiveRelationships()`
     * will still materialise derived reverse effectives via BFS. Returns
     * the relationship ID.
     */
    async insertRelationship(ctx, row) {
        return ctx.runMutation(this.component.unsafe.insertRelationship, {
            tenantId: this.options.tenantId,
            ...row,
        });
    }
    /**
     * Patch fields on an existing base relationship in-place.
     * No schema validation, no effective relationship recalculation.
     * This is the workhorse for renames — change relation name, entity
     * type, condition, etc. without delete+recreate.
     */
    async patchRelationship(ctx, relationshipId, patch) {
        return ctx.runMutation(this.component.unsafe.patchRelationship, {
            relationshipId,
            patch,
        });
    }
    /**
     * Delete a base relationship by ID. No cascading removal of
     * effective relationships.
     */
    async deleteRelationship(ctx, relationshipId) {
        return ctx.runMutation(this.component.unsafe.deleteRelationship, {
            relationshipId,
        });
    }
    // ==========================================================================
    // Step 3: Effective Relationship Control
    // ==========================================================================
    /**
     * Wipe ALL effective relationships (for this tenant) and rebuild
     * them from base relationships using the current graph config.
     *
     * This is the "nuclear option" — always correct, potentially slow.
     * Call this after you've finished transforming base relationships.
     */
    async rebuildEffectiveRelationships(ctx, options) {
        const graphConfig = options?.graphConfig ?? this.graphConfig;
        // Step 1: Clear all effective relationships
        const { removed } = await ctx.runMutation(this.component.unsafe.clearEffectiveRelationships, {
            tenantId: this.options.tenantId,
        });
        // Step 2: Kick off the rebuild
        const result = await ctx.runMutation(this.component.unsafe.rebuildEffectiveChunk, {
            tenantId: this.options.tenantId,
            graphConfig,
            batchSize: options?.batchSize,
            mockWorkpool: graphConfig.mockWorkpool,
        });
        return { removed, rebuilt: result?.stats?.processed ?? 0 };
    }
    /**
     * Wipe effective relationships without rebuilding.
     * Useful if you want to rebuild in a separate step, or if you
     * want to clear and let lazy evaluation handle it.
     */
    async clearEffectiveRelationships(ctx, filter) {
        return ctx.runMutation(this.component.unsafe.clearEffectiveRelationships, {
            tenantId: this.options.tenantId,
            filter: filter ?? undefined,
        });
    }
    // ==========================================================================
    // Step 4: Bulk Transform
    // ==========================================================================
    /**
     * Apply a transform function to every relationship matching the filter.
     * The transform returns instructions for each row:
     *
     * - `{ patch: { ... } }` — modify fields in-place
     * - `{ replace: [...] }` — delete original and insert replacements
     * - `{ delete: true }` — remove the row
     * - `null` — skip, keep as-is
     *
     * Processes in chunks to stay within Convex mutation limits.
     */
    async transformRelationships(ctx, filter, transform, options) {
        const batchSize = options?.batchSize ?? 50;
        const totals = { patched: 0, inserted: 0, deleted: 0, skipped: 0 };
        let cursor = undefined;
        // Build a scan filter from the count filter
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
            // Build operations for this chunk
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
                        inserts: result.replace.map((r) => ({
                            tenantId: this.options.tenantId,
                            ...r,
                        })),
                    });
                }
            }
            const chunkResult = await ctx.runMutation(this.component.unsafe.transformChunk, {
                tenantId: this.options.tenantId,
                operations,
            });
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
    /**
     * Rename a relation across all base relationships for a given object type.
     * Does NOT rebuild effective relationships — call
     * `rebuildEffectiveRelationships()` after.
     */
    async renameRelation(ctx, objectType, oldRelation, newRelation) {
        return ctx.runMutation(this.component.unsafe.renameRelation, {
            tenantId: this.options.tenantId,
            objectType,
            oldRelation,
            newRelation,
        });
    }
    /**
     * Rename an entity type across all base relationships.
     * Updates both subject and object type references.
     * Does NOT rebuild effective relationships — call
     * `rebuildEffectiveRelationships()` after.
     */
    async renameEntityType(ctx, oldType, newType) {
        return ctx.runMutation(this.component.unsafe.renameEntityType, {
            tenantId: this.options.tenantId,
            oldType,
            newType,
        });
    }
}
//# sourceMappingURL=unsafe.js.map