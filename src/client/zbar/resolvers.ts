import type { ZbarInternal } from "../internal";

/**
 * Expand a permission name into the full set of relations (with optional
 * conditions) that satisfy it on a given object type, walking userset
 * rewrites recursively. Memoised on the per-instance cache.
 */
export function resolvePermissionRelations(
  z: ZbarInternal,
  objectType: string,
  permission: string,
): Array<{ relation: string; condition?: string }> {
  const cacheKey = `${objectType}:${permission}`;
  const cached = z.permissionRelationsCache.get(cacheKey);
  if (cached) return cached;

  const perms = z.schema.entities[objectType]?.permissions?.[permission] || [];
  const results: Array<{ relation: string; condition?: string }> = [];

  const expand = (rel: string, currentCondition?: string) => {
    if (
      results.some(
        (r) => r.relation === rel && r.condition === currentCondition,
      )
    )
      return;
    results.push({ relation: rel, condition: currentCondition });

    const relDef = z.schema.entities[objectType]?.relations?.[rel];
    if (relDef) {
      const defs = Array.isArray(relDef) ? relDef : [relDef];
      for (const d of defs) {
        if (typeof d === "string" && !d.includes(".")) {
          expand(d, currentCondition);
        } else if (typeof d === "object" && d !== null && "relation" in d) {
          if (
            typeof (d as any).relation === "string" &&
            !(d as any).relation.includes(".")
          ) {
            expand(
              (d as any).relation,
              (d as any).condition || currentCondition,
            );
          }
        }
      }
    }
  };

  for (const p of perms) {
    if (typeof p === "string") {
      expand(p, undefined);
    } else {
      expand((p as any).relation, (p as any).condition);
    }
  }

  z.permissionRelationsCache.set(cacheKey, results);
  return results;
}

/**
 * Expand a relation into itself plus all relations it transitively contains
 * via local userset rewrites (e.g. `owner` → `[owner, admin, viewer]` when
 * `admin` is a target of `owner` and `viewer` of `admin`). Memoised.
 */
export function resolveRelationInheritance(
  z: ZbarInternal,
  objectType: string,
  relation: string,
): Array<{ relation: string; condition?: string }> {
  const cacheKey = `rel_inh:${objectType}:${relation}`;
  const cached = z.permissionRelationsCache.get(cacheKey);
  if (cached) return cached;

  const results: Array<{ relation: string; condition?: string }> = [];

  const expand = (rel: string, currentCondition?: string) => {
    if (
      results.some(
        (r) => r.relation === rel && r.condition === currentCondition,
      )
    )
      return;
    results.push({ relation: rel, condition: currentCondition });

    const relDef = z.schema.entities[objectType]?.relations?.[rel];
    if (relDef) {
      const defs = Array.isArray(relDef) ? relDef : [relDef];
      for (const d of defs) {
        if (typeof d === "string" && !d.includes(".")) {
          expand(d, currentCondition);
        } else if (typeof d === "object" && d !== null && "relation" in d) {
          if (
            typeof (d as any).relation === "string" &&
            !(d as any).relation.includes(".")
          ) {
            expand(
              (d as any).relation,
              (d as any).condition || currentCondition,
            );
          }
        }
      }
    }
  };

  expand(relation, undefined);

  z.permissionRelationsCache.set(cacheKey, results);
  return results;
}
