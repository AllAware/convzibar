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
  | { type: string }
  | { relation: string; condition: string }
  | Array<string | { type: string } | { relation: string; condition: string }>;

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
    Target extends (keyof Entities | EntName) & string,
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

/** Ready to collect, with optional `.via()` filtering. */
export interface ListCollectable<
  Schema extends ZbarSchema<Data>,
  Data,
  Result,
> {
  via<VT extends keyof Schema["entities"] & string>(
    ...entities: Array<{ type: VT; id: string }>
  ): ListFinal<Data, Result>;
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<Result[]>;
}

/** Terminal — can only `.collect()`. */
export interface ListFinal<Data, Result> {
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<Result[]>;
}

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

  via(...entities: Array<{ type: string; id: string }>): this {
    this._via = entities;
    return this;
  }

  async collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<Array<{ objectId: string } | { subjectId: string }>> {
    const hasVia = this._via.length > 0;
    const isPermission = this._permission != null;
    const relationOrPermission = (this._relation ?? this._permission)!;

    if (this._mode === "listObjects") {
      const subject = {
        type: this._subjectType!,
        id: this._subjectId!,
      };
      const objectType = this._objectType;

      if (hasVia) {
        if (isPermission) {
          return this.zbar.listAccessibleObjectsVia(
            ctx,
            subject as any,
            relationOrPermission as any,
            objectType as any,
            this._via as any,
            requestContext,
          );
        } else {
          return this.zbar.listObjectsWithRelationVia(
            ctx,
            subject as any,
            relationOrPermission as any,
            objectType as any,
            this._via as any,
            requestContext,
          );
        }
      } else {
        if (isPermission) {
          return this.zbar.listAccessibleObjects(
            ctx,
            subject as any,
            relationOrPermission as any,
            objectType as any,
            requestContext,
          );
        } else {
          return this.zbar.listObjectsWithRelation(
            ctx,
            subject as any,
            relationOrPermission as any,
            objectType as any,
            requestContext,
          );
        }
      }
    } else {
      // listSubjects
      const object = {
        type: this._objectType,
        id: this._objectId!,
      };
      const subjectType = this._subjectType!;

      if (hasVia) {
        if (isPermission) {
          return this.zbar.listSubjectsWithAccessVia(
            ctx,
            subjectType as any,
            relationOrPermission as any,
            object as any,
            this._via as any,
            requestContext,
          );
        } else {
          return this.zbar.listSubjectsWithRelationVia(
            ctx,
            subjectType as any,
            relationOrPermission as any,
            object as any,
            this._via as any,
            requestContext,
          );
        }
      } else {
        if (isPermission) {
          return this.zbar.listSubjectsWithAccess(
            ctx,
            subjectType as any,
            relationOrPermission as any,
            object as any,
            requestContext,
          );
        } else {
          return this.zbar.listSubjectsWithRelation(
            ctx,
            subjectType as any,
            relationOrPermission as any,
            object as any,
            requestContext,
          );
        }
      }
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

  /**
   * Retrieve a list of all relationships a subject has on an object.
   */
  async getRelationships<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
  >(
    ctx: QueryCtx | ActionCtx,
    subject: { type: SubjectType; id: string },
    object: { type: ObjectType; id: string },
    requestContext?: Data,
    options?: {
      includeInherited?: boolean;
    },
  ): Promise<Array<EntityRelations<Schema, ObjectType>>> {
    const objectRelations = Object.keys(
      this.options.schema.entities[object.type]?.relations || {},
    ) as Array<EntityRelations<Schema, ObjectType>>;

    if (objectRelations.length === 0) return [];

    const includeInherited = options?.includeInherited ?? false;

    // 1. Expand all possible relations to find every target we might need
    const relationTargets = new Map<
      string,
      Array<{ relation: string; condition?: string }>
    >();
    const allAcceptableRelations = new Set<string>();

    for (const rel of objectRelations) {
      const targets = includeInherited
        ? this.resolveRelationInheritance(object.type, rel)
        : [{ relation: rel, condition: undefined }];
      relationTargets.set(rel, targets);
      for (const t of targets) {
        allAcceptableRelations.add(t.relation);
      }
    }

    if (allAcceptableRelations.size === 0) return [];

    // 2. Fetch all effective relationships in a SINGLE query
    const effectiveRels = await ctx.runQuery(
      this.component.queries.checkPermissionFast,
      {
        tenantId: this.options.tenantId,
        subject,
        relations: Array.from(allAcceptableRelations),
        object,
      },
    );

    // 3. Evaluate each relation locally using the fetched effective relationships
    const validRelations: Array<EntityRelations<Schema, ObjectType>> = [];

    for (const rel of objectRelations) {
      const targets = relationTargets.get(rel)!;
      let hasRel = false;

      for (const eff of effectiveRels) {
        const targetDef = targets.find((t) => t.relation === eff.relation);
        if (!targetDef) continue;

        for (const path of eff.paths) {
          // If includeInherited is false, ONLY consider base relationships (path length 1)
          if (!includeInherited && path.baseIds && path.baseIds.length > 1) {
            continue;
          }

          const isValid = await this.validatePath(
            path,
            targetDef,
            ctx,
            subject,
            object,
            rel,
            requestContext,
          );

          if (isValid) {
            hasRel = true;
            break;
          }
        }
        if (hasRel) break;
      }

      if (hasRel) {
        validRelations.push(rel);
      }
    }

    return validRelations;
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
   * Retrieve a list of objects a subject has a specific permission on.
   */
  async listAccessibleObjects<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
    Permission extends EntityPermissions<Schema, ObjectType>,
  >(
    ctx: QueryCtx | ActionCtx,
    subject: { type: SubjectType; id: string },
    permission: Permission,
    objectType: ObjectType,
    requestContext?: Data,
  ): Promise<Array<{ objectId: string }>> {
    const targets = this.resolvePermissionRelations(objectType, permission);
    if (targets.length === 0) return [];

    const acceptableRelations = targets.map((t) => t.relation);

    const effectiveRels = await ctx.runQuery(
      this.component.queries.listAccessibleObjectsFast,
      {
        tenantId: this.options.tenantId,
        subject,
        relations: acceptableRelations,
        objectType,
      },
    );

    const results = await this.listWithValidation<{
      id: string;
      objectId: string;
    }>(
      ctx,
      effectiveRels,
      targets,
      (eff) => eff.objectKey.split(":")[1],
      () => subject,
      (_, id) => ({ type: objectType, id }),
      permission,
      requestContext,
    );

    return results.map((r) => ({ objectId: r.id }));
  }

  /**
   * Retrieve a list of objects a subject has a specific relationship with.
   */
  async listObjectsWithRelation<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
    Relation extends EntityRelations<Schema, ObjectType>,
  >(
    ctx: QueryCtx | ActionCtx,
    subject: { type: SubjectType; id: string },
    relation: Relation,
    objectType: ObjectType,
    requestContext?: Data,
  ): Promise<Array<{ objectId: string }>> {
    const targets = this.resolveRelationInheritance(objectType, relation);
    if (targets.length === 0) return [];

    const acceptableRelations = targets.map((t) => t.relation);

    const effectiveRels = await ctx.runQuery(
      this.component.queries.listAccessibleObjectsFast,
      {
        tenantId: this.options.tenantId,
        subject,
        relations: acceptableRelations,
        objectType,
      },
    );

    const results = await this.listWithValidation<{
      id: string;
      objectId: string;
    }>(
      ctx,
      effectiveRels,
      targets,
      (eff) => eff.objectKey.split(":")[1],
      () => subject,
      (_, id) => ({ type: objectType, id }),
      relation,
      requestContext,
    );

    return results.map((r) => ({ objectId: r.id }));
  }

  /**
   * Retrieve a list of subjects that have a specific relationship with an object.
   */
  async listSubjectsWithRelation<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
    Relation extends EntityRelations<Schema, ObjectType>,
  >(
    ctx: QueryCtx | ActionCtx,
    subjectType: SubjectType,
    relation: Relation,
    object: { type: ObjectType; id: string },
    requestContext?: Data,
  ): Promise<Array<{ subjectId: string }>> {
    const targets = this.resolveRelationInheritance(object.type, relation);
    if (targets.length === 0) return [];

    const acceptableRelations = targets.map((t) => t.relation);

    const effectiveRels = await ctx.runQuery(
      this.component.queries.listSubjectsWithAccessFast,
      {
        tenantId: this.options.tenantId,
        object,
        relations: acceptableRelations,
        subjectType,
      },
    );

    const results = await this.listWithValidation<{
      id: string;
      userId: string;
    }>(
      ctx,
      effectiveRels,
      targets,
      (eff) => eff.subjectKey.split(":")[1],
      (eff, id) => ({ type: eff.subjectKey.split(":")[0], id }),
      () => object,
      relation,
      requestContext,
    );

    return results.map((r) => ({ subjectId: r.id }));
  }

  /**
   * Retrieve a list of subjects that have a specific permission on an object.
   */
  async listSubjectsWithAccess<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
    Permission extends EntityPermissions<Schema, ObjectType>,
  >(
    ctx: QueryCtx | ActionCtx,
    subjectType: SubjectType,
    permission: Permission,
    object: { type: ObjectType; id: string },
    requestContext?: Data,
  ): Promise<Array<{ subjectId: string }>> {
    const targets = this.resolvePermissionRelations(object.type, permission);
    if (targets.length === 0) return [];

    const acceptableRelations = targets.map((t) => t.relation);

    const effectiveRels = await ctx.runQuery(
      this.component.queries.listSubjectsWithAccessFast,
      {
        tenantId: this.options.tenantId,
        object,
        relations: acceptableRelations,
        subjectType,
      },
    );

    const results = await this.listWithValidation<{
      id: string;
      userId: string;
    }>(
      ctx,
      effectiveRels,
      targets,
      (eff) => eff.subjectKey.split(":")[1],
      (eff, id) => ({ type: eff.subjectKey.split(":")[0], id }),
      () => object,
      permission,
      requestContext,
    );

    return results.map((r) => ({ subjectId: r.id }));
  }

  // ============================================================================
  // Via (Intermediary Filtering) Methods
  // ============================================================================

  /**
   * Get all relation names defined for an entity type in the schema.
   */
  private getEntityRelations(entityType: string): string[] {
    return Object.keys(
      this.options.schema.entities[entityType]?.relations || {},
    );
  }

  /**
   * Query effective relationships where the given entity is the subject,
   * returning the set of object IDs of the specified object type.
   * This bypasses client-side schema validation since intermediate entities
   * (e.g., a system entity as subject of a device relation) are valid in
   * the effective relationships table even if not a direct type target.
   */
  private async getObjectIdsReachableFrom(
    ctx: QueryCtx | ActionCtx,
    entity: { type: string; id: string },
    objectType: string,
  ): Promise<Set<string>> {
    const relations = this.getEntityRelations(objectType);
    if (relations.length === 0) return new Set();

    const effectiveRels = await ctx.runQuery(
      this.component.queries.listAccessibleObjectsFast,
      {
        tenantId: this.options.tenantId,
        subject: entity,
        relations,
        objectType,
      },
    );

    const ids = new Set<string>();
    for (const eff of effectiveRels) {
      ids.add(eff.objectKey.split(":")[1]);
    }
    return ids;
  }

  /**
   * Query effective relationships where the given entity is the object,
   * returning the set of subject IDs of the specified subject type.
   */
  private async getSubjectIdsReachableFrom(
    ctx: QueryCtx | ActionCtx,
    entity: { type: string; id: string },
    subjectType: string,
  ): Promise<Set<string>> {
    const relations = this.getEntityRelations(entity.type);
    if (relations.length === 0) return new Set();

    const effectiveRels = await ctx.runQuery(
      this.component.queries.listSubjectsWithAccessFast,
      {
        tenantId: this.options.tenantId,
        object: entity,
        relations,
        subjectType,
      },
    );

    const ids = new Set<string>();
    for (const eff of effectiveRels) {
      ids.add(eff.subjectKey.split(":")[1]);
    }
    return ids;
  }

  /**
   * List objects a subject has a specific permission on, filtered to only
   * those accessible through ALL of the specified intermediate entities.
   *
   * Example: "List all devices user X can view that are accessible through system Y"
   * ```ts
   * const devices = await zbar.listAccessibleObjectsVia(ctx,
   *   { type: 'user', id: 'user1' },
   *   'view',
   *   'device',
   *   [{ type: 'system', id: 'system1' }],
   * );
   * ```
   */
  async listAccessibleObjectsVia<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
    ViaType extends keyof Schema["entities"] & string,
    Permission extends EntityPermissions<Schema, ObjectType>,
  >(
    ctx: QueryCtx | ActionCtx,
    subject: { type: SubjectType; id: string },
    permission: Permission,
    objectType: ObjectType,
    via: Array<{ type: ViaType; id: string }>,
    requestContext?: Data,
  ): Promise<Array<{ objectId: string }>> {
    if (via.length === 0) {
      return this.listAccessibleObjects(
        ctx,
        subject,
        permission,
        objectType,
        requestContext,
      );
    }

    // Step 1: Get all objects the subject has the permission on
    const [candidates, ...viaSets] = await Promise.all([
      this.listAccessibleObjects(
        ctx,
        subject,
        permission,
        objectType,
        requestContext,
      ),
      ...via.map((v) => this.getObjectIdsReachableFrom(ctx, v, objectType)),
    ]);

    // Step 2: Intersect — keep only objects reachable through ALL via entities
    return candidates.filter((c) =>
      viaSets.every((viaSet) => viaSet.has(c.objectId)),
    );
  }

  /**
   * List objects a subject has a specific relation with, filtered to only
   * those accessible through ALL of the specified intermediate entities.
   *
   * Example: "List all devices user X is admin of through system Y"
   * ```ts
   * const devices = await zbar.listObjectsWithRelationVia(ctx,
   *   { type: 'user', id: 'user1' },
   *   'admin',
   *   'device',
   *   [{ type: 'system', id: 'system1' }],
   * );
   * ```
   */
  async listObjectsWithRelationVia<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
    ViaType extends keyof Schema["entities"] & string,
    Relation extends EntityRelations<Schema, ObjectType>,
  >(
    ctx: QueryCtx | ActionCtx,
    subject: { type: SubjectType; id: string },
    relation: Relation,
    objectType: ObjectType,
    via: Array<{ type: ViaType; id: string }>,
    requestContext?: Data,
  ): Promise<Array<{ objectId: string }>> {
    if (via.length === 0) {
      return this.listObjectsWithRelation(
        ctx,
        subject,
        relation,
        objectType,
        requestContext,
      );
    }

    const [candidates, ...viaSets] = await Promise.all([
      this.listObjectsWithRelation(
        ctx,
        subject,
        relation,
        objectType,
        requestContext,
      ),
      ...via.map((v) => this.getObjectIdsReachableFrom(ctx, v, objectType)),
    ]);

    return candidates.filter((c) =>
      viaSets.every((viaSet) => viaSet.has(c.objectId)),
    );
  }

  /**
   * List subjects that have a specific permission on an object, filtered to only
   * those whose access goes through ALL of the specified intermediate entities.
   *
   * Example: "List all users who can view device D through system Y"
   * ```ts
   * const users = await zbar.listSubjectsWithAccessVia(ctx,
   *   'user',
   *   'view',
   *   { type: 'device', id: 'device1' },
   *   [{ type: 'system', id: 'system1' }],
   * );
   * ```
   */
  async listSubjectsWithAccessVia<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
    ViaType extends keyof Schema["entities"] & string,
    Permission extends EntityPermissions<Schema, ObjectType>,
  >(
    ctx: QueryCtx | ActionCtx,
    subjectType: SubjectType,
    permission: Permission,
    object: { type: ObjectType; id: string },
    via: Array<{ type: ViaType; id: string }>,
    requestContext?: Data,
  ): Promise<Array<{ subjectId: string }>> {
    if (via.length === 0) {
      return this.listSubjectsWithAccess(
        ctx,
        subjectType,
        permission,
        object,
        requestContext,
      );
    }

    const [candidates, ...viaSets] = await Promise.all([
      this.listSubjectsWithAccess(
        ctx,
        subjectType,
        permission,
        object,
        requestContext,
      ),
      ...via.map((v) =>
        this.getSubjectIdsReachableFrom(ctx, v, subjectType),
      ),
    ]);

    return candidates.filter((c) =>
      viaSets.every((viaSet) => viaSet.has(c.subjectId)),
    );
  }

  /**
   * List subjects that have a specific relation with an object, filtered to only
   * those whose access goes through ALL of the specified intermediate entities.
   *
   * Example: "List all users who are admins of device D through system Y"
   * ```ts
   * const users = await zbar.listSubjectsWithRelationVia(ctx,
   *   'user',
   *   'admin',
   *   { type: 'device', id: 'device1' },
   *   [{ type: 'system', id: 'system1' }],
   * );
   * ```
   */
  async listSubjectsWithRelationVia<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
    ViaType extends keyof Schema["entities"] & string,
    Relation extends EntityRelations<Schema, ObjectType>,
  >(
    ctx: QueryCtx | ActionCtx,
    subjectType: SubjectType,
    relation: Relation,
    object: { type: ObjectType; id: string },
    via: Array<{ type: ViaType; id: string }>,
    requestContext?: Data,
  ): Promise<Array<{ subjectId: string }>> {
    if (via.length === 0) {
      return this.listSubjectsWithRelation(
        ctx,
        subjectType,
        relation,
        object,
        requestContext,
      );
    }

    const [candidates, ...viaSets] = await Promise.all([
      this.listSubjectsWithRelation(
        ctx,
        subjectType,
        relation,
        object,
        requestContext,
      ),
      ...via.map((v) =>
        this.getSubjectIdsReachableFrom(ctx, v, subjectType),
      ),
    ]);

    return candidates.filter((c) =>
      viaSets.every((viaSet) => viaSet.has(c.subjectId)),
    );
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
