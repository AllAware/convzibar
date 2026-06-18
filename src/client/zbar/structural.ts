import { iterateRelationTargets } from "../../shared/relation-def";
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
 * Iterate over `(relName, target)` pairs for every relation declared on
 * `objectType`, with each target already classified by
 * `iterateRelationTargets`. Callers match on `target.kind` instead of
 * re-parsing strings.
 */
function* iterateObjectRelationTargets(z: ZbarInternal, objectType: string) {
  const objectDef = z.schema.entities[objectType];
  if (!objectDef?.relations) return;
  const classifyCtx = {
    localRelations: objectDef.relations as Record<string, unknown>,
    entities: z.schema.entities as Record<string, unknown>,
  };
  for (const [relName, relDef] of Object.entries(objectDef.relations)) {
    for (const target of iterateRelationTargets(relDef, classifyCtx)) {
      yield { relName, target };
    }
  }
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
  const classifyCtx = {
    localRelations: objectDef.relations as Record<string, unknown>,
    entities: z.schema.entities as Record<string, unknown>,
  };

  for (const rel of acceptableRelations) {
    const relDef = objectDef.relations[rel];
    if (!relDef) continue;
    for (const target of iterateRelationTargets(relDef, classifyCtx)) {
      // Userset `type#viaRel` pointing at the via entity.
      if (target.kind === "userset" && target.entityType === viaType) {
        baseRelations.add(target.targetRelation);
        continue;
      }
      // Dot-path `baseRel.viaRel` where the base relation targets viaType.
      if (target.kind !== "dotPath") continue;
      const baseRelDef = objectDef.relations[target.source];
      if (!baseRelDef) continue;
      for (const baseTarget of iterateRelationTargets(baseRelDef, classifyCtx)) {
        if (baseTarget.kind === "typed" && baseTarget.entityType === viaType) {
          baseRelations.add(target.target);
          break;
        }
        if (baseTarget.kind === "entity" && baseTarget.entityType === viaType) {
          baseRelations.add(target.target);
          break;
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
    for (const t of resolveRelationInheritance(z, viaType, rel)) {
      expanded.add(t);
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
  const result: string[] = [];
  const seen = new Set<string>();
  for (const { relName, target } of iterateObjectRelationTargets(z, objectType)) {
    if (seen.has(relName)) continue;
    if (
      (target.kind === "typed" || target.kind === "entity") &&
      target.entityType === subjectType
    ) {
      result.push(relName);
      seen.add(relName);
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
  const result: string[] = [];
  for (const { target } of iterateObjectRelationTargets(z, objectType)) {
    if (
      target.kind === "typed" &&
      target.entityType === viaType &&
      target.reverse !== undefined
    ) {
      result.push(target.reverse);
    }
  }
  return result;
}
