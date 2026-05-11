import type { GenericActionCtx, GenericDataModel, GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { GraphConfig } from "../component/types";
import type { ZbarSchema } from "./types";
export type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
export type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;
export type ActionCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery" | "runMutation" | "runAction">;
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
    permissionRelationsCache: Map<string, Array<{
        relation: string;
        condition?: string;
    }>>;
}
//# sourceMappingURL=internal.d.ts.map