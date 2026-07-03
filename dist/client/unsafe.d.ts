import type { GenericActionCtx, GenericDataModel, GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { GraphConfig } from "../component/types";
import type { ZbarSchema } from "./index";
type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;
type ActionCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery" | "runMutation" | "runAction">;
export interface RawRelationship {
    _id: string;
    subjectType: string;
    subjectId: string;
    relation: string;
    objectType: string;
    objectId: string;
    properties?: unknown;
}
export interface RawRelationshipFields {
    subjectType: string;
    subjectId: string;
    relation: string;
    objectType: string;
    objectId: string;
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
        asyncWrites?: boolean;
    });
    scanRelationships(ctx: QueryCtx | ActionCtx, filter?: ScanFilter, options?: {
        cursor?: string;
        limit?: number;
    }): Promise<ScanResult>;
    countRelationships(ctx: QueryCtx | ActionCtx, filter?: CountFilter): Promise<number>;
    /**
     * Insert a base relationship tuple directly. No schema validation, no
     * effective relationship expansion, and no auto-insertion of the declared
     * reverse base row. `rebuildEffectiveRelationships()` will still materialise
     * derived effectives via BFS.
     */
    insertRelationship(ctx: MutationCtx | ActionCtx, row: {
        subjectType: string;
        subjectId: string;
        relation: string;
        objectType: string;
        objectId: string;
        properties?: unknown;
    }): Promise<string>;
    /** Patch fields on an existing base relationship in-place. */
    patchRelationship(ctx: MutationCtx | ActionCtx, relationshipId: string, patch: {
        subjectType?: string;
        subjectId?: string;
        relation?: string;
        objectType?: string;
        objectId?: string;
        properties?: unknown | null;
    }): Promise<void>;
    /** Delete a base relationship by ID. No cascading removal of effectives. */
    deleteRelationship(ctx: MutationCtx | ActionCtx, relationshipId: string): Promise<void>;
    /**
     * Wipe ALL effective relationships and rebuild them from base relationships
     * using the current graph config. The "nuclear option" — always correct,
     * potentially slow. Call after transforming base relationships.
     */
    rebuildEffectiveRelationships(ctx: MutationCtx | ActionCtx, options?: {
        graphConfig?: GraphConfig;
        batchSize?: number;
    }): Promise<{
        removed: number;
        rebuilt: number;
    }>;
    /** Wipe effective relationships without rebuilding. */
    clearEffectiveRelationships(ctx: MutationCtx | ActionCtx, filter?: CountFilter): Promise<{
        removed: number;
    }>;
    /**
     * Apply a transform function to every relationship matching the filter,
     * processing in chunks to stay within Convex mutation limits.
     */
    transformRelationships(ctx: MutationCtx | ActionCtx, filter: CountFilter, transform: (row: RawRelationship) => TransformResult, options?: {
        batchSize?: number;
    }): Promise<{
        patched: number;
        inserted: number;
        deleted: number;
        skipped: number;
    }>;
    /** Rename a relation across all base relationships for a given object type. */
    renameRelation(ctx: MutationCtx | ActionCtx, objectType: string, oldRelation: string, newRelation: string): Promise<{
        updated: number;
    }>;
    /** Rename an entity type across all base relationships (subject + object). */
    renameEntityType(ctx: MutationCtx | ActionCtx, oldType: string, newType: string): Promise<{
        updated: number;
    }>;
}
export {};
//# sourceMappingURL=unsafe.d.ts.map