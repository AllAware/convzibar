import type { ActionCtx, QueryCtx } from "../internal";
import type { ZbarSchema } from "../types";
import { BaseListBuilder } from "./base";
type ListResult = {
    objectId: string;
} | {
    subjectId: string;
};
/**
 * Internal implementation of the fluent list query builder.
 * A single class implements all builder interfaces; the TypeScript interfaces
 * (in ./types.ts) restrict which methods are visible at each step.
 */
export declare class ListQueryBuilder<Schema extends ZbarSchema<Data>, Data> extends BaseListBuilder<ListResult> {
    private _via;
    private _mode;
    /**
     * Overridden to set `_mode` alongside the normal object/type assignment:
     * `object(string)` is the "list objects" flavour, `object({type, id})` is
     * the "list subjects" flavour.
     */
    object(objectOrType: string | {
        type: string;
        id: string;
    }): this;
    via(...entities: Array<{
        type: string;
        id: string;
    } | null | undefined>): this;
    collect(ctx: QueryCtx | ActionCtx, requestContext?: Data): Promise<ListResult[]>;
}
export {};
//# sourceMappingURL=builder.d.ts.map