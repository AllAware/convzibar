/* eslint-disable @typescript-eslint/no-empty-object-type */
import type {
  ObjectType as ConvexObjectType,
  PropertyValidators,
} from "convex/values";

// ============================================================================
// Schema shape (as stored/parsed)
// ============================================================================

export type SchemaRelation =
  | string
  | { type: string }
  | { type: string; reverse: string }
  | Array<string | { type: string } | { type: string; reverse: string }>;

export interface EntityDefinition {
  relations?: Record<string, SchemaRelation>;
  permissions?: Record<string, Array<string>>;
  propertyValidators?: Record<string, PropertyValidators>;
  /**
   * Dot-path relations evaluated at read time instead of materialised at
   * write time. See {@link EntityBuilder.readTimeRelation}.
   */
  readTimeRelations?: Array<{ derivedRelation: string; dotPath: string }>;
}

export interface ZbarSchema {
  entities: Record<string, EntityDefinition>;
}

export type BuiltZbarSchema<
  Entities extends Record<
    string,
    { relations: Record<string, string>; permissions: string; properties: Record<string, PropertyValidators> }
  >,
> = {
  entities: {
    [E in keyof Entities]: {
      relations: Record<keyof Entities[E]["relations"] & string, SchemaRelation>;
      permissions: Record<Entities[E]["permissions"] & string, Array<string>>;
      propertyValidators: Entities[E]["properties"];
    };
  };
};

// ============================================================================
// Derived public types
// ============================================================================

export interface SubjectOrObject {
  type: string;
  id: string;
}

export type EntityPermissions<
  Schema extends ZbarSchema,
  ObjectType extends keyof Schema["entities"],
> = Schema["entities"][ObjectType] extends { permissions: infer P }
  ? keyof P & string
  : never;

export type EntityRelations<
  Schema extends ZbarSchema,
  ObjectType extends keyof Schema["entities"],
> = Schema["entities"][ObjectType] extends { relations: infer R }
  ? keyof R & string
  : never;

/**
 * Extract the property validators for a specific relation on an entity type.
 * Returns `never` if the relation has no properties defined.
 */
export type EntityRelationProperties<
  Schema extends ZbarSchema,
  ObjType extends keyof Schema["entities"],
  Relation extends string,
> = Schema["entities"][ObjType] extends { propertyValidators: infer PV }
  ? PV extends Record<string, PropertyValidators>
    ? Relation extends keyof PV
      ? ConvexObjectType<PV[Relation]>
      : never
    : never
  : never;

/**
 * Resolve the inferred property type for a relation.
 * Returns `undefined` when no properties are declared.
 */
export type ResolvedProperties<
  Schema extends ZbarSchema,
  OT extends keyof Schema["entities"] & string,
  Rel extends string,
> = EntityRelationProperties<Schema, OT, Rel> extends never
  ? undefined
  : EntityRelationProperties<Schema, OT, Rel>;

// ============================================================================
// Errors
// ============================================================================

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}
