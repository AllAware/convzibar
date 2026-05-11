import type { GenericActionCtx, GenericDataModel, GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { GraphConfig } from "../component/types";
import type { ZbarSchema } from "./index";
type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;
type ActionCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery" | "runMutation" | "runAction">;
export interface RawRelationship {
    _id: string;
    tenantId?: string;
    subjectType: string;
    subjectId: string;
    relation: string;
    objectType: string;
    objectId: string;
    condition?: string;
    conditionContext?: unknown;
    properties?: unknown;
}
export interface RawRelationshipFields {
    tenantId?: string;
    subjectType: string;
    subjectId: string;
    relation: string;
    objectType: string;
    objectId: string;
    condition?: string;
    conditionContext?: unknown;
    properties?: unknown;
}
export interface ScanFilter {
    subjectType?: string;
    subjectId?: string;
    relation?: string;
    objectType?: string;
    objectId?: string;
}
export interface CountFilter {
    subjectType?: string;
    objectType?: string;
    relation?: string;
}
export interface ScanResult {
    rows: RawRelationship[];
    cursor?: string;
    isDone: boolean;
}
export type TransformResult = {
    patch: Partial<RawRelationshipFields>;
} | {
    replace: RawRelationshipFields[];
} | {
    delete: true;
} | null;
/**
 * Unsafe migration client for convzibar. Provides raw access to the
 * relationship tuple store and materialized view, bypassing all schema
 * validation. Import separately for tree-shaking:
 *
 * ```ts
 * import { ZbarUnsafe } from "convzibar/unsafe";
 * ```
 */
export declare class ZbarUnsafe<Schema extends ZbarSchema = ZbarSchema> {
    private component;
    private options;
    private graphConfig;
    constructor(component: any, options: {
        schema: Schema;
        tenantId: string;
        asyncWrites?: boolean;
    });
    /**
     * Scan base relationships with flexible filtering.
     * No schema validation. Returns raw rows with cursor-based pagination.
     */
    scanRelationships(ctx: QueryCtx | ActionCtx, filter?: ScanFilter, options?: {
        cursor?: string;
        limit?: number;
    }): Promise<ScanResult>;
    /**
     * Count base relationships matching a filter.
     * Useful for migration progress tracking.
     */
    countRelationships(ctx: QueryCtx | ActionCtx, filter?: CountFilter): Promise<number>;
    /**
     * Insert a base relationship tuple directly. No schema validation,
     * no effective relationship expansion, and — unlike the production
     * `addRelation` path — no auto-insertion of the declared reverse base
     * row. Callers that want both sides of a `{ type, reverse }` declaration
     * as base rows must insert both explicitly. `rebuildEffectiveRelationships()`
     * will still materialise derived reverse effectives via BFS. Returns
     * the relationship ID.
     */
    insertRelationship(ctx: MutationCtx | ActionCtx, row: {
        subjectType: string;
        subjectId: string;
        relation: string;
        objectType: string;
        objectId: string;
        condition?: string;
        conditionContext?: unknown;
    }): Promise<string>;
    /**
     * Patch fields on an existing base relationship in-place.
     * No schema validation, no effective relationship recalculation.
     * This is the workhorse for renames — change relation name, entity
     * type, condition, etc. without delete+recreate.
     */
    patchRelationship(ctx: MutationCtx | ActionCtx, relationshipId: string, patch: {
        subjectType?: string;
        subjectId?: string;
        relation?: string;
        objectType?: string;
        objectId?: string;
        condition?: string | null;
        conditionContext?: unknown | null;
    }): Promise<void>;
    /**
     * Delete a base relationship by ID. No cascading removal of
     * effective relationships.
     */
    deleteRelationship(ctx: MutationCtx | ActionCtx, relationshipId: string): Promise<void>;
    /**
     * Wipe ALL effective relationships (for this tenant) and rebuild
     * them from base relationships using the current graph config.
     *
     * This is the "nuclear option" — always correct, potentially slow.
     * Call this after you've finished transforming base relationships.
     */
    rebuildEffectiveRelationships(ctx: MutationCtx | ActionCtx, options?: {
        graphConfig?: GraphConfig;
        batchSize?: number;
    }): Promise<{
        removed: number;
        rebuilt: number;
    }>;
    /**
     * Wipe effective relationships without rebuilding.
     * Useful if you want to rebuild in a separate step, or if you
     * want to clear and let lazy evaluation handle it.
     */
    clearEffectiveRelationships(ctx: MutationCtx | ActionCtx, filter?: CountFilter): Promise<{
        removed: number;
    }>;
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
    transformRelationships(ctx: MutationCtx | ActionCtx, filter: CountFilter, transform: (row: RawRelationship) => TransformResult, options?: {
        batchSize?: number;
    }): Promise<{
        patched: number;
        inserted: number;
        deleted: number;
        skipped: number;
    }>;
    /**
     * Rename a relation across all base relationships for a given object type.
     * Does NOT rebuild effective relationships — call
     * `rebuildEffectiveRelationships()` after.
     */
    renameRelation(ctx: MutationCtx | ActionCtx, objectType: string, oldRelation: string, newRelation: string): Promise<{
        updated: number;
    }>;
    /**
     * Rename an entity type across all base relationships.
     * Updates both subject and object type references.
     * Does NOT rebuild effective relationships — call
     * `rebuildEffectiveRelationships()` after.
     */
    renameEntityType(ctx: MutationCtx | ActionCtx, oldType: string, newType: string): Promise<{
        updated: number;
    }>;
}
export {};
//# sourceMappingURL=unsafe.d.ts.map