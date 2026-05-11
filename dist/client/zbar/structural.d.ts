import type { ZbarInternal } from "../internal";
/** Names of all relations declared on the given entity type. */
export declare function getEntityRelations(z: ZbarInternal, entityType: string): string[];
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
export declare function getViaRelevantRelations(z: ZbarInternal, objectType: string, acceptableRelations: string[], viaType: string): string[];
/**
 * Get relations on objectType whose subject type matches the given type.
 * These are the structural/ownership relations connecting two entity types
 * (e.g. device.owner → system).
 */
export declare function getStructuralRelations(z: ZbarInternal, objectType: string, subjectType: string): string[];
/**
 * Get relations on viaType where objectType entities are subjects.
 * These are the reverse structural relations discovered from
 * `{ type, reverse }` declarations on the objectType entity.
 *
 * Example: device.owner = { type: 'system', reverse: 'device_member' }
 * → for objectType='device', viaType='system' returns ['device_member']
 */
export declare function getReverseStructuralRelations(z: ZbarInternal, objectType: string, viaType: string): string[];
//# sourceMappingURL=structural.d.ts.map