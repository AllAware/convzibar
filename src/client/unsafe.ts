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
 * import { ZbarUnsafe } from "@csilvas/convzibar/unsafe";
 * ```
 */
export class ZbarUnsafe<Schema extends ZbarSchema = ZbarSchema> {
  private graphConfig: GraphConfig;

  constructor(
    private component: any,
    private options: {
      schema: Schema;
      tenantId: string;
      asyncWrites?: boolean;
    },
  ) {
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
  async scanRelationships(
    ctx: QueryCtx | ActionCtx,
    filter?: ScanFilter,
    options?: { cursor?: string; limit?: number },
  ): Promise<ScanResult> {
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
  async countRelationships(
    ctx: QueryCtx | ActionCtx,
    filter?: CountFilter,
  ): Promise<number> {
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
  async insertRelationship(
    ctx: MutationCtx | ActionCtx,
    row: {
      subjectType: string;
      subjectId: string;
      relation: string;
      objectType: string;
      objectId: string;
      condition?: string;
      conditionContext?: unknown;
    },
  ): Promise<string> {
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
  async patchRelationship(
    ctx: MutationCtx | ActionCtx,
    relationshipId: string,
    patch: {
      subjectType?: string;
      subjectId?: string;
      relation?: string;
      objectType?: string;
      objectId?: string;
      condition?: string | null;
      conditionContext?: unknown | null;
    },
  ): Promise<void> {
    return ctx.runMutation(this.component.unsafe.patchRelationship, {
      relationshipId,
      patch,
    });
  }

  /**
   * Delete a base relationship by ID. No cascading removal of
   * effective relationships.
   */
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
   * Wipe ALL effective relationships (for this tenant) and rebuild
   * them from base relationships using the current graph config.
   *
   * This is the "nuclear option" — always correct, potentially slow.
   * Call this after you've finished transforming base relationships.
   */
  async rebuildEffectiveRelationships(
    ctx: MutationCtx | ActionCtx,
    options?: { graphConfig?: GraphConfig; batchSize?: number },
  ): Promise<{ removed: number; rebuilt: number }> {
    const graphConfig = options?.graphConfig ?? this.graphConfig;

    // Step 1: Clear all effective relationships
    const { removed } = await ctx.runMutation(
      this.component.unsafe.clearEffectiveRelationships,
      {
        tenantId: this.options.tenantId,
      },
    );

    // Step 2: Kick off the rebuild
    const result = await ctx.runMutation(
      this.component.unsafe.rebuildEffectiveChunk,
      {
        tenantId: this.options.tenantId,
        graphConfig,
        batchSize: options?.batchSize,
        mockWorkpool: graphConfig.mockWorkpool,
      },
    );

    return { removed, rebuilt: result?.stats?.processed ?? 0 };
  }

  /**
   * Wipe effective relationships without rebuilding.
   * Useful if you want to rebuild in a separate step, or if you
   * want to clear and let lazy evaluation handle it.
   */
  async clearEffectiveRelationships(
    ctx: MutationCtx | ActionCtx,
    filter?: CountFilter,
  ): Promise<{ removed: number }> {
    return ctx.runMutation(
      this.component.unsafe.clearEffectiveRelationships,
      {
        tenantId: this.options.tenantId,
        filter: filter ?? undefined,
      },
    );
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
  async transformRelationships(
    ctx: MutationCtx | ActionCtx,
    filter: CountFilter,
    transform: (row: RawRelationship) => TransformResult,
    options?: { batchSize?: number },
  ): Promise<{
    patched: number;
    inserted: number;
    deleted: number;
    skipped: number;
  }> {
    const batchSize = options?.batchSize ?? 50;
    const totals = { patched: 0, inserted: 0, deleted: 0, skipped: 0 };
    let cursor: string | undefined = undefined;

    // Build a scan filter from the count filter
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

      // Build operations for this chunk
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
            inserts: result.replace.map((r) => ({
              tenantId: this.options.tenantId,
              ...r,
            })),
          });
        }
      }

      const chunkResult = await ctx.runMutation(
        this.component.unsafe.transformChunk,
        {
          tenantId: this.options.tenantId,
          operations,
        },
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

  /**
   * Rename a relation across all base relationships for a given object type.
   * Does NOT rebuild effective relationships — call
   * `rebuildEffectiveRelationships()` after.
   */
  async renameRelation(
    ctx: MutationCtx | ActionCtx,
    objectType: string,
    oldRelation: string,
    newRelation: string,
  ): Promise<{ updated: number }> {
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
  async renameEntityType(
    ctx: MutationCtx | ActionCtx,
    oldType: string,
    newType: string,
  ): Promise<{ updated: number }> {
    return ctx.runMutation(this.component.unsafe.renameEntityType, {
      tenantId: this.options.tenantId,
      oldType,
      newType,
    });
  }
}
