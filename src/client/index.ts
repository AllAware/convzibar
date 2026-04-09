/* eslint-disable @typescript-eslint/no-empty-object-type */
import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
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
  | { type: string; reverse?: string }
  | { relation: string; condition: string }
  | Array<string | { type: string; reverse?: string } | { relation: string; condition: string }>;

export interface EntityDefinition {
  relations?: Record<string, SchemaRelation>;
  permissions?: Record<
    string,
    Array<string | { relation: string; condition: string }>
  >;
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
    { relations: Record<string, string>; permissions: string }
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
  Entities extends Record<string, { relations: Record<string, string>; permissions: string }>,
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
  Entities extends Record<string, { relations: Record<string, string>; permissions: string }>,
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
    { relations: Record<string, string>; permissions: string }
  >,
  Relations extends Record<string, string> = {},
  Permissions extends string = never,
> {
  declare _relations: Relations;
  declare _permissions: Permissions;

  public def: any = { relations: {}, permissions: {} };

  relation<
    RelName extends string,
    Target extends string = (keyof Entities | EntName) & string,
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
      | { type: string; reverse?: string }
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
      // Allow forward-referencing traversals to relations that will be
      // auto-injected by reverse edges from entities defined later.
      | `${string}.${string}`
    >
  ): EntityBuilder<
    EntName,
    Conditions,
    Entities,
    Relations & Record<RelName, Target>,
    Permissions
  > {
    this.def.relations[name] = targets.length === 1 ? targets[0] : targets;
    return this as any;
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
    Permissions | PermName
  > {
    this.def.permissions[name] = targets;
    return this as any;
  }
}

export class SchemaBuilder<
  Data,
  Conditions extends Record<string, any> = {},
  Entities extends Record<
    string,
    { relations: Record<string, string>; permissions: string }
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
  >(
    name: Name,
    build?: (
      e: EntityBuilder<Name, Conditions, Entities, {}, never>,
    ) => EntityBuilder<Name, Conditions, Entities, Rel, Perm>,
  ): SchemaBuilder<
    Data,
    Conditions,
    Entities & Record<Name, { relations: Rel; permissions: Perm }>
  > {
    if (build) {
      const e = build(new EntityBuilder());
      this._schema.entities[name] = e.def;
    } else {
      this._schema.entities[name] = { relations: {}, permissions: {} };
    }
    return this as any;
  }

  build(): BuiltZbarSchema<Data, Conditions, Entities> {
    // Post-process: auto-inject reverse relation targets.
    // When entity A declares relation('foo', { type: 'B', reverse: 'bar' }),
    // the reverse relation 'bar' is automatically added to entity B's relations
    // with entity A as the subject type (if not already declared).
    // This eliminates the need to pre-declare reverse targets manually.
    for (const [entityType, entityDef] of Object.entries(
      this._schema.entities as Record<string, EntityDefinition>,
    )) {
      const relations = entityDef.relations || {};
      for (const [, relDef] of Object.entries(relations)) {
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
            const reverseSubjectType = entityType;

            const targetEntity = (this._schema.entities as any)[
              targetEntityName
            ];
            if (!targetEntity) continue;
            if (!targetEntity.relations) targetEntity.relations = {};

            // Only inject if the relation doesn't already exist.
            // If the user explicitly declared it (e.g., to add traversals),
            // we leave their definition intact.
            if (!(reverseRelName in targetEntity.relations)) {
              targetEntity.relations[reverseRelName] = reverseSubjectType;
            }
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

        // — Fire all queries in parallel —
        const promises: Promise<any>[] = [];

        // [0] Gate: subject → via[0]
        promises.push(
          ctx.runQuery(z.component.queries.checkPermissionFast, {
            tenantId: z.options.tenantId,
            subject,
            relations: gateRelations,
            object: firstVia,
          }),
        );

        // [1 .. N-1] Chain links: via[i] → via[i+1]
        for (let i = 0; i < viaChain.length - 1; i++) {
          const next = viaChain[i + 1];
          promises.push(
            ctx.runQuery(z.component.queries.checkPermissionFast, {
              tenantId: z.options.tenantId,
              subject: viaChain[i],
              relations: z.getEntityRelations(next.type),
              object: next,
            }),
          );
        }

        // [N] Expand: via[N-1] → objects (using acceptable relations
        //     so we only get objects reachable via the right path).
        promises.push(
          ctx.runQuery(z.component.queries.listAccessibleObjectsFast, {
            tenantId: z.options.tenantId,
            subject: lastVia,
            relations: acceptableRelations,
            objectType,
          }),
        );

        const results = await Promise.all(promises);

        // Verify gate + every chain link passed
        const numChecks = viaChain.length; // 1 gate + (N-1) links
        for (let i = 0; i < numChecks; i++) {
          if ((results[i] as any[]).length === 0) return [];
        }

        // Collect expand results
        const expandRows = results[results.length - 1] as any[];
        const candidateIds = new Set<string>();
        for (const eff of expandRows) {
          candidateIds.add(eff.objectKey.split(":")[1]);
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

        const promises: Promise<any>[] = [];

        // [0] Gate: via[N-1] → object (using acceptable relations)
        promises.push(
          ctx.runQuery(z.component.queries.checkPermissionFast, {
            tenantId: z.options.tenantId,
            subject: lastVia,
            relations: acceptableRelations,
            object,
          }),
        );

        // [1 .. N-1] Chain links: via[i] → via[i+1]
        for (let i = 0; i < viaChain.length - 1; i++) {
          const next = viaChain[i + 1];
          promises.push(
            ctx.runQuery(z.component.queries.checkPermissionFast, {
              tenantId: z.options.tenantId,
              subject: viaChain[i],
              relations: z.getEntityRelations(next.type),
              object: next,
            }),
          );
        }

        // [N] Expand: via[0] ← subjects (using tight relations)
        promises.push(
          ctx.runQuery(z.component.queries.listSubjectsWithAccessFast, {
            tenantId: z.options.tenantId,
            object: firstVia,
            relations: expandRelations,
            subjectType,
          }),
        );

        const results = await Promise.all(promises);

        // Verify gate + chain links
        const numChecks = viaChain.length;
        for (let i = 0; i < numChecks; i++) {
          if ((results[i] as any[]).length === 0) return [];
        }

        const expandRows = results[results.length - 1] as any[];
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
  },
) {
  return new Zbar<Schema, Data>(component, options);
}

export class Zbar<Schema extends ZbarSchema<Data>, Data = any> {
  private graphConfig: GraphConfig;
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
    },
  ) {
    this.graphConfig = parseSchemaToGraphConfig(options.schema);
    if (options.maxWriteDepth !== undefined) {
      this.graphConfig.maxWriteDepth = options.maxWriteDepth;
    }
    this.options.enableAuditLog = options.enableAuditLog ?? true;
    this.options.asyncWrites = options.asyncWrites ?? true;
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

    return false;
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

    return false;
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
        if (typeof d === "string" && d.includes("#")) {
          const [type, viaRel] = d.split("#");
          if (type === viaType) {
            baseRelations.add(viaRel);
          }
        }
      }
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
   * Add a relationship between a subject and an object.
   */
  async addRelation<
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
    },
  ): Promise<string> {
    this.validateRelationParameter(subject, relation, object);

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
    },
  ): Promise<string> {
    this.validateRelationParameter(subject, oldRelation as string, object);
    this.validateRelationParameter(subject, newRelation as string, object);

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
    },
  ): Promise<string> {
    this.validateRelationParameter(subject, relation, object);

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
