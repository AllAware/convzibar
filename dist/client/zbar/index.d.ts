import type { ActionCtx, MutationCtx, QueryCtx } from "../internal";
import type { EntityPermissions, EntityRelations, ResolvedProperties, SchemaConditions, ZbarSchema } from "../types";
import type { ListDirectInitial } from "../list-direct/types";
import type { ListInitial } from "../list/types";
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
export declare function createZbar<Schema extends ZbarSchema<Data>, Data = any>(component: any, options: ZbarOptions<Schema>): Zbar<Schema, Data>;
export declare class Zbar<Schema extends ZbarSchema<Data>, Data = any> {
    component: any;
    private options;
    /**
     * Internal mutable state shared with helper modules and query builders.
     * Held in a single bundle so helpers can be plain functions instead of
     * methods reaching into a `this` reference.
     */
    private _internal;
    constructor(component: any, options: ZbarOptions<Schema>);
    /**
     * The compiled graph configuration. Exposed for advanced use cases (and a
     * handful of tests) that need to inspect or tweak runtime parameters such
     * as `maxChunkSize` or `mockWorkpool`. Mutations are reflected immediately
     * because the Zbar instance and its helpers share the same reference.
     */
    get graphConfig(): import("../../component/types").GraphConfig;
    withTenant(tenantId: string): Zbar<Schema, Data>;
    /**
     * Determine if a subject has a specific relationship with an object.
     *
     * Plan-driven: compiles a `Union(ValidatedMaterialised, RT)` plan and
     * evaluates its `check`. One path for both materialised + RT answers —
     * no hand-rolled "try materialised, fall back to RT" scaffolding.
     */
    hasRelationship<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string, Relation extends EntityRelations<Schema, ObjectType>>(ctx: QueryCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, relation: Relation, object: {
        type: ObjectType;
        id: string;
    }, requestContext?: Data): Promise<boolean>;
    can<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string, Permission extends EntityPermissions<Schema, ObjectType>>(ctx: QueryCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, permission: Permission, object: {
        type: ObjectType;
        id: string;
    }, requestContext?: Data): Promise<boolean>;
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
    getPermissions<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string>(ctx: QueryCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, object: {
        type: ObjectType;
        id: string;
    }, requestContext?: Data): Promise<Array<EntityPermissions<Schema, ObjectType>>>;
    /**
     * Asserts that a subject has a specific permission on an object, throwing a PermissionError if denied.
     */
    require<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string, Permission extends EntityPermissions<Schema, ObjectType>>(ctx: QueryCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, permission: Permission, object: {
        type: ObjectType;
        id: string;
    }, requestContext?: Data): Promise<void>;
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
    list(): ListInitial<Schema, Data>;
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
    listDirect(): ListDirectInitial<Schema, Data>;
    /** Shared fields carried on every mutation payload. */
    private _commonWriteArgs;
    /** Normalise the options object into a ready-to-ship write payload slice. */
    private _optionsToArgs;
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
    addRelation<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string, Relation extends EntityRelations<Schema, ObjectType>>(ctx: MutationCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, relation: Relation, object: {
        type: ObjectType;
        id: string;
    }, options?: {
        condition?: SchemaConditions<Schema>;
        conditionContext?: unknown;
        createdBy?: string;
        properties?: ResolvedProperties<Schema, ObjectType, Relation & string> extends undefined ? never : ResolvedProperties<Schema, ObjectType, Relation & string>;
    }): Promise<string>;
    /**
     * Update a relationship between a subject and an object to a new relation, executed atomically via Add-Before-Remove.
     */
    updateRelation<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string, OldRelation extends EntityRelations<Schema, ObjectType>, NewRelation extends EntityRelations<Schema, ObjectType>>(ctx: MutationCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, oldRelation: OldRelation, newRelation: NewRelation, object: {
        type: ObjectType;
        id: string;
    }, options?: {
        condition?: SchemaConditions<Schema>;
        conditionContext?: unknown;
        createdBy?: string;
        properties?: ResolvedProperties<Schema, ObjectType, NewRelation & string> extends undefined ? never : ResolvedProperties<Schema, ObjectType, NewRelation & string>;
    }): Promise<string>;
    /**
     * Add a relationship between a subject and an object, clearing any existing relationships between them atomically.
     */
    setRelation<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string, Relation extends EntityRelations<Schema, ObjectType>>(ctx: MutationCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, relation: Relation, object: {
        type: ObjectType;
        id: string;
    }, options?: {
        condition?: SchemaConditions<Schema>;
        conditionContext?: unknown;
        createdBy?: string;
        properties?: ResolvedProperties<Schema, ObjectType, Relation & string> extends undefined ? never : ResolvedProperties<Schema, ObjectType, Relation & string>;
    }): Promise<string>;
    /**
     * Remove a relationship between a subject and an object.
     */
    removeRelation<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string, Relation extends EntityRelations<Schema, ObjectType>>(ctx: MutationCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, relation: Relation, object: {
        type: ObjectType;
        id: string;
    }, actorId?: string): Promise<boolean>;
    /**
     * Delete an entity and all its associated relationships (both as subject and object).
     */
    deleteEntity<EntityType extends keyof Schema["entities"] & string>(ctx: MutationCtx | ActionCtx, entity: {
        type: EntityType;
        id: string;
    }, actorId?: string): Promise<{
        relationshipsRemoved: number;
        effectiveRelationshipsRemoved: number;
    }>;
}
//# sourceMappingURL=index.d.ts.map