import { expandRelationTargets } from "../../shared/relation-def";
import type { ZbarInternal } from "../internal";

/**
 * Expand a permission name into the full set of relations that satisfy it on a
 * given object type, walking userset rewrites recursively. Memoised.
 */
export function resolvePermissionRelations(
  z: ZbarInternal,
  objectType: string,
  permission: string,
): string[] {
  const cacheKey = `${objectType}:${permission}`;
  const cached = z.permissionRelationsCache.get(cacheKey);
  if (cached) return cached;

  const perms = z.schema.entities[objectType]?.permissions?.[permission] || [];
  const results = expandRelationTargets(z.schema, objectType, perms);

  z.permissionRelationsCache.set(cacheKey, results);
  return results;
}

/**
 * Expand a relation into itself plus all relations it transitively contains via
 * local userset rewrites (e.g. `owner` → `[owner, admin, viewer]`). Memoised.
 */
export function resolveRelationInheritance(
  z: ZbarInternal,
  objectType: string,
  relation: string,
): string[] {
  const cacheKey = `rel_inh:${objectType}:${relation}`;
  const cached = z.permissionRelationsCache.get(cacheKey);
  if (cached) return cached;

  const results = expandRelationTargets(z.schema, objectType, [relation]);

  z.permissionRelationsCache.set(cacheKey, results);
  return results;
}
