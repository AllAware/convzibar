import type { GraphConfig } from "../../component/types";
import type { ActionCtx, MutationCtx, QueryCtx } from "../internal";
import type { EntityPermissions, EntityRelations, ResolvedProperties, ZbarSchema } from "../types";
import type { ListDirectInitial } from "../list-direct/types";
import type { ListInitial } from "../list/types";
export interface ZbarOptions<Schema extends ZbarSchema> {
    schema: Schema;
    maxWriteDepth?: number;
    asyncWrites?: boolean;
    /**
     * Maximum recursion depth for chained read-time-relation evaluation.
     * Defaults to 3. Set to 0 to disable chaining (a single RT hop still works).
     */
    readTimeChainDepth?: number;
}
/**
 * Create a new Zbar client instance.
 */
export declare function createZbar<Schema extends ZbarSchema>(component: any, options: ZbarOptions<Schema>): Zbar<Schema>;
export declare class Zbar<Schema extends ZbarSchema> {
    component: any;
    private options;
    private _internal;
    /** Whether this instance has registered its config with the component yet. */
    private _configRegistered;
    constructor(component: any, options: ZbarOptions<Schema>);
    /**
     * The compiled graph configuration. Exposed for advanced use cases and a
     * handful of tests that inspect or tweak runtime parameters such as
     * `maxChunkSize` or `mockWorkpool`.
     */
    get graphConfig(): GraphConfig;
    /** Stable content hash of the compiled config (mutations ship this). */
    get configHash(): string;
    /**
     * Determine if a subject has a specific relationship with an object.
     */
    hasRelationship<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string, Relation extends EntityRelations<Schema, ObjectType>>(ctx: QueryCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, relation: Relation, object: {
        type: ObjectType;
        id: string;
    }): Promise<boolean>;
    can<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string, Permission extends EntityPermissions<Schema, ObjectType>>(ctx: QueryCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, permission: Permission, object: {
        type: ObjectType;
        id: string;
    }): Promise<boolean>;
    /**
     * Return every permission the subject currently holds on the object,
     * resolved in one materialised query plus at most one shared RT branch per
     * unique derived relation. Declaration order is preserved.
     */
    getPermissions<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string>(ctx: QueryCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, object: {
        type: ObjectType;
        id: string;
    }): Promise<Array<EntityPermissions<Schema, ObjectType>>>;
    /**
     * Asserts that a subject has a permission on an object, throwing a
     * PermissionError if denied.
     */
    require<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string, Permission extends EntityPermissions<Schema, ObjectType>>(ctx: QueryCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, permission: Permission, object: {
        type: ObjectType;
        id: string;
    }): Promise<void>;
    /** Fluent query builder for listing objects or subjects. */
    list(): ListInitial<Schema>;
    /** Fluent query builder for listing **direct** (base) relationships. */
    listDirect(): ListDirectInitial<Schema>;
    /**
     * Run a component write mutation, shipping the full compiled config only
     * until the component has registered it (once per instance); thereafter
     * only the hash travels.
     *
     * `_configRegistered` is client-side memory of server-side state, so it can
     * go stale: the registering transaction may roll back after the flag flips
     * (parent mutation throws, OCC retry), or component data may be wiped or
     * restored while a warm isolate still holds this instance. When the
     * component reports the hash unknown, resend the full config once instead
     * of failing every subsequent write from this instance.
     */
    private _runWrite;
    /**
     * Add a relationship between a subject and an object. If the relation has
     * schema-defined properties, pass them via `options.properties`.
     */
    addRelation<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string, Relation extends EntityRelations<Schema, ObjectType>>(ctx: MutationCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, relation: Relation, object: {
        type: ObjectType;
        id: string;
    }, options?: {
        properties?: ResolvedProperties<Schema, ObjectType, Relation & string> extends undefined ? never : ResolvedProperties<Schema, ObjectType, Relation & string>;
    }): Promise<string>;
    /**
     * Update a relationship to a new relation, executed atomically via
     * Add-Before-Remove.
     */
    updateRelation<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string, OldRelation extends EntityRelations<Schema, ObjectType>, NewRelation extends EntityRelations<Schema, ObjectType>>(ctx: MutationCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, oldRelation: OldRelation, newRelation: NewRelation, object: {
        type: ObjectType;
        id: string;
    }, options?: {
        properties?: ResolvedProperties<Schema, ObjectType, NewRelation & string> extends undefined ? never : ResolvedProperties<Schema, ObjectType, NewRelation & string>;
    }): Promise<string>;
    /**
     * Add a relationship, clearing any existing relationships between the
     * subject and object atomically.
     */
    setRelation<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string, Relation extends EntityRelations<Schema, ObjectType>>(ctx: MutationCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, relation: Relation, object: {
        type: ObjectType;
        id: string;
    }, options?: {
        properties?: ResolvedProperties<Schema, ObjectType, Relation & string> extends undefined ? never : ResolvedProperties<Schema, ObjectType, Relation & string>;
    }): Promise<string>;
    /** Remove a relationship between a subject and an object. */
    removeRelation<SubjectType extends keyof Schema["entities"] & string, ObjectType extends keyof Schema["entities"] & string, Relation extends EntityRelations<Schema, ObjectType>>(ctx: MutationCtx | ActionCtx, subject: {
        type: SubjectType;
        id: string;
    }, relation: Relation, object: {
        type: ObjectType;
        id: string;
    }): Promise<boolean>;
    /** Delete an entity and all its associated relationships. */
    deleteEntity<EntityType extends keyof Schema["entities"] & string>(ctx: MutationCtx | ActionCtx, entity: {
        type: EntityType;
        id: string;
    }): Promise<{
        relationshipsRemoved: number;
        effectiveRelationshipsRemoved: number;
    }>;
}
//# sourceMappingURL=index.d.ts.map