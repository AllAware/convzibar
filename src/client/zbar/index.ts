import { parseSchemaToGraphConfig } from "../../component/helpers";
import type { ZbarInternal, ActionCtx, MutationCtx, QueryCtx } from "../internal";
import type {
  EntityPermissions,
  EntityRelations,
  ResolvedProperties,
  SchemaConditions,
  ZbarSchema,
} from "../types";
import { PermissionError } from "../types";
import { ListDirectQueryBuilder } from "../list-direct/builder";
import type { ListDirectInitial } from "../list-direct/types";
import { ListQueryBuilder } from "../list/builder";
import type { ListInitial } from "../list/types";
import {
  resolvePermissionRelations,
  resolveRelationInheritance,
} from "./resolvers";
import { evaluateReadTimePaths } from "./read-time";
import {
  validatePath,
  validateProperties,
  validateRelationParameter,
} from "./validation";

export interface ZbarOptions<Schema extends ZbarSchema<any>> {
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
}

/**
 * Create a new Zbar client instance.
 * @param component The imported convzibar component
 * @param options Configuration options
 * @returns Zbar client
 */
export function createZbar<Schema extends ZbarSchema<Data>, Data = any>(
  component: any,
  options: ZbarOptions<Schema>,
) {
  return new Zbar<Schema, Data>(component, options);
}

export class Zbar<Schema extends ZbarSchema<Data>, Data = any> {
  /**
   * Internal mutable state shared with helper modules and query builders.
   * Held in a single bundle so helpers can be plain functions instead of
   * methods reaching into a `this` reference.
   */
  private _internal: ZbarInternal;

  constructor(
    public component: any,
    private options: ZbarOptions<Schema>,
  ) {
    const graphConfig = parseSchemaToGraphConfig(options.schema);
    if (options.maxWriteDepth !== undefined) {
      graphConfig.maxWriteDepth = options.maxWriteDepth;
    }
    this.options.enableAuditLog = options.enableAuditLog ?? true;
    this.options.asyncWrites = options.asyncWrites ?? true;

    this._internal = {
      component,
      schema: options.schema,
      tenantId: options.tenantId,
      defaultActorId: options.defaultActorId,
      enableAuditLog: this.options.enableAuditLog,
      asyncWrites: this.options.asyncWrites,
      graphConfig,
      readTimeChainDepth: options.readTimeChainDepth ?? 3,
      permissionRelationsCache: new Map(),
    };
  }

  /**
   * The compiled graph configuration. Exposed for advanced use cases (and a
   * handful of tests) that need to inspect or tweak runtime parameters such
   * as `maxChunkSize` or `mockWorkpool`. Mutations are reflected immediately
   * because the Zbar instance and its helpers share the same reference.
   */
  get graphConfig() {
    return this._internal.graphConfig;
  }

  withTenant(tenantId: string): Zbar<Schema, Data> {
    return new Zbar<Schema, Data>(this.component, {
      ...this.options,
      tenantId,
    });
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
    const z = this._internal;
    const targets = resolveRelationInheritance(z, object.type, relation);
    if (targets.length === 0) return false;

    const acceptableRelations = targets.map((t) => t.relation);

    const effectiveRels = await ctx.runQuery(
      this.component.queries.checkPermissionFast,
      {
        tenantId: z.tenantId,
        subject,
        relations: acceptableRelations,
        object,
      },
    );

    for (const eff of effectiveRels) {
      const targetDef = targets.find((t) => t.relation === eff.relation);

      for (const path of eff.paths) {
        const isValid = await validatePath(
          z,
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

    return evaluateReadTimePaths(
      z,
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
    const z = this._internal;
    const targets = resolvePermissionRelations(z, object.type, permission);
    if (targets.length === 0) return false;

    const acceptableRelations = targets.map((t) => t.relation);

    const effectiveRels = await ctx.runQuery(
      this.component.queries.checkPermissionFast,
      {
        tenantId: z.tenantId,
        subject,
        relations: acceptableRelations,
        object,
      },
    );

    for (const eff of effectiveRels) {
      const targetDef = targets.find((t) => t.relation === eff.relation);

      for (const path of eff.paths) {
        const isValid = await validatePath(
          z,
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

    return evaluateReadTimePaths(
      z,
      ctx,
      subject,
      object,
      acceptableRelations,
    );
  }

  /**
   * Return every permission the subject currently holds on the object.
   *
   * Enumerates all permissions declared on `object.type` in the schema,
   * expands each to the set of relations that satisfies it, then issues a
   * **single** `checkPermissionFast` query for the union of those relations.
   * Effective relationships are mapped back to the owning permissions and
   * validated against any conditions. Permissions not satisfied by the
   * materialised graph fall back to read-time path evaluation.
   *
   * The returned array is typed as the literal union of permission names
   * for that object type, so callers get autocomplete and narrowing.
   *
   * ```ts
   * const perms = await zbar.getPermissions(ctx, user, device);
   * // perms: Array<"view" | "edit" | "delete" | ...>
   * ```
   */
  async getPermissions<
    SubjectType extends keyof Schema["entities"] & string,
    ObjectType extends keyof Schema["entities"] & string,
  >(
    ctx: QueryCtx | ActionCtx,
    subject: { type: SubjectType; id: string },
    object: { type: ObjectType; id: string },
    requestContext?: Data,
  ): Promise<Array<EntityPermissions<Schema, ObjectType>>> {
    const z = this._internal;
    const permissions = Object.keys(
      z.schema.entities[object.type]?.permissions || {},
    ) as Array<EntityPermissions<Schema, ObjectType>>;
    if (permissions.length === 0) return [];

    const permTargets = new Map<
      string,
      Array<{ relation: string; condition?: string }>
    >();
    const allRelations = new Set<string>();
    for (const p of permissions) {
      const targets = resolvePermissionRelations(z, object.type, p);
      permTargets.set(p, targets);
      for (const t of targets) allRelations.add(t.relation);
    }
    if (allRelations.size === 0) return [];

    const effectiveRels: any[] = await ctx.runQuery(
      this.component.queries.checkPermissionFast,
      {
        tenantId: z.tenantId,
        subject,
        relations: [...allRelations],
        object,
      },
    );

    const effByRelation = new Map<string, any>();
    for (const eff of effectiveRels) effByRelation.set(eff.relation, eff);

    const granted = new Set<string>();
    const needsRT: Array<{ permission: string; relations: string[] }> = [];

    await Promise.all(
      permissions.map(async (permission) => {
        const targets = permTargets.get(permission)!;
        for (const target of targets) {
          const eff = effByRelation.get(target.relation);
          if (!eff) continue;
          for (const path of eff.paths) {
            const isValid = await validatePath(
              z,
              path,
              target,
              ctx,
              subject,
              object,
              permission,
              requestContext,
            );
            if (isValid) {
              granted.add(permission);
              return;
            }
          }
        }
        needsRT.push({
          permission,
          relations: targets.map((t) => t.relation),
        });
      }),
    );

    const rtPaths = z.graphConfig.readTimePaths;
    if (rtPaths && rtPaths.length > 0 && needsRT.length > 0) {
      const rtResults = await Promise.all(
        needsRT.map(async ({ permission, relations }) => {
          const ok = await evaluateReadTimePaths(
            z,
            ctx,
            subject,
            object,
            relations,
          );
          return ok ? permission : null;
        }),
      );
      for (const p of rtResults) if (p !== null) granted.add(p);
    }

    return permissions.filter((p) => granted.has(p));
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
    return new ListQueryBuilder<Schema, Data>(this._internal) as any;
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
    return new ListDirectQueryBuilder(this._internal) as any;
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
    const z = this._internal;
    validateRelationParameter(z, subject, relation, object);

    if (options?.properties !== undefined) {
      validateProperties(z, object.type, relation, options.properties);
    }

    return ctx.runMutation(this.component.mutations.addRelation, {
      tenantId: z.tenantId,
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
      createdBy: options?.createdBy ?? z.defaultActorId,
      graphConfig: z.graphConfig,
      enableAuditLog: z.enableAuditLog,
      asyncWrites: z.asyncWrites,
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
    const z = this._internal;
    validateRelationParameter(z, subject, oldRelation as string, object);
    validateRelationParameter(z, subject, newRelation as string, object);

    if (options?.properties !== undefined) {
      validateProperties(z, object.type, newRelation as string, options.properties);
    }

    return ctx.runMutation(this.component.mutations.updateRelation, {
      tenantId: z.tenantId,
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
      createdBy: options?.createdBy ?? z.defaultActorId,
      graphConfig: z.graphConfig,
      enableAuditLog: z.enableAuditLog,
      asyncWrites: z.asyncWrites,
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
    const z = this._internal;
    validateRelationParameter(z, subject, relation, object);

    if (options?.properties !== undefined) {
      validateProperties(z, object.type, relation, options.properties);
    }

    const objectRelations = Object.keys(
      z.schema.entities[object.type]?.relations || {},
    );

    return ctx.runMutation(this.component.mutations.setRelation, {
      tenantId: z.tenantId,
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
      createdBy: options?.createdBy ?? z.defaultActorId,
      graphConfig: z.graphConfig,
      enableAuditLog: z.enableAuditLog,
      asyncWrites: z.asyncWrites,
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
    const z = this._internal;
    validateRelationParameter(z, subject, relation, object);

    return ctx.runMutation(this.component.mutations.removeRelation, {
      tenantId: z.tenantId,
      subject,
      relation,
      object,
      actorId: actorId ?? z.defaultActorId,
      graphConfig: z.graphConfig,
      enableAuditLog: z.enableAuditLog,
      asyncWrites: z.asyncWrites,
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
    const z = this._internal;
    return ctx.runMutation(this.component.mutations.deleteEntity, {
      tenantId: z.tenantId,
      entity,
      actorId: actorId ?? z.defaultActorId,
      graphConfig: z.graphConfig,
      enableAuditLog: z.enableAuditLog,
      asyncWrites: z.asyncWrites,
    });
  }
}
