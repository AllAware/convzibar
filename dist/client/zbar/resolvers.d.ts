import type { ZbarInternal } from "../internal";
/**
 * Expand a permission name into the full set of relations that satisfy it on a
 * given object type, walking userset rewrites recursively. Memoised.
 */
export declare function resolvePermissionRelations(z: ZbarInternal, objectType: string, permission: string): string[];
/**
 * Expand a relation into itself plus all relations it transitively contains via
 * local userset rewrites (e.g. `owner` → `[owner, admin, viewer]`). Memoised.
 */
export declare function resolveRelationInheritance(z: ZbarInternal, objectType: string, relation: string): string[];
//# sourceMappingURL=resolvers.d.ts.map