import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
} from "convex/server";
import { parseSchemaToGraphConfig } from "../component/helpers";

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

// Validation types for strict autocomplete inside createAuthSchema
export type ValidateAuthSchema<T extends AuthSchema<any>> = {
  conditions?: T["conditions"];
  entities: {
    [E in keyof T["entities"]]: {
      relations?: {
        [R in keyof T["entities"][E]["relations"]]:
          | (keyof T["entities"] & string)
          | (keyof T["entities"][E]["relations"] & string)
          | `${keyof T["entities"][E]["relations"] & string}.${string}`
          | { type: keyof T["entities"] & string; reverse?: string }
          | {
              relation:
                | (keyof T["entities"][E]["relations"] & string)
                | `${keyof T["entities"][E]["relations"] & string}.${string}`;
              condition: T["conditions"] extends Record<string, any>
                ? keyof T["conditions"] & string
                : never;
            }
          | ReadonlyArray<
              | (keyof T["entities"] & string)
              | (keyof T["entities"][E]["relations"] & string)
              | `${keyof T["entities"][E]["relations"] & string}.${string}`
              | { type: keyof T["entities"] & string; reverse?: string }
              | {
                  relation:
                    | (keyof T["entities"][E]["relations"] & string)
                    | `${keyof T["entities"][E]["relations"] & string}.${string}`;
                  condition: T["conditions"] extends Record<string, any>
                    ? keyof T["conditions"] & string
                    : never;
                }
            >;
      };
      permissions?: {
        [P in keyof T["entities"][E]["permissions"]]: ReadonlyArray<
          | (keyof T["entities"][E]["relations"] & string)
          | {
              relation: keyof T["entities"][E]["relations"] & string;
              condition: T["conditions"] extends Record<string, any>
                ? keyof T["conditions"] & string
                : never;
            }
        >;
      };
    };
  };
};

// ============================================================================
// Helper Functions
// ============================================================================

export function defineEntity<const T extends EntityDefinition>(def: T): T {
  return def;
}

export function createAuthSchema<Data = any>() {
  return function <const T extends AuthSchema<Data>>(
    schema: T & ValidateAuthSchema<T>,
  ): T {
    return schema;
  };
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

// ============================================================================
// Authz Client Class
// ============================================================================

export class Authz<Schema extends AuthSchema<Data>, Data = any> {
  private graphConfig: any;

  constructor(
    public component: any,
    private options: {
      schema: Schema;
      tenantId: string;
      defaultActorId?: string;
      enableAuditLog?: boolean;
    },
  ) {
    this.graphConfig = parseSchemaToGraphConfig(options.schema);
  }

  withTenant(tenantId: string): Authz<Schema, Data> {
    return new Authz<Schema, Data>(this.component, {
      ...this.options,
      tenantId,
    });
  }

  private resolvePermissionRelations(objectType: string, permission: string) {
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
      throw new Error(
        `Permission denied: ${permission} on ${object.type}:${object.id}`,
      );
    }
  }

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

    const results: Array<{ objectId: string }> = [];

    for (const eff of effectiveRels) {
      // Early deduplication optimization: Skip if we already approved this objectId
      if (results.some((r) => r.objectId === eff.objectId)) {
        continue;
      }

      const targetDef = targets.find((t) => t.relation === eff.relation);
      let objectValid = false;

      for (const path of eff.paths) {
        const object = { type: objectType, id: eff.objectId };
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
          objectValid = true;
          break;
        }
      }

      if (objectValid) {
        results.push({ objectId: eff.objectId });
      }
    }

    return results;
  }

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

    const results: Array<{ userId: string }> = [];

    for (const eff of effectiveRels) {
      // Early deduplication optimization: Skip if we already approved this userId
      if (results.some((r) => r.userId === eff.subjectId)) {
        continue;
      }

      const targetDef = targets.find((t) => t.relation === eff.relation);
      let subjectValid = false;

      for (const path of eff.paths) {
        const subject = { type: eff.subjectType, id: eff.subjectId };
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
          subjectValid = true;
          break;
        }
      }

      if (subjectValid) {
        results.push({ userId: eff.subjectId });
      }
    }

    return results;
  }

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
    });
  }

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
    });
  }

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
    });
  }
}
