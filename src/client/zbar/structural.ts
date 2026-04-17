import type { ZbarInternal } from "../internal";
import { resolveRelationInheritance } from "./resolvers";

/** Names of all relations declared on the given entity type. */
export function getEntityRelations(
  z: ZbarInternal,
  entityType: string,
): string[] {
  return Object.keys(z.schema.entities[entityType]?.relations || {});
}

/**
 * For a given object type and set of acceptable relations, extract
 * the relations on a via entity type that are referenced by userset
 * rewrites (e.g. `system#admin`), expanded with local inheritance.
 *
 * Example: `device.admin` includes `system#admin`.
 * For objectType="device", acceptableRelations=["admin"], viaType="system"
 * → returns ["admin", "owner"] (admin + owner which inherits admin).
 *
 * Returns [] if the via type is not referenced by any userset rewrite
 * in the acceptable relations, signalling a loose gate should be used.
 */
export function getViaRelevantRelations(
  z: ZbarInternal,
  objectType: string,
  acceptableRelations: string[],
  viaType: string,
): string[] {
  const objectDef = z.schema.entities[objectType];
  if (!objectDef?.relations) return [];

  const baseRelations = new Set<string>();

  for (const rel of acceptableRelations) {
    const relDef = objectDef.relations[rel];
    if (!relDef) continue;
    const defs = Array.isArray(relDef) ? relDef : [relDef];
    for (const d of defs) {
      // Handle # notation: 'system#admin'
      if (typeof d === "string" && d.includes("#")) {
        const [type, viaRel] = d.split("#");
        if (type === viaType) {
          baseRelations.add(viaRel);
        }
      }
      // Handle . notation: 'owner.admin' where owner points to viaType
      if (typeof d === "string" && d.includes(".")) {
        const [baseRel, viaRel] = d.split(".");
        const baseRelDef = objectDef.relations?.[baseRel];
        if (baseRelDef) {
          const baseDefs = Array.isArray(baseRelDef) ? baseRelDef : [baseRelDef];
          for (const bd of baseDefs) {
            // Object-form target: { type: 'system', reverse: ... }
            if (
              typeof bd === "object" &&
              bd !== null &&
              "type" in bd &&
              (bd as any).type === viaType
            ) {
              baseRelations.add(viaRel);
              break;
            }
            // String-form target: .relation('source', 'system', ...).
            // Same test as getStructuralRelations — a bare entity-type
            // string that also matches viaType counts as a via-targeting
            // base relation.
            if (
              typeof bd === "string" &&
              bd === viaType &&
              !bd.includes(".") &&
              !bd.includes("#") &&
              z.schema.entities[bd] !== undefined &&
              objectDef.relations?.[bd] === undefined
            ) {
              baseRelations.add(viaRel);
              break;
            }
          }
        }
      }
    }
  }

  // Include read-time paths whose source connects to viaType. A
  // `readTimeRelation('viewer', 'owner.viewer')` with sourceTypes
  // containing `viaType` means "subject having `targetRelation` on
  // `viaType` suffices to reach the object" — exactly the condition the
  // via gate / tight-expand needs to know about.
  for (const rtPath of z.graphConfig.readTimePaths ?? []) {
    if (rtPath.objectType !== objectType) continue;
    if (!acceptableRelations.includes(rtPath.derivedRelation)) continue;
    if (!rtPath.sourceTypes.includes(viaType)) continue;
    baseRelations.add(rtPath.targetRelation);
  }

  if (baseRelations.size === 0) return [];

  // Expand with inheritance on the via entity type
  const expanded = new Set<string>();
  for (const rel of baseRelations) {
    const inherited = resolveRelationInheritance(z, viaType, rel);
    for (const t of inherited) {
      expanded.add(t.relation);
    }
  }

  return [...expanded];
}

/**
 * Get relations on objectType whose subject type matches the given type.
 * These are the structural/ownership relations connecting two entity types
 * (e.g. device.owner → system).
 */
export function getStructuralRelations(
  z: ZbarInternal,
  objectType: string,
  subjectType: string,
): string[] {
  const objectDef = z.schema.entities[objectType];
  if (!objectDef?.relations) return [];

  const result: string[] = [];
  for (const [relName, relDef] of Object.entries(objectDef.relations as Record<string, any>)) {
    const defs = Array.isArray(relDef) ? relDef : [relDef];
    for (const d of defs) {
      // Object syntax: .relation('owner', { type: 'system', reverse: ... })
      if (
        typeof d === "object" &&
        d !== null &&
        "type" in d &&
        (d as any).type === subjectType
      ) {
        result.push(relName);
        break;
      }
      // String syntax: .relation('source', 'system', 'group', ...).
      // A bare entity-type name (not a dot-path, not a userset, not a
      // local relation on the current entity) is structurally equivalent
      // to { type: <name> } — just without a reverse.
      if (
        typeof d === "string" &&
        d === subjectType &&
        !d.includes(".") &&
        !d.includes("#") &&
        z.schema.entities[d] !== undefined &&
        objectDef.relations?.[d] === undefined
      ) {
        result.push(relName);
        break;
      }
    }
  }
  return result;
}

/**
 * Get relations on viaType where objectType entities are subjects.
 * These are the reverse structural relations discovered from
 * `{ type, reverse }` declarations on the objectType entity.
 *
 * Example: device.owner = { type: 'system', reverse: 'device_member' }
 * → for objectType='device', viaType='system' returns ['device_member']
 */
export function getReverseStructuralRelations(
  z: ZbarInternal,
  objectType: string,
  viaType: string,
): string[] {
  const objectDef = z.schema.entities[objectType];
  if (!objectDef?.relations) return [];

  const result: string[] = [];
  for (const [, relDef] of Object.entries(objectDef.relations as Record<string, any>)) {
    const defs = Array.isArray(relDef) ? relDef : [relDef];
    for (const d of defs) {
      if (
        typeof d === "object" &&
        d !== null &&
        "type" in d &&
        "reverse" in d &&
        (d as any).type === viaType &&
        typeof (d as any).reverse === "string"
      ) {
        result.push((d as any).reverse);
      }
    }
  }
  return result;
}
