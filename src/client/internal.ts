import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import type { GraphConfig } from "../component/types";
import type { ZbarSchema } from "./types";

// ============================================================================
// Convex context aliases (internal — not re-exported publicly)
// ============================================================================

export type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
export type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;
export type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction"
>;

// ============================================================================
// ZbarInternal — the bundle of state that pure helpers operate on.
// One per Zbar instance. Builders and helper modules receive this as their
// first argument instead of reaching into a Zbar instance.
// ============================================================================

export interface ZbarInternal {
  component: any;
  schema: ZbarSchema;
  tenantId: string;
  defaultActorId?: string;
  enableAuditLog: boolean;
  asyncWrites: boolean;
  graphConfig: GraphConfig;
  readTimeChainDepth: number;
  /**
   * Memoises both `permission → relations` and `relation → inherited relations`
   * lookups, keyed by `${objectType}:${name}` and `rel_inh:${objectType}:${name}`
   * respectively. Per-Zbar-instance.
   */
  permissionRelationsCache: Map<
    string,
    Array<{ relation: string; condition?: string }>
  >;
}
