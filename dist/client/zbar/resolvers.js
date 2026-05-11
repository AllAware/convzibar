import { expandRelationTargets } from "../../shared/relation-def";
/**
 * Expand a permission name into the full set of relations (with optional
 * conditions) that satisfy it on a given object type, walking userset
 * rewrites recursively. Memoised on the per-instance cache.
 */
export function resolvePermissionRelations(z, objectType, permission) {
    const cacheKey = `${objectType}:${permission}`;
    const cached = z.permissionRelationsCache.get(cacheKey);
    if (cached)
        return cached;
    const perms = z.schema.entities[objectType]?.permissions?.[permission] || [];
    const results = expandRelationTargets(z.schema, objectType, perms);
    z.permissionRelationsCache.set(cacheKey, results);
    return results;
}
/**
 * Expand a relation into itself plus all relations it transitively contains
 * via local userset rewrites (e.g. `owner` → `[owner, admin, viewer]` when
 * `admin` is a target of `owner` and `viewer` of `admin`). Memoised.
 */
export function resolveRelationInheritance(z, objectType, relation) {
    const cacheKey = `rel_inh:${objectType}:${relation}`;
    const cached = z.permissionRelationsCache.get(cacheKey);
    if (cached)
        return cached;
    const results = expandRelationTargets(z.schema, objectType, [relation]);
    z.permissionRelationsCache.set(cacheKey, results);
    return results;
}
//# sourceMappingURL=resolvers.js.map