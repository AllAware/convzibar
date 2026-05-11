import type { ActionCtx, QueryCtx } from "../internal";
import { BaseListBuilder } from "../list/base";
import type { DirectRelationship } from "./types";
/**
 * Internal implementation of the fluent direct-relationship query builder.
 */
export declare class ListDirectQueryBuilder extends BaseListBuilder<DirectRelationship> {
    collect(ctx: QueryCtx | ActionCtx): Promise<DirectRelationship[]>;
}
//# sourceMappingURL=builder.d.ts.map