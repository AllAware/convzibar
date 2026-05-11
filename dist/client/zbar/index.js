import { parseSchemaToGraphConfig } from "../../component/helpers";
import { PermissionError } from "../types";
import { ListDirectQueryBuilder } from "../list-direct/builder";
import { ListQueryBuilder } from "../list/builder";
import { resolvePermissionRelations, resolveRelationInheritance, } from "./resolvers";
import { evaluateManyPermissions, planRelation } from "./traversal";
import { validateProperties, validateRelationParameter, } from "./validation";
/**
 * Create a new Zbar client instance.
 * @param component The imported convzibar component
 * @param options Configuration options
 * @returns Zbar client
 */
export function createZbar(component, options) {
    return new Zbar(component, options);
}
export class Zbar {
    component;
    options;
    /**
     * Internal mutable state shared with helper modules and query builders.
     * Held in a single bundle so helpers can be plain functions instead of
     * methods reaching into a `this` reference.
     */
    _internal;
    constructor(component, options) {
        this.component = component;
        this.options = options;
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
    withTenant(tenantId) {
        return new Zbar(this.component, {
            ...this.options,
            tenantId,
        });
    }
    /**
     * Determine if a subject has a specific relationship with an object.
     *
     * Plan-driven: compiles a `Union(ValidatedMaterialised, RT)` plan and
     * evaluates its `check`. One path for both materialised + RT answers —
     * no hand-rolled "try materialised, fall back to RT" scaffolding.
     */
    async hasRelationship(ctx, subject, relation, object, requestContext) {
        const z = this._internal;
        const targets = resolveRelationInheritance(z, object.type, relation);
        if (targets.length === 0)
            return false;
        const plan = planRelation(z, object.type, targets, relation, requestContext);
        return plan.check(ctx, subject, object);
    }
    async can(ctx, subject, permission, object, requestContext) {
        const z = this._internal;
        const targets = resolvePermissionRelations(z, object.type, permission);
        if (targets.length === 0)
            return false;
        const plan = planRelation(z, object.type, targets, permission, requestContext);
        return plan.check(ctx, subject, object);
    }
    /**
     * Return every permission the subject currently holds on the object.
     *
     * Delegates to `evaluateManyPermissions`, the minimum-work multi-
     * permission evaluator: a single materialised query covers every
     * target relation on the schema, and each permission's RT fallback is
     * a parallel RT-branch plan on only the relations the materialised
     * branch didn't resolve. Declaration order is preserved.
     *
     * ```ts
     * const perms = await zbar.getPermissions(ctx, user, device);
     * // perms: Array<"view" | "edit" | "delete" | ...>
     * ```
     */
    async getPermissions(ctx, subject, object, requestContext) {
        const z = this._internal;
        const permissions = Object.keys(z.schema.entities[object.type]?.permissions || {});
        if (permissions.length === 0)
            return [];
        const perms = permissions.map((permission) => ({
            permission: permission,
            targets: resolvePermissionRelations(z, object.type, permission),
        }));
        const granted = await evaluateManyPermissions(z, ctx, subject, object, perms, requestContext);
        // `evaluateManyPermissions` already preserves input order — just narrow
        // back to the typed literal union so callers get autocomplete.
        return granted;
    }
    /**
     * Asserts that a subject has a specific permission on an object, throwing a PermissionError if denied.
     */
    async require(ctx, subject, permission, object, requestContext) {
        const allowed = await this.can(ctx, subject, permission, object, requestContext);
        if (!allowed) {
            throw new PermissionError(`Permission denied: ${permission} on ${object.type}:${object.id}`);
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
    list() {
        return new ListQueryBuilder(this._internal);
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
    listDirect() {
        return new ListDirectQueryBuilder(this._internal);
    }
    /** Shared fields carried on every mutation payload. */
    _commonWriteArgs(actorOverride) {
        const z = this._internal;
        return {
            tenantId: z.tenantId,
            createdBy: actorOverride ?? z.defaultActorId,
            graphConfig: z.graphConfig,
            enableAuditLog: z.enableAuditLog,
            asyncWrites: z.asyncWrites,
        };
    }
    /** Normalise the options object into a ready-to-ship write payload slice. */
    _optionsToArgs(options) {
        return {
            condition: options?.condition
                ? {
                    condition: options.condition,
                    conditionContext: options.conditionContext,
                }
                : undefined,
            properties: options?.properties,
            ...this._commonWriteArgs(options?.createdBy),
        };
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
    async addRelation(ctx, subject, relation, object, options) {
        const z = this._internal;
        validateRelationParameter(z, subject, relation, object);
        if (options?.properties !== undefined) {
            validateProperties(z, object.type, relation, options.properties);
        }
        return ctx.runMutation(this.component.mutations.addRelation, {
            subject,
            relation,
            object,
            ...this._optionsToArgs(options),
        });
    }
    /**
     * Update a relationship between a subject and an object to a new relation, executed atomically via Add-Before-Remove.
     */
    async updateRelation(ctx, subject, oldRelation, newRelation, object, options) {
        const z = this._internal;
        validateRelationParameter(z, subject, oldRelation, object);
        validateRelationParameter(z, subject, newRelation, object);
        if (options?.properties !== undefined) {
            validateProperties(z, object.type, newRelation, options.properties);
        }
        return ctx.runMutation(this.component.mutations.updateRelation, {
            subject,
            oldRelation,
            newRelation,
            object,
            ...this._optionsToArgs(options),
        });
    }
    /**
     * Add a relationship between a subject and an object, clearing any existing relationships between them atomically.
     */
    async setRelation(ctx, subject, relation, object, options) {
        const z = this._internal;
        validateRelationParameter(z, subject, relation, object);
        if (options?.properties !== undefined) {
            validateProperties(z, object.type, relation, options.properties);
        }
        const objectRelations = Object.keys(z.schema.entities[object.type]?.relations || {});
        return ctx.runMutation(this.component.mutations.setRelation, {
            subject,
            relation,
            object,
            objectRelations,
            ...this._optionsToArgs(options),
        });
    }
    /**
     * Remove a relationship between a subject and an object.
     */
    async removeRelation(ctx, subject, relation, object, actorId) {
        const z = this._internal;
        validateRelationParameter(z, subject, relation, object);
        const { tenantId, graphConfig, enableAuditLog, asyncWrites } = this._commonWriteArgs();
        return ctx.runMutation(this.component.mutations.removeRelation, {
            tenantId,
            subject,
            relation,
            object,
            actorId: actorId ?? z.defaultActorId,
            graphConfig,
            enableAuditLog,
            asyncWrites,
        });
    }
    /**
     * Delete an entity and all its associated relationships (both as subject and object).
     */
    async deleteEntity(ctx, entity, actorId) {
        const z = this._internal;
        const { tenantId, graphConfig, enableAuditLog, asyncWrites } = this._commonWriteArgs();
        return ctx.runMutation(this.component.mutations.deleteEntity, {
            tenantId,
            entity,
            actorId: actorId ?? z.defaultActorId,
            graphConfig,
            enableAuditLog,
            asyncWrites,
        });
    }
}
//# sourceMappingURL=index.js.map