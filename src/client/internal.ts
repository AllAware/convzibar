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
// ============================================================================

export interface ZbarInternal {
  component: any;
  schema: ZbarSchema;
  asyncWrites: boolean;
  graphConfig: GraphConfig;
  /** Stable content hash of `graphConfig`; mutations ship this instead of the config. */
  configHash: string;
  readTimeChainDepth: number;
  /**
   * Memoises both `permission → relations` and `relation → inherited relations`
   * lookups, keyed by `${objectType}:${name}` and `rel_inh:${objectType}:${name}`
   * respectively. Per-Zbar-instance.
   */
  permissionRelationsCache: Map<string, string[]>;
}
