/**
 * Shared base for the two list-style fluent builders. Holds the fields and
 * setters both builders need (`.object()`, `.subject()`, `.relation()`,
 * `.permission()`, `.map()`) so only the terminal `.collect()` logic
 * differs between them.
 *
 * Kept deliberately minimal — the concrete subclasses add their own state
 * (e.g. `_via`, `_mode`) as needed, and may override `object()` to react
 * to the kind of argument passed in.
 */
import type { ZbarInternal } from "../internal";
export declare abstract class BaseListBuilder<Item> {
    protected readonly z: ZbarInternal;
    protected _objectType?: string;
    protected _objectId?: string;
    protected _subjectType?: string;
    protected _subjectId?: string;
    protected _relation?: string;
    protected _permission?: string;
    protected _mapFn?: (item: Item) => unknown;
    constructor(z: ZbarInternal);
    object(objectOrType: string | {
        type: string;
        id: string;
    }): this;
    subject(subjectOrType: string | {
        type: string;
        id: string;
    }): this;
    relation(relation: string): this;
    permission(permission: string): this;
    map(fn: (item: Item) => unknown): this;
    protected _applyMap<T>(items: Item[]): Promise<T[]>;
}
//# sourceMappingURL=base.d.ts.map