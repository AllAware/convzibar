import type { ZbarInternal } from "../internal";
/**
 * Expand a permission name into the full set of relations (with optional
 * conditions) that satisfy it on a given object type, walking userset
 * rewrites recursively. Memoised on the per-instance cache.
 */
export declare function resolvePermissionRelations(z: ZbarInternal, objectType: string, permission: string): Array<{
    relation: string;
    condition?: string;
}>;
/**
 * Expand a relation into itself plus all relations it transitively contains
 * via local userset rewrites (e.g. `owner` → `[owner, admin, viewer]` when
 * `admin` is a target of `owner` and `viewer` of `admin`). Memoised.
 */
export declare function resolveRelationInheritance(z: ZbarInternal, objectType: string, relation: string): Array<{
    relation: string;
    condition?: string;
}>;
//# sourceMappingURL=resolvers.d.ts.map