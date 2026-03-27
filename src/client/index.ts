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
  | Array<
      | string
      | { type: string; reverse?: string }
      | { relation: string; condition: string }
    >;

export interface EntityDefinition {
  relations?: Record<string, SchemaRelation>;
  permissions?: Record<
    string,
    Array<string | { relation: string; condition: string }>
  >;
}

export interface AuthSchema<Data = any> {
  conditions?: Record<string, ConditionFunction<Data>>;
  entities: Record<string, EntityDefinition>;
}

export type BuiltAuthSchema<
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

  relation<RelName extends string, Target extends keyof Entities & string>(
    name: RelName,
    ...targets: Array<
      | Target
      | keyof Relations
      | {
          [K in keyof Relations &
            string]: `${K}.${keyof Entities[Relations[K]]["relations"] & string}`;
        }[keyof Relations & string]
      | { type: Target; reverse?: string }
      | {
          relation:
            | keyof Relations
            | {
                [K in keyof Relations &
                  string]: `${K}.${keyof Entities[Relations[K]]["relations"] & string}`;
              }[keyof Relations & string];
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

  build(): BuiltAuthSchema<Data, Conditions, Entities> {
    return this._schema;
  }
}

export function createAuthSchema<Data = any>() {
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
  Schema extends AuthSchema,
  ObjectType extends keyof Schema["entities"],
> = Schema["entities"][ObjectType] extends { permissions: infer P }
  ? keyof P & string
  : never;

export type EntityRelations<
  Schema extends AuthSchema,
  ObjectType extends keyof Schema["entities"],
> = Schema["entities"][ObjectType] extends { relations: infer R }
  ? keyof R & string
  : never;

export type SchemaConditions<Schema extends AuthSchema<any>> = Schema extends {
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
// Factory Function
// ============================================================================

/**
 * Create a new Authz client instance.
 * @param component The imported convex_rebac component
 * @param options Configuration options
 * @returns Authz client
 */
export function createAuthz<Schema extends AuthSchema<Data>, Data = any>(
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
  return new Authz<Schema, Data>(component, options);
}

export class Authz<Schema extends AuthSchema<Data>, Data = any> {
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

  withTenant(tenantId: string): Authz<Schema, Data> {
    return new Authz<Schema, Data>(this.component, {
      ...this.options,
      tenantId,
    });
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
   * Determine if a subject has a specific permission on an object.
   */
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
    for (const eff of effectiveRels) {
      const id = getId(eff);
      if (results.some((r: any) => r.id === id)) continue;

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
      if (valid) results.push({ id } as T);
    }
    return results;
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
   * Retrieve a list of subjects that have a specific permission on an object.
   */
  async listUsersWithAccess<
    ObjectType extends keyof Schema["entities"] & string,
    Permission extends EntityPermissions<Schema, ObjectType>,
  >(
    ctx: QueryCtx | ActionCtx,
    object: { type: ObjectType; id: string },
    permission: Permission,
    requestContext?: Data,
  ): Promise<Array<{ userId: string }>> {
    const targets = this.resolvePermissionRelations(object.type, permission);
    if (targets.length === 0) return [];

    const acceptableRelations = targets.map((t) => t.relation);

    const effectiveRels = await ctx.runQuery(
      this.component.queries.listUsersWithAccessFast,
      {
        tenantId: this.options.tenantId,
        object,
        relations: acceptableRelations,
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

    return results.map((r) => ({ userId: r.id }));
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
