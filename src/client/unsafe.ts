import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import { parseSchemaToGraphConfig } from "../component/helpers";
import type { GraphConfig } from "../component/types";
import type { ZbarSchema } from "./index";

// ============================================================================
// Types
// ============================================================================

type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;
type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction"
>;

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

export type TransformResult =
  | { patch: Partial<RawRelationshipFields> }
  | { replace: RawRelationshipFields[] }
  | { delete: true }
  | null;

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
export class ZbarUnsafe<Schema extends ZbarSchema = ZbarSchema> {
  private graphConfig: GraphConfig;

  constructor(
    private component: any,
    private options: {
      schema: Schema;
      asyncWrites?: boolean;
    },
  ) {
    this.graphConfig = parseSchemaToGraphConfig(options.schema);
    this.options.asyncWrites = options.asyncWrites ?? true;
  }

  // ==========================================================================
  // Step 1: Read Primitives
  // ==========================================================================

  async scanRelationships(
    ctx: QueryCtx | ActionCtx,
    filter?: ScanFilter,
    options?: { cursor?: string; limit?: number },
  ): Promise<ScanResult> {
    return ctx.runQuery(this.component.unsafe.scanRelationships, {
      filter: filter ?? undefined,
      cursor: options?.cursor,
      limit: options?.limit,
    });
  }

  async countRelationships(
    ctx: QueryCtx | ActionCtx,
    filter?: CountFilter,
  ): Promise<number> {
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
  async insertRelationship(
    ctx: MutationCtx | ActionCtx,
    row: {
      subjectType: string;
      subjectId: string;
      relation: string;
      objectType: string;
      objectId: string;
      properties?: unknown;
    },
  ): Promise<string> {
    return ctx.runMutation(this.component.unsafe.insertRelationship, { ...row });
  }

  /** Patch fields on an existing base relationship in-place. */
  async patchRelationship(
    ctx: MutationCtx | ActionCtx,
    relationshipId: string,
    patch: {
      subjectType?: string;
      subjectId?: string;
      relation?: string;
      objectType?: string;
      objectId?: string;
      properties?: unknown | null;
    },
  ): Promise<void> {
    return ctx.runMutation(this.component.unsafe.patchRelationship, {
      relationshipId,
      patch,
    });
  }

  /** Delete a base relationship by ID. No cascading removal of effectives. */
  async deleteRelationship(
    ctx: MutationCtx | ActionCtx,
    relationshipId: string,
  ): Promise<void> {
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
  async rebuildEffectiveRelationships(
    ctx: MutationCtx | ActionCtx,
    options?: { graphConfig?: GraphConfig; batchSize?: number },
  ): Promise<{ removed: number; rebuilt: number }> {
    const graphConfig = options?.graphConfig ?? this.graphConfig;

    const { removed } = await ctx.runMutation(
      this.component.unsafe.clearEffectiveRelationships,
      {},
    );

    const result = await ctx.runMutation(
      this.component.unsafe.rebuildEffectiveChunk,
      {
        graphConfig,
        batchSize: options?.batchSize,
        mockWorkpool: graphConfig.mockWorkpool,
      },
    );

    return { removed, rebuilt: result?.stats?.processed ?? 0 };
  }

  /** Wipe effective relationships without rebuilding. */
  async clearEffectiveRelationships(
    ctx: MutationCtx | ActionCtx,
    filter?: CountFilter,
  ): Promise<{ removed: number }> {
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
  async transformRelationships(
    ctx: MutationCtx | ActionCtx,
    filter: CountFilter,
    transform: (row: RawRelationship) => TransformResult,
    options?: { batchSize?: number },
  ): Promise<{ patched: number; inserted: number; deleted: number; skipped: number }> {
    const batchSize = options?.batchSize ?? 50;
    const totals = { patched: 0, inserted: 0, deleted: 0, skipped: 0 };
    let cursor: string | undefined = undefined;

    const scanFilter: ScanFilter = {};
    if (filter.subjectType) scanFilter.subjectType = filter.subjectType;
    if (filter.objectType) scanFilter.objectType = filter.objectType;
    if (filter.relation) scanFilter.relation = filter.relation;

    while (true) {
      const page = await this.scanRelationships(ctx as QueryCtx, scanFilter, {
        cursor,
        limit: batchSize,
      });

      if (page.rows.length === 0) break;

      const operations: Array<{
        id: string;
        action: "patch" | "delete" | "replace" | "skip";
        patch?: Record<string, unknown>;
        inserts?: RawRelationshipFields[];
      }> = [];

      for (const row of page.rows) {
        const result = transform(row);
        if (result === null) {
          operations.push({ id: row._id, action: "skip" });
        } else if ("delete" in result) {
          operations.push({ id: row._id, action: "delete" });
        } else if ("patch" in result) {
          operations.push({ id: row._id, action: "patch", patch: result.patch });
        } else if ("replace" in result) {
          operations.push({
            id: row._id,
            action: "replace",
            inserts: result.replace.map((r) => ({ ...r })),
          });
        }
      }

      const chunkResult = await ctx.runMutation(
        this.component.unsafe.transformChunk,
        { operations },
      );

      totals.patched += chunkResult.patched;
      totals.inserted += chunkResult.inserted;
      totals.deleted += chunkResult.deleted;
      totals.skipped += chunkResult.skipped;

      if (page.isDone) break;
      cursor = page.cursor;
    }

    return totals;
  }

  // ==========================================================================
  // Step 5: Convenience Helpers
  // ==========================================================================

  /** Rename a relation across all base relationships for a given object type. */
  async renameRelation(
    ctx: MutationCtx | ActionCtx,
    objectType: string,
    oldRelation: string,
    newRelation: string,
  ): Promise<{ updated: number }> {
    return ctx.runMutation(this.component.unsafe.renameRelation, {
      objectType,
      oldRelation,
      newRelation,
    });
  }

  /** Rename an entity type across all base relationships (subject + object). */
  async renameEntityType(
    ctx: MutationCtx | ActionCtx,
    oldType: string,
    newType: string,
  ): Promise<{ updated: number }> {
    return ctx.runMutation(this.component.unsafe.renameEntityType, {
      oldType,
      newType,
    });
  }
}
