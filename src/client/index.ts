/* eslint-disable @typescript-eslint/no-empty-object-type */
import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import type {
  GenericValidator,
  ObjectType as ConvexObjectType,
  PropertyValidators,
} from "convex/values";
import { parseSchemaToGraphConfig } from "../component/helpers";

import type { GraphConfig } from "../component/types";

// ============================================================================
// Type Definitions
// ============================================================================

export interface PolicyContext<Data = any> {
  subject: { type: string; id: string };
  resource?: { type: string; id: string };
  action?: string;
  data: Data;
}

export type ConditionFunction<Data = any> = (
  ctx: GenericQueryCtx<GenericDataModel> | GenericActionCtx<GenericDataModel>,
  policyCtx: PolicyContext<Data>,
) => boolean | Partial<Data> | Promise<boolean | Partial<Data>>;

export type SchemaRelation =
  | string
  | { type: string }
  | { type: string; reverse: string }
  | { relation: string; condition: string }
  | Array<string | { type: string } | { type: string; reverse: string } | { relation: string; condition: string }>;

export interface EntityDefinition {
  relations?: Record<string, SchemaRelation>;
  permissions?: Record<
    string,
    Array<string | { relation: string; condition: string }>
  >;
  propertyValidators?: Record<string, PropertyValidators>;
  /**
   * Dot-path relations evaluated at read time instead of materialised at
   * write time. See {@link EntityBuilder.readTimeRelation}.
   */
  readTimeRelations?: Array<{ derivedRelation: string; dotPath: string }>;
}

export interface ZbarSchema<Data = any> {
  conditions?: Record<string, ConditionFunction<Data>>;
  entities: Record<string, EntityDefinition>;
}

export type BuiltZbarSchema<
  Data,
  Conditions extends Record<string, any>,
  Entities extends Record<
    string,
    { relations: Record<string, string>; permissions: string; properties: Record<string, PropertyValidators> }
  >,
> = {
  conditions: Record<keyof Conditions & string, ConditionFunction<Data>>;
  entities: {
    [E in keyof Entities]: {
      relations: Record<
        keyof Entities[E]["relations"] & string,
        SchemaRelation
      >;
      permissions: Record<
        Entities[E]["permissions"] & string,
        Array<string | { relation: string; condition: string }>
      >;
      propertyValidators: Entities[E]["properties"];
    };
  };
};

// ============================================================================
// Fluent Schema Builder
// ============================================================================

// Distributive helper: resolves relation keys for a target type, handling
// self-referential entities (where Target = EntName) by looking up the
// in-progress Relations instead of the not-yet-complete Entities record.
type TargetRelationKeys<
  Target,
  EntName extends string,
  Relations,
  Entities extends Record<string, { relations: Record<string, string>; permissions: string; properties: Record<string, PropertyValidators> }>,
> = Target extends EntName
  ? keyof Relations & string
  : Target extends keyof Entities
    ? keyof Entities[Target]["relations"] & string
    : never;

// Resolves valid relation names on a target entity for reverse edge typing.
// When Target is the entity currently being defined (EntName), uses Relations.
// Otherwise, looks up the target's relations from the already-defined Entities.
type ReverseTargetRelations<
  Target extends string,
  EntName extends string,
  Relations,
  Entities extends Record<string, { relations: Record<string, string>; permissions: string; properties: Record<string, PropertyValidators> }>,
> = Target extends EntName
  ? keyof Relations & string
  : Target extends keyof Entities
    ? keyof Entities[Target]["relations"] & string
    : never;

// Userset path: "entityType#relationName" (e.g. "group#admin").
// Uses # to distinguish from traversal dot-paths ("relation.targetRelation").
// For self-referential entities, we include RelName (the relation currently
// being defined) alongside the already-defined Relations.
type EntityUsersetPath<
  EntName extends string,
  RelName extends string,
  Relations,
  Entities extends Record<string, { relations: Record<string, string>; permissions: string; properties: Record<string, PropertyValidators> }>,
> = {
  [E in (keyof Entities | EntName) & string]: E extends EntName
    ? `${E}#${(keyof Relations | RelName) & string}`
    : `${E}#${keyof Entities[E]["relations"] & string}`;
}[(keyof Entities | EntName) & string];

export class EntityBuilder<
  EntName extends string,
  Conditions extends Record<string, any>,
  Entities extends Record<
    string,
    { relations: Record<string, string>; permissions: string; properties: Record<string, PropertyValidators> }
  >,
  Relations extends Record<string, string> = {},
  Permissions extends string = never,
  Reverses extends Record<string, { relations: Record<string, string>; properties: Record<string, PropertyValidators> }> = {},
  Properties extends Record<string, PropertyValidators> = {},
> {
  declare _relations: Relations;
  declare _permissions: Permissions;
  declare _reverses: Reverses;
  declare _properties: Properties;

  public def: any = { relations: {}, permissions: {}, propertyValidators: {} };

  /**
   * When true, `.relation()` merges new targets into existing relation
   * definitions instead of overwriting them. Set by `SchemaBuilder.extend()`.
   */
  public _mergeMode = false;

  /**
   * Placeholder overload: declares a relation name with no subject type.
   * Used for reverse-edge targets that will be populated by entities
   * defined later in the schema chain.
   *
   * ```ts
   * .entity('system', e => e
   *   .relation('device_member')  // placeholder — populated by device.owner reverse
   * )
   * ```
   */
  relation<RelName extends string>(
    name: RelName,
  ): EntityBuilder<
    EntName,
    Conditions,
    Entities,
    Relations & Record<RelName, string>,
    Permissions,
    Reverses,
    Properties
  >;

  /**
   * Full overload: declares a relation with one or more typed targets.
   */
  relation<
    RelName extends string,
    Target extends (keyof Entities | EntName) & string = (keyof Entities | EntName) & string,
    RTarget extends (keyof Entities | EntName) & string = never,
    RRev extends string = never,
  >(
    name: RelName,
    ...targets: Array<
      | Target
      | keyof Relations
      | {
          [K in keyof Relations &
            string]: `${K}.${TargetRelationKeys<Relations[K], EntName, Relations, Entities>}`;
        }[keyof Relations & string]
      | EntityUsersetPath<EntName, RelName, Relations, Entities>
      | { type: Target }
      | { type: RTarget; reverse: RRev & ReverseTargetRelations<RTarget, EntName, Relations, Entities> }
      | {
          relation:
            | keyof Relations
            | {
                [K in keyof Relations &
                  string]: `${K}.${TargetRelationKeys<Relations[K], EntName, Relations, Entities>}`;
              }[keyof Relations & string]
            | EntityUsersetPath<EntName, RelName, Relations, Entities>;
          condition: keyof Conditions & string;
        }
    >
  ): EntityBuilder<
    EntName,
    Conditions,
    Entities,
    Relations & Record<RelName, Target>,
    Permissions,
    Reverses & ([RRev] extends [never] ? {} : Record<RTarget & string, { relations: Record<RRev & string, EntName>; properties: {} }>),
    Properties
  >;

  // Implementation
  relation(name: string, ...targets: any[]): any {
    if (targets.length === 0) {
      this.def.relations[name] = this.def.relations[name] ?? undefined;
      return this;
    }

    const newValue = targets.length === 1 ? targets[0] : targets;

    // In merge mode (used by .extend()), append new targets to any
    // existing relation definition instead of replacing it.
    const existing = this.def.relations[name];
    if (this._mergeMode && existing != null) {
      const existingArr = Array.isArray(existing) ? existing : [existing];
      const newArr = Array.isArray(newValue) ? newValue : [newValue];
      // Deduplicate: skip targets that are already present (by reference
      // equality for objects, strict equality for strings).
      const merged = [...existingArr];
      for (const t of newArr) {
        const isDuplicate = merged.some((m) =>
          typeof t === "string" && typeof m === "string" ? t === m
          : typeof t === "object" && typeof m === "object" && t !== null && m !== null
            ? JSON.stringify(t) === JSON.stringify(m)
            : false,
        );
        if (!isDuplicate) {
          merged.push(t);
        }
      }
      this.def.relations[name] = merged.length === 1 ? merged[0] : merged;
    } else {
      this.def.relations[name] = newValue;
    }

    return this;
  }

  permission<PermName extends string>(
    name: PermName,
    ...targets: Array<
      | keyof Relations
      | { relation: keyof Relations; condition: keyof Conditions & string }
    >
  ): EntityBuilder<
    EntName,
    Conditions,
    Entities,
    Relations,
    Permissions | PermName,
    Reverses,
    Properties
  > {
    this.def.permissions[name] = targets;
    return this as any;
  }

  /**
   * Define typed properties for a relation using Convex validators.
   *
   * Properties are stored on direct edges and returned by `.listDirect()`.
   * They are validated at write-time by the client before being persisted.
   *
   * ```ts
   * .entity('project', e => e
   *   .relation('editor', 'user')
   *   .properties('editor', {
   *     weight: v.number(),
   *     note: v.optional(v.string()),
   *     since: v.string(),
   *   })
   * )
   * ```
   */
  properties<
    RelName extends keyof Relations & string,
    P extends PropertyValidators,
  >(
    relation: RelName,
    validators: P,
  ): EntityBuilder<
    EntName,
    Conditions,
    Entities,
    Relations,
    Permissions,
    Reverses,
    Properties & Record<RelName, P>
  > {
    this.def.propertyValidators[relation] = validators;
    return this as any;
  }

  /**
   * Declare a dot-path that should be evaluated at **read time** rather than
   * materialised at write time. Unlike regular dot-paths passed to
   * `.relation()` (which fan out across the entire subject population and
   * write one effective edge per pair), read-time paths produce **no**
   * traversal rules. `can()` and `list()` evaluate them on demand using 2–3
   * indexed queries.
   *
   * Use this for relationships that would be prohibitively expensive to
   * materialise — e.g. paths that traverse high-fan-out memberships — while
   * still keeping the permission model concise.
   *
   * The `derivedRelation` must already exist on the current entity (declared
   * via `.relation()`). The results of the read-time path are **unioned**
   * with any materialised results when evaluating `can()` / `list()`.
   *
   * ```ts
   * .entity('contact', e => e
   *   .relation('viewer', 'user', 'admin')
   *   .readTimeRelation('viewer', 'owner.user_member')
   * )
   * ```
   */
  readTimeRelation(
    derivedRelation: keyof Relations & string,
    ...dotPaths: string[]
  ): this {
    for (const path of dotPaths) {
      if (!path.includes(".")) {
        throw new Error(
          `Zbar Schema Error: readTimeRelation requires a dot-path (got '${path}').`,
        );
      }
      this.def.readTimeRelations = this.def.readTimeRelations ?? [];
      this.def.readTimeRelations.push({ derivedRelation, dotPath: path });
    }
    return this;
  }
}

export class SchemaBuilder<
  Data,
  Conditions extends Record<string, any> = {},
  Entities extends Record<
    string,
    { relations: Record<string, string>; permissions: string; properties: Record<string, PropertyValidators> }
  > = {},
> {
  public _schema: any = { conditions: {}, entities: {} };

  condition<Name extends string>(
    name: Name,
    fn: ConditionFunction<Data>,
  ): SchemaBuilder<Data, Conditions & Record<Name, true>, Entities> {
    this._schema.conditions[name] = fn;
    return this as any;
  }

  entity<
    Name extends string,
    Rel extends Record<string, string> = {},
    Perm extends string = never,
    Rev extends Record<string, { relations: Record<string, string>; properties: Record<string, PropertyValidators> }> = {},
    Props extends Record<string, PropertyValidators> = {},
  >(
    name: Name,
    build?: (
      e: EntityBuilder<Name, Conditions, Entities, {}, never, {}, {}>,
    ) => EntityBuilder<Name, Conditions, Entities, Rel, Perm, Rev, Props>,
  ): SchemaBuilder<
    Data,
    Conditions,
    Entities & Record<Name, { relations: Rel; permissions: Perm; properties: Props }> & Rev
  > {
    if (build) {
      const e = build(new EntityBuilder());
      this._schema.entities[name] = e.def;
    } else {
      this._schema.entities[name] = { relations: {}, permissions: {} };
    }
    return this as any;
  }

  /**
   * Extend an already-defined entity with additional relations and/or permissions.
   *
   * Use this to add forward references that depend on entities defined later
   * in the schema chain. By the time `.extend()` is called, those entities
   * (and their relations) are visible to the type system.
   *
   * ```ts
   * createZbarSchema()
   *   .entity('system', e => e
   *     .relation('has_group')           // placeholder
   *     .relation('owner', 'user')
   *   )
   *   .entity('group', e => e
   *     .relation('owner', { type: 'system', reverse: 'has_group' })
   *     .relation('device_member')
   *   )
   *   // Now group.device_member exists — wire up the forward reference:
   *   .extend('system', e => e
   *     .relation('device_member', 'has_group.device_member')
   *   )
   *   .build()
   * ```
   */
  extend<
    Name extends keyof Entities & string,
    NewRel extends Record<string, string> = {},
    NewPerm extends string = never,
    Rev extends Record<string, { relations: Record<string, string>; properties: Record<string, PropertyValidators> }> = {},
    NewProps extends Record<string, PropertyValidators> = {},
  >(
    name: Name,
    build: (
      e: EntityBuilder<Name, Conditions, Entities, Entities[Name]["relations"], Entities[Name]["permissions"], {}, Entities[Name]["properties"]>,
    ) => EntityBuilder<Name, Conditions, Entities, Entities[Name]["relations"] & NewRel, Entities[Name]["permissions"] | NewPerm, Rev, Entities[Name]["properties"] & NewProps>,
  ): SchemaBuilder<
    Data,
    Conditions,
    Omit<Entities, Name> & Record<Name, { relations: Entities[Name]["relations"] & NewRel; permissions: Entities[Name]["permissions"] | NewPerm; properties: Entities[Name]["properties"] & NewProps }> & Rev
  > {
    const existing = this._schema.entities[name];
    if (!existing) {
      throw new Error(
        `Zbar Schema Error: Cannot extend entity '${name}' — it has not been defined yet. Call .entity('${name}', ...) first.`,
      );
    }

    // Seed a new EntityBuilder with the existing definition so the callback
    // can reference already-declared relations in dot-paths / permissions.
    // Enable merge mode so that .relation() appends to existing definitions
    // instead of overwriting them.
    const builder = new EntityBuilder();
    builder.def = {
      relations: { ...existing.relations },
      permissions: { ...existing.permissions },
      propertyValidators: { ...existing.propertyValidators },
      ...(existing.readTimeRelations
        ? { readTimeRelations: [...existing.readTimeRelations] }
        : {}),
    };
    builder._mergeMode = true;

    const result = build(builder as any);

    // Merge the (potentially new) relations and permissions back.
    this._schema.entities[name] = result.def;
    return this as any;
  }

  build(): BuiltZbarSchema<Data, Conditions, Entities> {
    const entities = this._schema.entities as Record<string, any>;

    // ── Pass 1: Collect all reverse edge declarations ──
    // reverseMap[targetEntity][reverseRelName] = { sourceEntity, via relation on targetEntity }
    const reverseMap: Record<
      string,
      Record<string, { subjectType: string; relName: string }>
    > = {};

    for (const [entityType, entityDef] of Object.entries(entities)) {
      const relations = entityDef.relations || {};
      for (const [relName, relDef] of Object.entries(relations)) {
        const defs = Array.isArray(relDef) ? relDef : [relDef];
        for (const d of defs) {
          if (
            typeof d === "object" &&
            d !== null &&
            "type" in d &&
            "reverse" in d &&
            (d as any).reverse
          ) {
            const targetEntityName = (d as any).type as string;
            const reverseRelName = (d as any).reverse as string;
            if (!entities[targetEntityName]) continue;

            reverseMap[targetEntityName] = reverseMap[targetEntityName] || {};
            reverseMap[targetEntityName][reverseRelName] = {
              subjectType: entityType,
              relName,
            };
          }
        }
      }
    }

    return this._schema;
  }
}

export function createZbarSchema<Data = any>() {
  return new SchemaBuilder<Data>();
}

// ============================================================================
// Context Types
// ============================================================================

type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runMutation">;
type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction"
>;

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

export type SchemaConditions<Schema extends ZbarSchema<any>> = Schema extends {
  conditions: infer C;
}
  ? keyof C & string
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
type ResolvedProperties<
  Schema extends ZbarSchema,
  OT extends keyof Schema["entities"] & string,
  Rel extends string,
> = EntityRelationProperties<Schema, OT, Rel> extends never
  ? undefined
  : EntityRelationProperties<Schema, OT, Rel>;

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

// ============================================================================
// Fluent List Query Builder
// ============================================================================

/**
 * Entry point returned by `zbar.list()`. Call `.object()` to begin building
 * a list query.
 *
 * - `.object("device")` — list **objects** of that type (subject will need `{type, id}`)
 * - `.object({ type: "device", id })` — list **subjects** that relate to that object (subject will need just a type string)
 */
export interface ListInitial<
  Schema extends ZbarSchema<Data>,
  Data,
> {
  object<OT extends keyof Schema["entities"] & string>(
    objectType: OT,
  ): ListWithObjectType<Schema, Data, OT>;
  object<OT extends keyof Schema["entities"] & string>(
    object: { type: OT; id: string },
  ): ListWithObjectInstance<Schema, Data, OT>;
}

/** After `.object(type)` — listing objects. Pick a relation or permission. */
export interface ListWithObjectType<
  Schema extends ZbarSchema<Data>,
  Data,
  OT extends keyof Schema["entities"] & string,
> {
  relation<R extends EntityRelations<Schema, OT>>(
    relation: R,
  ): ListObjectsNeedSubject<Schema, Data>;
  permission<P extends EntityPermissions<Schema, OT>>(
    permission: P,
  ): ListObjectsNeedSubject<Schema, Data>;
}

/** After `.object({type, id})` — listing subjects. Pick a relation or permission. */
export interface ListWithObjectInstance<
  Schema extends ZbarSchema<Data>,
  Data,
  OT extends keyof Schema["entities"] & string,
> {
  relation<R extends EntityRelations<Schema, OT>>(
    relation: R,
  ): ListSubjectsNeedSubject<Schema, Data>;
  permission<P extends EntityPermissions<Schema, OT>>(
    permission: P,
  ): ListSubjectsNeedSubject<Schema, Data>;
}

/** Listing objects — subject must be a full `{type, id}` pair. */
export interface ListObjectsNeedSubject<
  Schema extends ZbarSchema<Data>,
  Data,
> {
  subject<ST extends keyof Schema["entities"] & string>(
    subject: { type: ST; id: string },
  ): ListCollectable<Schema, Data, { objectId: string }>;
}

/** Listing subjects — subject is just a type string. */
export interface ListSubjectsNeedSubject<
  Schema extends ZbarSchema<Data>,
  Data,
> {
  subject<ST extends keyof Schema["entities"] & string>(
    subjectType: ST,
  ): ListCollectable<Schema, Data, { subjectId: string }>;
}

/** Ready to collect, with optional `.via()` filtering and `.map()`. */
export interface ListCollectable<
  Schema extends ZbarSchema<Data>,
  Data,
  Result,
> {
  via<VT extends keyof Schema["entities"] & string>(
    ...entities: Array<{ type: VT; id: string } | null | undefined>
  ): ListFinal<Data, Result>;
  map<T>(
    fn: (item: Result) => T | Promise<T>,
  ): ListMapped<Data, T>;
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<Result[]>;
}

/** After `.via()` — can `.map()` or `.collect()`. */
export interface ListFinal<Data, Result> {
  map<T>(
    fn: (item: Result) => T | Promise<T>,
  ): ListMapped<Data, T>;
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<Result[]>;
}

/** After `.map()` — terminal, can only `.collect()`. */
export interface ListMapped<Data, T> {
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<T[]>;
}

// ============================================================================
// Fluent Direct Relationship Query Builder
// ============================================================================

/** Result row from a direct relationship query. */
export interface DirectRelationship {
  subject: { type: string; id: string };
  relation: string;
  object: { type: string; id: string };
  properties?: unknown;
}

/**
 * Entry point returned by `zbar.listDirect()`. Provide `.object()`,
 * `.subject()`, or both to scope the query.
 *
 * - `.object("device")` — all direct relationships where the object type is "device"
 * - `.object({ type: "device", id })` — all direct relationships for that specific object
 * - `.subject("user")` — all direct relationships where the subject type is "user"
 * - `.subject({ type: "user", id })` — all direct relationships for that specific subject
 *
 * At least one of `.object()` or `.subject()` must be called before `.collect()`.
 */
export interface ListDirectInitial<
  Schema extends ZbarSchema<Data>,
  Data,
> {
  object<OT extends keyof Schema["entities"] & string>(
    objectType: OT,
  ): ListDirectWithObjectType<Schema, Data, OT>;
  object<OT extends keyof Schema["entities"] & string>(
    object: { type: OT; id: string },
  ): ListDirectWithObjectInstance<Schema, Data, OT>;
  subject<ST extends keyof Schema["entities"] & string>(
    subjectType: ST,
  ): ListDirectSubjectOnly<Schema, Data>;
  subject<ST extends keyof Schema["entities"] & string>(
    subject: { type: ST; id: string },
  ): ListDirectSubjectOnly<Schema, Data>;
}

/** After `.object(type)` — can add `.subject()`, `.relation()`, `.permission()`, `.map()`, or `.collect()`. */
export interface ListDirectWithObjectType<
  Schema extends ZbarSchema<Data>,
  Data,
  OT extends keyof Schema["entities"] & string,
> {
  subject<ST extends keyof Schema["entities"] & string>(
    subjectType: ST,
  ): ListDirectCollectable<Schema, Data, OT>;
  subject<ST extends keyof Schema["entities"] & string>(
    subject: { type: ST; id: string },
  ): ListDirectCollectable<Schema, Data, OT>;
  relation<R extends EntityRelations<Schema, OT>>(
    relation: R,
  ): ListDirectObjectFiltered<Schema, Data, OT>;
  permission<P extends EntityPermissions<Schema, OT>>(
    permission: P,
  ): ListDirectObjectFiltered<Schema, Data, OT>;
  map<T>(
    fn: (item: DirectRelationship) => T | Promise<T>,
  ): ListDirectMapped<Data, T>;
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<DirectRelationship[]>;
}

/** After `.object({type, id})` — can add `.subject()`, `.relation()`, `.permission()`, `.map()`, or `.collect()`. */
export interface ListDirectWithObjectInstance<
  Schema extends ZbarSchema<Data>,
  Data,
  OT extends keyof Schema["entities"] & string,
> {
  subject<ST extends keyof Schema["entities"] & string>(
    subjectType: ST,
  ): ListDirectCollectable<Schema, Data, OT>;
  subject<ST extends keyof Schema["entities"] & string>(
    subject: { type: ST; id: string },
  ): ListDirectCollectable<Schema, Data, OT>;
  relation<R extends EntityRelations<Schema, OT>>(
    relation: R,
  ): ListDirectObjectFiltered<Schema, Data, OT>;
  permission<P extends EntityPermissions<Schema, OT>>(
    permission: P,
  ): ListDirectObjectFiltered<Schema, Data, OT>;
  map<T>(
    fn: (item: DirectRelationship) => T | Promise<T>,
  ): ListDirectMapped<Data, T>;
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<DirectRelationship[]>;
}

/** After `.object()` + `.relation()`/`.permission()` — can add `.subject()`, `.map()`, or `.collect()`. */
export interface ListDirectObjectFiltered<
  Schema extends ZbarSchema<Data>,
  Data,
  OT extends keyof Schema["entities"] & string,
> {
  subject<ST extends keyof Schema["entities"] & string>(
    subjectType: ST,
  ): ListDirectCollectable<Schema, Data, OT>;
  subject<ST extends keyof Schema["entities"] & string>(
    subject: { type: ST; id: string },
  ): ListDirectCollectable<Schema, Data, OT>;
  map<T>(
    fn: (item: DirectRelationship) => T | Promise<T>,
  ): ListDirectMapped<Data, T>;
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<DirectRelationship[]>;
}

/** After `.subject()` only (no object yet) — can add `.object()`, `.map()`, or `.collect()`. */
export interface ListDirectSubjectOnly<
  Schema extends ZbarSchema<Data>,
  Data,
> {
  object<OT extends keyof Schema["entities"] & string>(
    objectType: OT,
  ): ListDirectCollectable<Schema, Data, OT>;
  object<OT extends keyof Schema["entities"] & string>(
    object: { type: OT; id: string },
  ): ListDirectCollectable<Schema, Data, OT>;
  map<T>(
    fn: (item: DirectRelationship) => T | Promise<T>,
  ): ListDirectMapped<Data, T>;
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<DirectRelationship[]>;
}

/** Can add `.relation()`/`.permission()`, `.map()`, or `.collect()`. */
export interface ListDirectCollectable<
  Schema extends ZbarSchema<Data>,
  Data,
  OT extends keyof Schema["entities"] & string,
> {
  relation<R extends EntityRelations<Schema, OT>>(
    relation: R,
  ): ListDirectFinal<Data>;
  permission<P extends EntityPermissions<Schema, OT>>(
    permission: P,
  ): ListDirectFinal<Data>;
  map<T>(
    fn: (item: DirectRelationship) => T | Promise<T>,
  ): ListDirectMapped<Data, T>;
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<DirectRelationship[]>;
}

/** After `.relation()`/`.permission()` — can `.map()` or `.collect()`. */
export interface ListDirectFinal<Data> {
  map<T>(
    fn: (item: DirectRelationship) => T | Promise<T>,
  ): ListDirectMapped<Data, T>;
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<DirectRelationship[]>;
}

/** After `.map()` — terminal, can only `.collect()`. */
export interface ListDirectMapped<Data, T> {
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<T[]>;
}

/**
 * Internal implementation of the fluent direct-relationship query builder.
 */
class ListDirectQueryBuilder<Schema extends ZbarSchema<Data>, Data> {
  private _objectType?: string;
  private _objectId?: string;
  private _subjectType?: string;
  private _subjectId?: string;
  private _relation?: string;
  private _permission?: string;
  private _mapFn?: (item: any) => any;

  constructor(private zbar: Zbar<Schema, Data>) {}

  object(objectOrType: string | { type: string; id: string }): this {
    if (typeof objectOrType === "string") {
      this._objectType = objectOrType;
    } else {
      this._objectType = objectOrType.type;
      this._objectId = objectOrType.id;
    }
    return this;
  }

  subject(subjectOrType: string | { type: string; id: string }): this {
    if (typeof subjectOrType === "string") {
      this._subjectType = subjectOrType;
    } else {
      this._subjectType = subjectOrType.type;
      this._subjectId = subjectOrType.id;
    }
    return this;
  }

  relation(relation: string): this {
    this._relation = relation;
    return this;
  }

  permission(permission: string): this {
    this._permission = permission;
    return this;
  }

  map(fn: (item: any) => any): this {
    this._mapFn = fn;
    return this;
  }

  async collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<DirectRelationship[]> {
    const z = this.zbar as any;
    const objectType = this._objectType;

    // 1. Determine which relations to filter for.
    let filterRelations: string[] | undefined;

    if (this._permission && objectType) {
      // Permission → expand to all relations that satisfy it (including inherited).
      const targets = z.resolvePermissionRelations(objectType, this._permission);
      filterRelations = targets.map((t: any) => t.relation);
    } else if (this._relation && objectType) {
      // Relation → expand with inheritance.
      const targets = z.resolveRelationInheritance(objectType, this._relation);
      filterRelations = targets.map((t: any) => t.relation);
    }

    // 2. Build the query args.
    const subjectArg =
      this._subjectType && this._subjectId
        ? { type: this._subjectType, id: this._subjectId }
        : undefined;
    const objectArg =
      this._objectType && this._objectId
        ? { type: this._objectType, id: this._objectId }
        : undefined;

    // 3. Query base relationships from the component.
    // Pass type-only filters server-side to minimise data transfer
    // and leverage deeper index prefixes where possible.
    const rows: any[] = await ctx.runQuery(
      z.component.queries.listDirectRelationships,
      {
        tenantId: z.options.tenantId,
        subject: subjectArg,
        object: objectArg,
        relations: filterRelations,
        filterSubjectType:
          this._subjectType && !this._subjectId
            ? this._subjectType
            : undefined,
        filterObjectType:
          this._objectType && !this._objectId
            ? this._objectType
            : undefined,
      },
    );

    // Server now handles type-only filtering; no client-side pass needed.
    const filtered = rows;

    // 5. Map to result shape.
    const results = filtered.map((r: any) => ({
      subject: { type: r.subjectType, id: r.subjectId },
      relation: r.relation,
      object: { type: r.objectType, id: r.objectId },
      properties: r.properties,
    }));

    // 6. Apply user-provided mapper in parallel if present.
    if (this._mapFn) {
      return Promise.all(results.map(this._mapFn));
    }

    return results;
  }
}

// ============================================================================
// Fluent List Query Builder (effective relationships)
// ============================================================================

/**
 * Internal implementation of the fluent list query builder.
 * A single class implements all builder interfaces; the TypeScript interfaces
 * above restrict which methods are visible at each step.
 */
class ListQueryBuilder<Schema extends ZbarSchema<Data>, Data> {
  private _objectType!: string;
  private _objectId?: string;
  private _subjectType?: string;
  private _subjectId?: string;
  private _relation?: string;
  private _permission?: string;
  private _via: Array<{ type: string; id: string }> = [];
  private _mode!: "listObjects" | "listSubjects";
  private _mapFn?: (item: any) => any;

  constructor(private zbar: Zbar<Schema, Data>) {}

  object(objectOrType: string | { type: string; id: string }): this {
    if (typeof objectOrType === "string") {
      this._objectType = objectOrType;
      this._mode = "listObjects";
    } else {
      this._objectType = objectOrType.type;
      this._objectId = objectOrType.id;
      this._mode = "listSubjects";
    }
    return this;
  }

  relation(relation: string): this {
    this._relation = relation;
    return this;
  }

  permission(permission: string): this {
    this._permission = permission;
    return this;
  }

  subject(subjectOrType: string | { type: string; id: string }): this {
    if (typeof subjectOrType === "string") {
      this._subjectType = subjectOrType;
    } else {
      this._subjectType = subjectOrType.type;
      this._subjectId = subjectOrType.id;
    }
    return this;
  }

  via(...entities: Array<{ type: string; id: string } | null | undefined>): this {
    this._via = entities.filter(
      (e): e is { type: string; id: string } =>
        e != null && typeof e.type === "string" && typeof e.id === "string",
    );
    return this;
  }

  map(fn: (item: any) => any): this {
    this._mapFn = fn;
    return this;
  }

  private _finalize(results: any[]): Promise<any[]> {
    if (this._mapFn) {
      return Promise.all(results.map(this._mapFn));
    }
    return Promise.resolve(results);
  }

  async collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<Array<{ objectId: string } | { subjectId: string }>> {
    // Access Zbar internals — the builder is a tightly-coupled implementation
    // detail defined in the same file, so this cast is intentional.
    const z = this.zbar as any;
    const isPermission = this._permission != null;
    const relOrPerm = (this._relation ?? this._permission)!;

    // 1. Resolve which effective relations to query for
    const targets: Array<{ relation: string; condition?: string }> = isPermission
      ? z.resolvePermissionRelations(this._objectType, relOrPerm)
      : z.resolveRelationInheritance(this._objectType, relOrPerm);

    if (targets.length === 0) return [];
    const acceptableRelations = targets.map((t: any) => t.relation);
    const hasVia = this._via.length > 0;

    // Detect whether any conditions exist in the schema.  When there
    // are none we can skip the per-candidate permission verification
    // entirely in the via path because write-time materialisation
    // guarantees transitivity (subject→via + via→object ⇒ subject→object).
    const schemaHasConditions =
      Object.keys(z.options.schema.conditions || {}).length > 0;

    if (this._mode === "listObjects") {
      const subject = { type: this._subjectType!, id: this._subjectId! };
      const objectType = this._objectType;

      if (hasVia) {
        // ── Chained gate-check + expand ───────────────────────────
        // Chain: subject → via[0] → via[1] → … → via[N-1] → objects
        //
        // 1. Gate: subject → via[0] using permission-relevant
        //    relations (derived from userset rewrites).
        // 2. Chain links: via[i] → via[i+1] connectivity checks.
        // 3. Expand: via[N-1] → objects (the only range scan).
        //
        // All queries fire in parallel; any failure → return [].

        const viaChain = this._via;
        const firstVia = viaChain[0];
        const lastVia = viaChain[viaChain.length - 1];

        // Tight gate relations: only the relations on firstVia's type
        // that are referenced by userset rewrites in the acceptable
        // relations (e.g. device.admin ← system#admin → "admin" on system).
        const tightGateRelations = z.getViaRelevantRelations(
          objectType,
          acceptableRelations,
          firstVia.type,
        );
        const gateRelations =
          tightGateRelations.length > 0
            ? tightGateRelations
            : z.getEntityRelations(firstVia.type);
        const isTightGate = tightGateRelations.length > 0;

        // — Fire gate + chain + expand in parallel —
        // Gate and chain go through `hasAccessOrRT` so they compose with
        // `.readTimeRelation()` declarations on the via entities. Expand
        // stays materialised-only: it reads structural schema relations
        // (e.g. contact.owner, system#contact_member) which are not RT-able.

        const gatePromise: Promise<boolean> = z.hasAccessOrRT(
          ctx,
          subject,
          gateRelations,
          firstVia,
        );

        const chainPromises: Array<Promise<boolean>> = [];
        for (let i = 0; i < viaChain.length - 1; i++) {
          const next = viaChain[i + 1];
          chainPromises.push(
            z.hasAccessOrRT(
              ctx,
              viaChain[i],
              z.getEntityRelations(next.type),
              next,
            ),
          );
        }

        // Expand: via[N-1] → objects.
        // Use structural relations (e.g. device.owner → system) when the
        // via entity connects to the object type via a typed relation,
        // otherwise fall back to acceptable (permission-derived) relations.
        //
        // Two directions must be checked:
        //   Forward: via entity is the subject (e.g. device#owner@system)
        //   Reverse: via entity is the object (e.g. system#device_member has
        //            device as subject — used for transitive membership like
        //            system.device_member = has_group.device_member)
        const structuralExpandRels = z.getStructuralRelations(
          objectType,
          lastVia.type,
        );
        const reverseStructuralRels = z.getReverseStructuralRelations(
          objectType,
          lastVia.type,
        );
        const hasStructural =
          structuralExpandRels.length > 0 || reverseStructuralRels.length > 0;

        const expandPromises: Array<Promise<any>> = [];
        if (hasStructural) {
          if (structuralExpandRels.length > 0) {
            expandPromises.push(
              ctx.runQuery(z.component.queries.listAccessibleObjectsFast, {
                tenantId: z.options.tenantId,
                subject: lastVia,
                relations: structuralExpandRels,
                objectType,
              }),
            );
          }
          if (reverseStructuralRels.length > 0) {
            expandPromises.push(
              ctx.runQuery(z.component.queries.listSubjectsWithAccessFast, {
                tenantId: z.options.tenantId,
                object: lastVia,
                relations: reverseStructuralRels,
                subjectType: objectType,
              }),
            );
          }
        } else {
          expandPromises.push(
            ctx.runQuery(z.component.queries.listAccessibleObjectsFast, {
              tenantId: z.options.tenantId,
              subject: lastVia,
              relations: acceptableRelations,
              objectType,
            }),
          );
        }

        const [gatePassed, chainPassed, expandResults] = await Promise.all([
          gatePromise,
          Promise.all(chainPromises),
          Promise.all(expandPromises),
        ]);

        if (!gatePassed) return [];
        for (const hit of chainPassed) {
          if (!hit) return [];
        }

        // Collect expand results — may come from multiple expand queries
        // (forward structural + reverse structural)
        const candidateIds = new Set<string>();
        let expandIdx = 0;

        if (hasStructural) {
          if (structuralExpandRels.length > 0) {
            // Forward: via is subject, objects are the candidates
            const fwdRows = expandResults[expandIdx] as any[];
            for (const eff of fwdRows) {
              candidateIds.add(eff.objectKey.split(":")[1]);
            }
            expandIdx++;
          }
          if (reverseStructuralRels.length > 0) {
            // Reverse: objects are subjects, via is the object
            const revRows = expandResults[expandIdx] as any[];
            for (const eff of revRows) {
              candidateIds.add(eff.subjectKey.split(":")[1]);
            }
            expandIdx++;
          }
        } else {
          const fallbackRows = expandResults[expandIdx] as any[];
          for (const eff of fallbackRows) {
            candidateIds.add(eff.objectKey.split(":")[1]);
          }
        }
        if (candidateIds.size === 0) return [];

        // Fast path: tight gate + no conditions → materialisation
        // guarantees subject→object, return IDs directly.
        if (!schemaHasConditions && isTightGate) {
          return this._finalize(
            [...candidateIds].map((id) => ({ objectId: id })),
          );
        }

        // Slow path: batch-verify + validate conditions
        const effectiveRels = await ctx.runQuery(
          z.component.queries.checkPermissionBatchObjects,
          {
            tenantId: z.options.tenantId,
            subject,
            relations: acceptableRelations,
            objectType,
            candidateObjectIds: [...candidateIds],
          },
        );

        const validated = await z.listWithValidation(
          ctx,
          effectiveRels,
          targets,
          (eff: any) => eff.objectKey.split(":")[1],
          () => subject,
          (_: any, id: string) => ({ type: objectType, id }),
          relOrPerm,
          requestContext,
        );

        // RT fallback: the candidate set was scoped by `.via()`, so every
        // candidate already connects to the via entity. Any candidate
        // that materialisation didn't validate gets a read-time check
        // in parallel.
        if (z.graphConfig.readTimePaths) {
          const matIds = new Set(validated.map((r: any) => r.id));
          const pending = [...candidateIds].filter((id) => !matIds.has(id));
          if (pending.length > 0) {
            const rtHits = await Promise.all(
              pending.map((id) =>
                z
                  .evaluateReadTimePaths(
                    ctx,
                    subject,
                    { type: objectType, id },
                    acceptableRelations,
                  )
                  .then((hit: boolean) => (hit ? id : null)),
              ),
            );
            for (const id of rtHits) {
              if (id !== null) validated.push({ id });
            }
          }
        }

        return this._finalize(
          validated.map((r: any) => ({ objectId: r.id })),
        );
      }

      // ── No via: standard full-scan path ───────────────────────────
      const effectiveRels = await ctx.runQuery(
        z.component.queries.listAccessibleObjectsFast,
        {
          tenantId: z.options.tenantId,
          subject,
          relations: acceptableRelations,
          objectType,
        },
      );

      const validated = await z.listWithValidation(
        ctx,
        effectiveRels,
        targets,
        (eff: any) => eff.objectKey.split(":")[1],
        () => subject,
        (_: any, id: string) => ({ type: objectType, id }),
        relOrPerm,
        requestContext,
      );

      // Union read-time path matches — these are not in the materialised
      // graph by design. Deduplicate against validated IDs.
      const readTimeIds = await z.listReadTimeObjects(
        ctx,
        subject,
        objectType,
        acceptableRelations,
      );
      if (readTimeIds.length > 0) {
        const seen = new Set(validated.map((r: any) => r.id));
        for (const id of readTimeIds) {
          if (!seen.has(id)) {
            seen.add(id);
            validated.push({ id });
          }
        }
      }

      return this._finalize(
        validated.map((r: any) => ({ objectId: r.id })),
      );
    } else {
      // listSubjects mode
      const object = { type: this._objectType, id: this._objectId! };
      const subjectType = this._subjectType!;

      if (hasVia) {
        // ── Chained gate-check + expand (subjects) ───────────────
        // Chain: subjects → via[0] → … → via[N-1] → object
        //
        // 1. Gate: via[N-1] → object using acceptable relations.
        // 2. Chain links: via[i] → via[i+1] connectivity checks.
        // 3. Expand: via[0] ← subjects (range scan for subject type).

        const viaChain = this._via;
        const firstVia = viaChain[0];
        const lastVia = viaChain[viaChain.length - 1];

        // Tight expand: only relations on firstVia's type that are
        // referenced by the object type's userset rewrites.
        const tightExpandRelations = z.getViaRelevantRelations(
          this._objectType,
          acceptableRelations,
          firstVia.type,
        );
        const expandRelations =
          tightExpandRelations.length > 0
            ? tightExpandRelations
            : z.getEntityRelations(firstVia.type);
        const isTightExpand = tightExpandRelations.length > 0;

        // Gate: via[N-1] → object.
        // Check connectivity between the via entity and the object.
        // Must check both directions:
        //   Forward: via is subject of a relation on objectType
        //   Reverse: objectType is subject of a relation on viaType
        // Structural gates are always materialised (they read schema-declared
        // typed relations); the fallback branch uses permission relations
        // and so gets RT fallback via `hasAccessOrRT`.
        const structuralGateRels = z.getStructuralRelations(
          this._objectType,
          lastVia.type,
        );
        const reverseGateRels = z.getReverseStructuralRelations(
          this._objectType,
          lastVia.type,
        );
        const hasStructuralGate =
          structuralGateRels.length > 0 || reverseGateRels.length > 0;

        const gatePromise: Promise<boolean> = (async () => {
          if (hasStructuralGate) {
            const gatePromises: Array<Promise<any[]>> = [];
            if (structuralGateRels.length > 0) {
              gatePromises.push(
                ctx.runQuery(z.component.queries.checkPermissionFast, {
                  tenantId: z.options.tenantId,
                  subject: lastVia,
                  relations: structuralGateRels,
                  object,
                }),
              );
            }
            if (reverseGateRels.length > 0) {
              gatePromises.push(
                ctx.runQuery(z.component.queries.checkPermissionFast, {
                  tenantId: z.options.tenantId,
                  subject: object,
                  relations: reverseGateRels,
                  object: lastVia,
                }),
              );
            }
            const gateResults = await Promise.all(gatePromises);
            return gateResults.some((rs) => rs.length > 0);
          }
          return z.hasAccessOrRT(ctx, lastVia, acceptableRelations, object);
        })();

        // Chain links: via[i] → via[i+1]. Permission-like — gets RT fallback.
        const chainPromises: Array<Promise<boolean>> = [];
        for (let i = 0; i < viaChain.length - 1; i++) {
          const next = viaChain[i + 1];
          chainPromises.push(
            z.hasAccessOrRT(
              ctx,
              viaChain[i],
              z.getEntityRelations(next.type),
              next,
            ),
          );
        }

        // Expand: via[0] ← subjects (using tight relations). Materialised.
        const expandPromise: Promise<any[]> = ctx.runQuery(
          z.component.queries.listSubjectsWithAccessFast,
          {
            tenantId: z.options.tenantId,
            object: firstVia,
            relations: expandRelations,
            subjectType,
          },
        );

        const [gatePassed, chainPassed, expandRows] = await Promise.all([
          gatePromise,
          Promise.all(chainPromises),
          expandPromise,
        ]);

        if (!gatePassed) return [];
        for (const hit of chainPassed) {
          if (!hit) return [];
        }

        const candidateIds = new Set<string>();
        for (const eff of expandRows) {
          candidateIds.add(eff.subjectKey.split(":")[1]);
        }
        if (candidateIds.size === 0) return [];

        // Fast path: tight expand + no conditions
        if (!schemaHasConditions && isTightExpand) {
          return this._finalize(
            [...candidateIds].map((id) => ({ subjectId: id })),
          );
        }

        // Slow path
        const effectiveRels = await ctx.runQuery(
          z.component.queries.checkPermissionBatchSubjects,
          {
            tenantId: z.options.tenantId,
            object,
            relations: acceptableRelations,
            subjectType,
            candidateSubjectIds: [...candidateIds],
          },
        );

        const validated = await z.listWithValidation(
          ctx,
          effectiveRels,
          targets,
          (eff: any) => eff.subjectKey.split(":")[1],
          (eff: any, id: string) => ({
            type: eff.subjectKey.split(":")[0],
            id,
          }),
          () => object,
          relOrPerm,
          requestContext,
        );

        // RT fallback for the listSubjects slow path — mirrors the
        // listObjects branch. Each unvalidated candidate is probed via RT
        // against the concrete object, in parallel.
        if (z.graphConfig.readTimePaths) {
          const matIds = new Set(validated.map((r: any) => r.id));
          const pending = [...candidateIds].filter((id) => !matIds.has(id));
          if (pending.length > 0) {
            const rtHits = await Promise.all(
              pending.map((id) =>
                z
                  .evaluateReadTimePaths(
                    ctx,
                    { type: subjectType, id },
                    object,
                    acceptableRelations,
                  )
                  .then((hit: boolean) => (hit ? id : null)),
              ),
            );
            for (const id of rtHits) {
              if (id !== null) validated.push({ id });
            }
          }
        }

        return this._finalize(
          validated.map((r: any) => ({ subjectId: r.id })),
        );
      }

      // ── No via: standard full-scan path ───────────────────────────
      const effectiveRels = await ctx.runQuery(
        z.component.queries.listSubjectsWithAccessFast,
        {
          tenantId: z.options.tenantId,
          object,
          relations: acceptableRelations,
          subjectType,
        },
      );

      const validated = await z.listWithValidation(
        ctx,
        effectiveRels,
        targets,
        (eff: any) => eff.subjectKey.split(":")[1],
        (eff: any, id: string) => ({ type: eff.subjectKey.split(":")[0], id }),
        () => object,
        relOrPerm,
        requestContext,
      );

      const readTimeIds = await z.listReadTimeSubjects(
        ctx,
        object,
        subjectType,
        acceptableRelations,
      );
      if (readTimeIds.length > 0) {
        const seen = new Set(validated.map((r: any) => r.id));
        for (const id of readTimeIds) {
          if (!seen.has(id)) {
            seen.add(id);
            validated.push({ id });
          }
        }
      }

      return this._finalize(
        validated.map((r: any) => ({ subjectId: r.id })),
      );
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new Zbar client instance.
 * @param component The imported convzibar component
 * @param options Configuration options
 * @returns Zbar client
 */
export function createZbar<Schema extends ZbarSchema<Data>, Data = any>(
  component: any,
  options: {
    schema: Schema;
    tenantId: string;
    defaultActorId?: string;
    enableAuditLog?: boolean;
    maxWriteDepth?: number;
    asyncWrites?: boolean;
    /**
     * Maximum recursion depth for chained read-time-relation evaluation.
     *
     * When evaluating a `readTimeRelation(derived, 'source.target')`, step 2
     * checks whether the subject has `target` access on the source entity.
     * If that materialised check misses, the evaluator recursively walks
     * further read-time paths on the source entity, up to this depth.
     *
     * A higher value enables RT paths to chain through multiple layers
     * (e.g. `notification_rule.viewer` → `contact.viewer` → `system.viewer`).
     * A lower value caps read-time cost. Defaults to 3 — enough for typical
     * schemas, small enough to prevent runaway on accidentally cyclic paths.
     * Set to 0 to disable chaining entirely.
     */
    readTimeChainDepth?: number;
  },
) {
  return new Zbar<Schema, Data>(component, options);
}

export class Zbar<Schema extends ZbarSchema<Data>, Data = any> {
  private graphConfig: GraphConfig;
  private readTimeChainDepth: number;
  private permissionRelationsCache = new Map<
    string,
    Array<{ relation: string; condition?: string }>
  >();

  constructor(
    public component: any,
    private options: {
      schema: Schema;
      tenantId: string;
      defaultActorId?: string;
      enableAuditLog?: boolean;
      maxWriteDepth?: number;
      asyncWrites?: boolean;
      readTimeChainDepth?: number;
    },
  ) {
    this.graphConfig = parseSchemaToGraphConfig(options.schema);
    if (options.maxWriteDepth !== undefined) {
      this.graphConfig.maxWriteDepth = options.maxWriteDepth;
    }
    this.options.enableAuditLog = options.enableAuditLog ?? true;
    this.options.asyncWrites = options.asyncWrites ?? true;
    this.readTimeChainDepth = options.readTimeChainDepth ?? 3;
  }

  withTenant(tenantId: string): Zbar<Schema, Data> {
    return new Zbar<Schema, Data>(this.component, {
      ...this.options,
      tenantId,
    });
  }

  private validateRelationParameter(
    subject: { type: string },
    relation: string,
    object: { type: string },
  ) {
    const schema = this.options.schema;
    const objectEntity = schema.entities[object.type];

    if (!objectEntity?.relations || !(relation in objectEntity.relations)) {
      throw new Error(
        `Zbar Schema Error: Relation '${relation}' is not defined for object type '${object.type}'.`,
      );
    }

    const relDef = objectEntity.relations[relation];
    const defs = Array.isArray(relDef) ? relDef : [relDef];
    const localRelations = objectEntity.relations;
    const validSubjectTypes = new Set<string>();

    for (const d of defs) {
      if (typeof d === "string") {
        if (d.includes("#")) {
          validSubjectTypes.add(d.split("#")[0]);
        } else if (d.includes(".")) {
          // traversal dot-path — not a subject type
        } else if (schema.entities[d] && !localRelations[d]) {
          // entity type name (not a local relation reference)
          validSubjectTypes.add(d);
        }
      } else if (typeof d === "object" && d !== null && "type" in d) {
        validSubjectTypes.add((d as { type: string }).type);
      }
    }

    if (validSubjectTypes.size > 0 && !validSubjectTypes.has(subject.type)) {
      throw new Error(
        `Zbar Schema Error: Subject type '${subject.type}' is not a valid subject for relation '${relation}' on object type '${object.type}'. Valid subject types: ${[...validSubjectTypes].join(", ")}.`,
      );
    }
  }

  /**
   * Validate edge properties against the schema-defined validators.
   * Throws if required fields are missing or types don't match.
   */
  private validateProperties(
    objectType: string,
    relation: string,
    properties: unknown,
  ) {
    const entityDef = this.options.schema.entities[objectType];
    const validators = entityDef?.propertyValidators?.[relation];

    if (!validators) {
      throw new Error(
        `Zbar Schema Error: No properties defined for relation '${relation}' on entity type '${objectType}'. ` +
        `Remove the 'properties' option or define properties with .properties('${relation}', { ... }) in the schema.`,
      );
    }

    if (typeof properties !== "object" || properties === null) {
      throw new Error(
        `Zbar Schema Error: Properties for relation '${relation}' on '${objectType}' must be an object.`,
      );
    }

    const props = properties as Record<string, unknown>;

    // Check for required fields (non-optional validators)
    for (const [key, validator] of Object.entries(validators)) {
      const val = validator as GenericValidator;
      if (val.isOptional !== "optional" && !(key in props)) {
        throw new Error(
          `Zbar Schema Error: Missing required property '${key}' for relation '${relation}' on '${objectType}'.`,
        );
      }
    }

    // Check for unknown fields
    for (const key of Object.keys(props)) {
      if (!(key in validators)) {
        throw new Error(
          `Zbar Schema Error: Unknown property '${key}' for relation '${relation}' on '${objectType}'. ` +
          `Defined properties: ${Object.keys(validators).join(", ")}.`,
        );
      }
    }
  }

  private resolvePermissionRelations(objectType: string, permission: string) {
    const cacheKey = `${objectType}:${permission}`;
    if (this.permissionRelationsCache.has(cacheKey)) {
      return this.permissionRelationsCache.get(cacheKey)!;
    }

    const schema = this.options.schema;
    const perms = schema.entities[objectType]?.permissions?.[permission] || [];
    const results: Array<{ relation: string; condition?: string }> = [];

    const expand = (rel: string, currentCondition?: string) => {
      if (
        results.some(
          (r) => r.relation === rel && r.condition === currentCondition,
        )
      )
        return;
      results.push({ relation: rel, condition: currentCondition });

      const relDef = schema.entities[objectType]?.relations?.[rel];
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

    this.permissionRelationsCache.set(cacheKey, results);
    return results;
  }

  private async evaluateCondition(
    conditionName: string,
    ctx: QueryCtx | ActionCtx | MutationCtx,
    subject: SubjectOrObject,
    object: SubjectOrObject,
    permission: string,
    data: Data,
  ): Promise<boolean | Partial<Data>> {
    const conditionFn = this.options.schema.conditions?.[conditionName];
    if (!conditionFn) return false;

    const policyCtx: PolicyContext<Data> = {
      subject,
      resource: object,
      action: permission,
      data,
    };

    try {
      return await Promise.resolve(conditionFn(ctx as any, policyCtx));
    } catch {
      return false;
    }
  }

  private async validatePath(
    path: any,
    targetDef: { relation: string; condition?: string } | undefined,
    ctx: QueryCtx | ActionCtx | MutationCtx,
    subject: SubjectOrObject,
    object: SubjectOrObject,
    permission: string,
    requestContext?: Data,
  ): Promise<boolean> {
    let currentData = {
      ...(requestContext || {}),
      ...(path.conditions?.[0]?.conditionContext || {}),
    } as Data;

    if (path.conditions) {
      for (const c of path.conditions) {
        // Include context from the relationship edge
        if (c !== path.conditions[0] && c.conditionContext) {
          currentData = { ...currentData, ...c.conditionContext };
        }

        const ok = await this.evaluateCondition(
          c.condition,
          ctx,
          subject,
          object,
          permission,
          currentData,
        );
        if (ok === false) {
          return false;
        } else if (typeof ok === "object" && ok !== null) {
          currentData = { ...currentData, ...ok };
        }
      }
    }

    if (targetDef?.condition) {
      const ok = await this.evaluateCondition(
        targetDef.condition,
        ctx,
        subject,
        object,
        permission,
        currentData,
      );
      if (ok === false) {
        return false;
      }
    }

    return true;
  }

  /**
   * For listObjects mode: return object IDs reachable from `subject` through
   * any read-time dot-path whose derived relation is in
   * `acceptableRelations`. Skips the materialised graph entirely — callers
   * should union with materialised results and deduplicate.
   *
   * `depth` caps recursive chaining: when a read-time path's first hop
   * ("which sources does subject have targetRelation access to?") would
   * itself resolve through another read-time path, we recurse up to
   * `readTimeChainDepth` levels so list semantics match `can()` semantics.
   */
  private async listReadTimeObjects(
    ctx: QueryCtx | ActionCtx,
    subject: { type: string; id: string },
    objectType: string,
    acceptableRelations: string[],
    depth: number = 0,
  ): Promise<string[]> {
    const paths = this.graphConfig.readTimePaths;
    if (!paths || paths.length === 0) return [];
    const accepted = new Set(acceptableRelations);
    const relevant = paths.filter(
      (p) => p.objectType === objectType && accepted.has(p.derivedRelation),
    );
    if (relevant.length === 0) return [];

    const found = new Set<string>();
    for (const path of relevant) {
      for (const sourceType of path.sourceTypes) {
        const targetRelations = this.resolveRelationInheritance(
          sourceType,
          path.targetRelation,
        ).map((t: { relation: string }) => t.relation);
        if (targetRelations.length === 0) continue;

        // Step 1a: materialised sources (subject has targetRelation on source).
        const matSources: any[] = await ctx.runQuery(
          this.component.queries.listAccessibleObjectsFast,
          {
            tenantId: this.options.tenantId,
            subject,
            relations: targetRelations,
            objectType: sourceType,
          },
        );

        const sourceIds = new Set<string>();
        for (const s of matSources) {
          sourceIds.add(s.objectKey.split(":")[1]);
        }

        // Step 1b: recursively gather sources reachable via further RT paths.
        if (depth + 1 < this.readTimeChainDepth) {
          const chainedSourceIds = await this.listReadTimeObjects(
            ctx,
            subject,
            sourceType,
            targetRelations,
            depth + 1,
          );
          for (const id of chainedSourceIds) sourceIds.add(id);
        }

        if (sourceIds.size === 0) continue;

        // Step 2: for each source, list objects of `objectType` where the
        // source has `sourceRelation`. The source relation itself is
        // assumed materialised (typical case).
        for (const sourceId of sourceIds) {
          const objects: any[] = await ctx.runQuery(
            this.component.queries.listAccessibleObjectsFast,
            {
              tenantId: this.options.tenantId,
              subject: { type: sourceType, id: sourceId },
              relations: [path.sourceRelation],
              objectType,
            },
          );
          for (const obj of objects) {
            found.add(obj.objectKey.split(":")[1]);
          }
        }
      }
    }

    return [...found];
  }

  /**
   * For listSubjects mode: return subject IDs (of `subjectType`) that reach
   * `object` through any read-time dot-path whose derived relation is in
   * `acceptableRelations`. Callers union with materialised results.
   *
   * `depth` caps recursive chaining: when step 2's materialised lookup on
   * a source doesn't cover a given subject, we recurse through further RT
   * paths on that source so list semantics match `can()` semantics.
   */
  private async listReadTimeSubjects(
    ctx: QueryCtx | ActionCtx,
    object: { type: string; id: string },
    subjectType: string,
    acceptableRelations: string[],
    depth: number = 0,
  ): Promise<string[]> {
    const paths = this.graphConfig.readTimePaths;
    if (!paths || paths.length === 0) return [];
    const accepted = new Set(acceptableRelations);
    const relevant = paths.filter(
      (p) => p.objectType === object.type && accepted.has(p.derivedRelation),
    );
    if (relevant.length === 0) return [];

    const found = new Set<string>();
    for (const path of relevant) {
      for (const sourceType of path.sourceTypes) {
        const sources: any[] = await ctx.runQuery(
          this.component.queries.listSubjectsWithAccessFast,
          {
            tenantId: this.options.tenantId,
            object,
            relations: [path.sourceRelation],
            subjectType: sourceType,
          },
        );
        if (sources.length === 0) continue;

        const targetRelations = this.resolveRelationInheritance(
          sourceType,
          path.targetRelation,
        ).map((t: { relation: string }) => t.relation);
        if (targetRelations.length === 0) continue;

        for (const eff of sources) {
          const sourceId = eff.subjectKey.split(":")[1];
          const sourceObj = { type: sourceType, id: sourceId };

          // Step 2a: materialised subjects (subject has targetRelation on source).
          const matSubjects: any[] = await ctx.runQuery(
            this.component.queries.listSubjectsWithAccessFast,
            {
              tenantId: this.options.tenantId,
              object: sourceObj,
              relations: targetRelations,
              subjectType,
            },
          );
          for (const sub of matSubjects) {
            found.add(sub.subjectKey.split(":")[1]);
          }

          // Step 2b: recursive RT chain — subjects who reach `sourceObj`
          // through further read-time paths.
          if (depth + 1 < this.readTimeChainDepth) {
            const rtSubIds = await this.listReadTimeSubjects(
              ctx,
              sourceObj,
              subjectType,
              targetRelations,
              depth + 1,
            );
            for (const id of rtSubIds) found.add(id);
          }
        }
      }
    }

    return [...found];
  }

  /**
   * Fast "subject has any of `acceptableRelations` on `object`" check that
   * falls back to read-time-path evaluation when the materialised graph
   * misses. Used by the `.via()` gate / chain / verify steps so those
   * walks compose with `.readTimeRelation()` declarations.
   */
  private async hasAccessOrRT(
    ctx: QueryCtx | ActionCtx,
    subject: { type: string; id: string },
    acceptableRelations: string[],
    object: { type: string; id: string },
  ): Promise<boolean> {
    const hits: any[] = await ctx.runQuery(
      this.component.queries.checkPermissionFast,
      {
        tenantId: this.options.tenantId,
        subject,
        relations: acceptableRelations,
        object,
      },
    );
    if (hits.length > 0) return true;
    return this.evaluateReadTimePaths(
      ctx,
      subject,
      object,
      acceptableRelations,
    );
  }

  /**
   * Evaluate read-time dot-paths to determine whether `subject` reaches
   * `object` via any declared `.readTimeRelation()` whose derived relation
   * is in `acceptableRelations`.
   *
   * Walks the path as two indexed hops:
   *   1. Find sources S connected via (S, sourceRelation, object).
   *   2. For each S, check whether (subject, targetRelation*, S) exists,
   *      expanding `targetRelation` through local inheritance on S's type.
   *
   * When the step-2 materialised check misses and `depth` is below the
   * configured `readTimeChainDepth`, the evaluator recursively looks for
   * read-time paths on S — enabling RT-over-RT chains such as
   * `notification_rule.viewer` → `contact.viewer` → `system.viewer`.
   *
   * Short-circuits on the first hit. Returns false if no read-time paths
   * are declared, none apply to this object type / relation set, or no
   * path succeeds.
   */
  private async evaluateReadTimePaths(
    ctx: QueryCtx | ActionCtx,
    subject: { type: string; id: string },
    object: { type: string; id: string },
    acceptableRelations: string[],
    depth: number = 0,
  ): Promise<boolean> {
    const paths = this.graphConfig.readTimePaths;
    if (!paths || paths.length === 0) return false;

    const accepted = new Set(acceptableRelations);
    const relevant = paths.filter(
      (p) => p.objectType === object.type && accepted.has(p.derivedRelation),
    );
    if (relevant.length === 0) return false;

    for (const path of relevant) {
      for (const sourceType of path.sourceTypes) {
        const sourceRels: any[] = await ctx.runQuery(
          this.component.queries.listSubjectsWithAccessFast,
          {
            tenantId: this.options.tenantId,
            object,
            relations: [path.sourceRelation],
            subjectType: sourceType,
          },
        );
        if (sourceRels.length === 0) continue;

        const targetRelations = this.resolveRelationInheritance(
          sourceType,
          path.targetRelation,
        ).map((t: { relation: string }) => t.relation);
        if (targetRelations.length === 0) continue;

        for (const eff of sourceRels) {
          const sourceId = eff.subjectKey.split(":")[1];
          const sourceObj = { type: sourceType, id: sourceId };

          const hits: any[] = await ctx.runQuery(
            this.component.queries.checkPermissionFast,
            {
              tenantId: this.options.tenantId,
              subject,
              relations: targetRelations,
              object: sourceObj,
            },
          );
          if (hits.length > 0) return true;

          // Chain: if the materialised check missed on the source, look
          // for further read-time paths on it. Bounded by `readTimeChainDepth`.
          if (depth + 1 < this.readTimeChainDepth) {
            const chained = await this.evaluateReadTimePaths(
              ctx,
              subject,
              sourceObj,
              targetRelations,
              depth + 1,
            );
            if (chained) return true;
          }
        }
      }
    }

    return false;
  }

  private resolveRelationInheritance(objectType: string, relation: string) {
    const cacheKey = `rel_inh:${objectType}:${relation}`;
    if (this.permissionRelationsCache.has(cacheKey)) {
      return this.permissionRelationsCache.get(cacheKey)!;
    }

    const schema = this.options.schema;
    const results: Array<{ relation: string; condition?: string }> = [];

    const expand = (rel: string, currentCondition?: string) => {
      if (
        results.some(
          (r) => r.relation === rel && r.condition === currentCondition,
        )
      )
        return;
      results.push({ relation: rel, condition: currentCondition });

      const relDef = schema.entities[objectType]?.relations?.[rel];
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

    this.permissionRelationsCache.set(cacheKey, results);
    return results;
  }

  /**
   * Determine if a subject has a specific relationship with an object.
   */
  async hasRelationship<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
    Relation extends EntityRelations<Schema, ObjectType>,
  >(
    ctx: QueryCtx | ActionCtx,
    subject: { type: SubjectType; id: string },
    relation: Relation,
    object: { type: ObjectType; id: string },
    requestContext?: Data,
  ): Promise<boolean> {
    const targets = this.resolveRelationInheritance(object.type, relation);
    if (targets.length === 0) return false;

    const acceptableRelations = targets.map((t) => t.relation);

    const effectiveRels = await ctx.runQuery(
      this.component.queries.checkPermissionFast,
      {
        tenantId: this.options.tenantId,
        subject,
        relations: acceptableRelations,
        object,
      },
    );

    for (const eff of effectiveRels) {
      const targetDef = targets.find((t) => t.relation === eff.relation);

      for (const path of eff.paths) {
        const isValid = await this.validatePath(
          path,
          targetDef,
          ctx,
          subject,
          object,
          relation,
          requestContext,
        );

        if (isValid) return true;
      }
    }

    return this.evaluateReadTimePaths(
      ctx,
      subject,
      object,
      acceptableRelations,
    );
  }


  async can<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
    Permission extends EntityPermissions<Schema, ObjectType>,
  >(
    ctx: QueryCtx | ActionCtx,
    subject: { type: SubjectType; id: string },
    permission: Permission,
    object: { type: ObjectType; id: string },
    requestContext?: Data,
  ): Promise<boolean> {
    const targets = this.resolvePermissionRelations(object.type, permission);
    if (targets.length === 0) return false;

    const acceptableRelations = targets.map((t) => t.relation);

    const effectiveRels = await ctx.runQuery(
      this.component.queries.checkPermissionFast,
      {
        tenantId: this.options.tenantId,
        subject,
        relations: acceptableRelations,
        object,
      },
    );

    for (const eff of effectiveRels) {
      const targetDef = targets.find((t) => t.relation === eff.relation);

      for (const path of eff.paths) {
        const isValid = await this.validatePath(
          path,
          targetDef,
          ctx,
          subject,
          object,
          permission,
          requestContext,
        );

        if (isValid) return true;
      }
    }

    return this.evaluateReadTimePaths(
      ctx,
      subject,
      object,
      acceptableRelations,
    );
  }

  /**
   * Asserts that a subject has a specific permission on an object, throwing a PermissionError if denied.
   */
  async require<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
    Permission extends EntityPermissions<Schema, ObjectType>,
  >(
    ctx: QueryCtx | ActionCtx,
    subject: { type: SubjectType; id: string },
    permission: Permission,
    object: { type: ObjectType; id: string },
    requestContext?: Data,
  ): Promise<void> {
    const allowed = await this.can(
      ctx,
      subject,
      permission,
      object,
      requestContext,
    );
    if (!allowed) {
      throw new PermissionError(
        `Permission denied: ${permission} on ${object.type}:${object.id}`,
      );
    }
  }

  private async listWithValidation<T extends { id: string }>(
    ctx: QueryCtx | ActionCtx,
    effectiveRels: any[],
    targets: Array<{ relation: string; condition?: string }>,
    getId: (eff: any) => string,
    subjectResolver: (eff: any, id: string) => SubjectOrObject,
    objectResolver: (eff: any, id: string) => SubjectOrObject,
    permission: string,
    requestContext?: Data,
  ): Promise<T[]> {
    const results: T[] = [];
    const seen = new Set<string>();
    for (const eff of effectiveRels) {
      const id = getId(eff);
      if (seen.has(id)) continue;

      const targetDef = targets.find((t) => t.relation === eff.relation);
      let valid = false;

      for (const path of eff.paths) {
        const subject = subjectResolver(eff, id);
        const object = objectResolver(eff, id);
        const isValid = await this.validatePath(
          path,
          targetDef,
          ctx,
          subject,
          object,
          permission,
          requestContext,
        );
        if (isValid) {
          valid = true;
          break;
        }
      }
      if (valid) {
        seen.add(id);
        results.push({ id } as T);
      }
    }
    return results;
  }

  /**
   * Fluent query builder for listing objects or subjects.
   *
   * **Listing objects** (pass object type as string, subject as `{type, id}`):
   * ```ts
   * const devices = await zbar.list()
   *   .object("device")
   *   .permission("view")
   *   .subject({ type: "user", id: userId })
   *   .collect(ctx);
   * // devices: Array<{ objectId: string }>
   * ```
   *
   * **Listing subjects** (pass object as `{type, id}`, subject type as string):
   * ```ts
   * const users = await zbar.list()
   *   .object({ type: "device", id: deviceId })
   *   .relation("admin")
   *   .subject("user")
   *   .collect(ctx);
   * // users: Array<{ subjectId: string }>
   * ```
   *
   * **With intermediary filtering** (`.via()` is optional):
   * ```ts
   * const devices = await zbar.list()
   *   .object("device")
   *   .relation("admin")
   *   .subject({ type: "user", id: userId })
   *   .via({ type: "system", id: sysId }, { type: "group", id: groupId })
   *   .collect(ctx, requestContext);
   * ```
   */
  list(): ListInitial<Schema, Data> {
    return new ListQueryBuilder<Schema, Data>(this) as any;
  }

  /**
   * Fluent query builder for listing **direct** (base) relationships.
   *
   * Unlike `.list()` which queries the materialised effective-relationship
   * graph, `.listDirect()` reads the raw `relationships` table — only
   * explicitly-written edges, no transitive or inherited expansions.
   *
   * Provide `.object()`, `.subject()`, or both to scope the query.
   * Optionally add `.relation()` or `.permission()` to filter by
   * relation name (`.permission()` expands to all contributing relations
   * including inherited ones).
   *
   * ```ts
   * // All direct relationships where org1 is the object
   * const rels = await zbar.listDirect()
   *   .object({ type: "org", id: "org1" })
   *   .collect(ctx);
   *
   * // Direct relationships between a specific subject and object
   * const rels = await zbar.listDirect()
   *   .object({ type: "org", id: "org1" })
   *   .subject({ type: "user", id: "u1" })
   *   .collect(ctx);
   *
   * // Filter by relation (with inheritance: owner → admin → viewer)
   * const viewers = await zbar.listDirect()
   *   .object({ type: "org", id: "org1" })
   *   .relation("viewer")
   *   .collect(ctx);
   *
   * // Filter by permission (expands to all contributing relations)
   * const editors = await zbar.listDirect()
   *   .object({ type: "org", id: "org1" })
   *   .permission("edit_settings")
   *   .collect(ctx);
   * ```
   */
  listDirect(): ListDirectInitial<Schema, Data> {
    return new ListDirectQueryBuilder<Schema, Data>(this) as any;
  }

  // ============================================================================
  // Private helpers for ListQueryBuilder
  // ============================================================================

  private getEntityRelations(entityType: string): string[] {
    return Object.keys(
      this.options.schema.entities[entityType]?.relations || {},
    );
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
  private getViaRelevantRelations(
    objectType: string,
    acceptableRelations: string[],
    viaType: string,
  ): string[] {
    const schema = this.options.schema;
    const objectDef = schema.entities[objectType];
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
                schema.entities[bd] !== undefined &&
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
    for (const rtPath of this.graphConfig.readTimePaths ?? []) {
      if (rtPath.objectType !== objectType) continue;
      if (!acceptableRelations.includes(rtPath.derivedRelation)) continue;
      if (!rtPath.sourceTypes.includes(viaType)) continue;
      baseRelations.add(rtPath.targetRelation);
    }

    if (baseRelations.size === 0) return [];

    // Expand with inheritance on the via entity type
    const expanded = new Set<string>();
    for (const rel of baseRelations) {
      const inherited = this.resolveRelationInheritance(viaType, rel);
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
  private getStructuralRelations(
    objectType: string,
    subjectType: string,
  ): string[] {
    const schema = this.options.schema;
    const objectDef = schema.entities[objectType];
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
          schema.entities[d] !== undefined &&
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
  private getReverseStructuralRelations(
    objectType: string,
    viaType: string,
  ): string[] {
    const schema = this.options.schema;
    const objectDef = schema.entities[objectType];
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

  /**
   * Add a relationship between a subject and an object.
   *
   * If the relation has properties defined in the schema, pass them
   * via `options.properties`. Properties are validated at write-time
   * and stored on the direct edge.
   *
   * ```ts
   * await zbar.addRelation(ctx, user, "editor", project, {
   *   properties: { weight: 0.8, note: "Lead editor" },
   * });
   * ```
   */
  async addRelation<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
    Relation extends EntityRelations<Schema, ObjectType>
  >(
    ctx: MutationCtx | ActionCtx,
    subject: { type: SubjectType; id: string },
    relation: Relation,
    object: { type: ObjectType; id: string },
    options?: {
      condition?: SchemaConditions<Schema>;
      conditionContext?: unknown;
      createdBy?: string;
      properties?: ResolvedProperties<Schema, ObjectType, Relation & string> extends undefined
        ? never
        : ResolvedProperties<Schema, ObjectType, Relation & string>;
    },
  ): Promise<string> {
    this.validateRelationParameter(subject, relation, object);

    if (options?.properties !== undefined) {
      this.validateProperties(object.type, relation, options.properties);
    }

    return ctx.runMutation(this.component.mutations.addRelation, {
      tenantId: this.options.tenantId,
      subject,
      relation,
      object,
      condition: options?.condition
        ? {
            condition: options.condition,
            conditionContext: options.conditionContext,
          }
        : undefined,
      properties: options?.properties,
      createdBy: options?.createdBy ?? this.options.defaultActorId,
      graphConfig: this.graphConfig,
      enableAuditLog: this.options.enableAuditLog,
      asyncWrites: this.options.asyncWrites,
    });
  }

  /**
   * Update a relationship between a subject and an object to a new relation, executed atomically via Add-Before-Remove.
   */
  async updateRelation<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
    OldRelation extends
      | EntityRelations<Schema, ObjectType>
      | EntityRelations<Schema, SubjectType>,
    NewRelation extends
      | EntityRelations<Schema, ObjectType>
      | EntityRelations<Schema, SubjectType>,
  >(
    ctx: MutationCtx | ActionCtx,
    subject: { type: SubjectType; id: string },
    oldRelation: OldRelation,
    newRelation: NewRelation,
    object: { type: ObjectType; id: string },
    options?: {
      condition?: SchemaConditions<Schema>;
      conditionContext?: unknown;
      createdBy?: string;
      properties?: ResolvedProperties<Schema, ObjectType, NewRelation & string> extends undefined
        ? never
        : ResolvedProperties<Schema, ObjectType, NewRelation & string>;
    },
  ): Promise<string> {
    this.validateRelationParameter(subject, oldRelation as string, object);
    this.validateRelationParameter(subject, newRelation as string, object);

    if (options?.properties !== undefined) {
      this.validateProperties(object.type, newRelation as string, options.properties);
    }

    return ctx.runMutation(this.component.mutations.updateRelation, {
      tenantId: this.options.tenantId,
      subject,
      oldRelation,
      newRelation,
      object,
      condition: options?.condition
        ? {
            condition: options.condition,
            conditionContext: options.conditionContext,
          }
        : undefined,
      properties: options?.properties,
      createdBy: options?.createdBy ?? this.options.defaultActorId,
      graphConfig: this.graphConfig,
      enableAuditLog: this.options.enableAuditLog,
      asyncWrites: this.options.asyncWrites,
    });
  }

  /**
   * Add a relationship between a subject and an object, clearing any existing relationships between them atomically.
   */
  async setRelation<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
    Relation extends
      | EntityRelations<Schema, ObjectType>
      | EntityRelations<Schema, SubjectType>,
  >(
    ctx: MutationCtx | ActionCtx,
    subject: { type: SubjectType; id: string },
    relation: Relation,
    object: { type: ObjectType; id: string },
    options?: {
      condition?: SchemaConditions<Schema>;
      conditionContext?: unknown;
      createdBy?: string;
      properties?: ResolvedProperties<Schema, ObjectType, Relation & string> extends undefined
        ? never
        : ResolvedProperties<Schema, ObjectType, Relation & string>;
    },
  ): Promise<string> {
    this.validateRelationParameter(subject, relation, object);

    if (options?.properties !== undefined) {
      this.validateProperties(object.type, relation, options.properties);
    }

    const objectRelations = Object.keys(
      this.options.schema.entities[object.type]?.relations || {},
    );

    return ctx.runMutation(this.component.mutations.setRelation, {
      tenantId: this.options.tenantId,
      subject,
      relation,
      object,
      objectRelations,
      condition: options?.condition
        ? {
            condition: options.condition,
            conditionContext: options.conditionContext,
          }
        : undefined,
      properties: options?.properties,
      createdBy: options?.createdBy ?? this.options.defaultActorId,
      graphConfig: this.graphConfig,
      enableAuditLog: this.options.enableAuditLog,
      asyncWrites: this.options.asyncWrites,
    });
  }

  /**
   * Remove a relationship between a subject and an object.
   */
  async removeRelation<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
    Relation extends
      | EntityRelations<Schema, ObjectType>
      | EntityRelations<Schema, SubjectType>,
  >(
    ctx: MutationCtx | ActionCtx,
    subject: { type: SubjectType; id: string },
    relation: Relation,
    object: { type: ObjectType; id: string },
    actorId?: string,
  ): Promise<boolean> {
    this.validateRelationParameter(subject, relation, object);

    return ctx.runMutation(this.component.mutations.removeRelation, {
      tenantId: this.options.tenantId,
      subject,
      relation,
      object,
      actorId: actorId ?? this.options.defaultActorId,
      graphConfig: this.graphConfig,
      enableAuditLog: this.options.enableAuditLog,
      asyncWrites: this.options.asyncWrites,
    });
  }

  /**
   * Delete an entity and all its associated relationships (both as subject and object).
   */
  async deleteEntity<EntityType extends keyof Schema["entities"] & string>(
    ctx: MutationCtx | ActionCtx,
    entity: { type: EntityType; id: string },
    actorId?: string,
  ): Promise<{
    relationshipsRemoved: number;
    effectiveRelationshipsRemoved: number;
  }> {
    return ctx.runMutation(this.component.mutations.deleteEntity, {
      tenantId: this.options.tenantId,
      entity,
      actorId: actorId ?? this.options.defaultActorId,
      graphConfig: this.graphConfig,
      enableAuditLog: this.options.enableAuditLog,
      asyncWrites: this.options.asyncWrites,
    });
  }
}
