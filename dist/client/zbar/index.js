import { CONFIG_UNREGISTERED_MARKER } from "../../component/config";
import { parseSchemaToGraphConfig } from "../../component/helpers";
import { PermissionError } from "../types";
import { ListDirectQueryBuilder } from "../list-direct/builder";
import { ListQueryBuilder } from "../list/builder";
import { resolvePermissionRelations, resolveRelationInheritance, } from "./resolvers";
import { evaluateManyPermissions, planRelation } from "./traversal";
import { validateProperties, validateRelationParameter, } from "./validation";
// ---------------------------------------------------------------------------
// Stable content hash of the compiled config — lets mutations ship a short
// hash instead of the full rule set (the component stores config by hash).
// ---------------------------------------------------------------------------
function stableStringify(v) {
    if (v === null || typeof v !== "object")
        return JSON.stringify(v);
    if (Array.isArray(v))
        return "[" + v.map(stableStringify).join(",") + "]";
    const keys = Object.keys(v).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}
function fnv1a(s, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
}
function hashGraphConfig(config) {
    const s = stableStringify(config);
    // Two FNV-1a passes with different offset bases → 64-bit-ish identity.
    return "cfg_" + fnv1a(s, 0x811c9dc5) + fnv1a(s, 0x01000193);
}
/** Whether an error from a component mutation is the unregistered-config throw. */
function isConfigUnregisteredError(error) {
    return (error instanceof Error && error.message.includes(CONFIG_UNREGISTERED_MARKER));
}
/**
 * Create a new Zbar client instance.
 */
export function createZbar(component, options) {
    return new Zbar(component, options);
}
export class Zbar {
    component;
    options;
    _internal;
    /** Whether this instance has registered its config with the component yet. */
    _configRegistered = false;
    constructor(component, options) {
        this.component = component;
        this.options = options;
        const graphConfig = parseSchemaToGraphConfig(options.schema);
        if (options.maxWriteDepth !== undefined) {
            graphConfig.maxWriteDepth = options.maxWriteDepth;
        }
        this.options.asyncWrites = options.asyncWrites ?? true;
        this._internal = {
            component,
            schema: options.schema,
            asyncWrites: this.options.asyncWrites,
            graphConfig,
            configHash: hashGraphConfig(graphConfig),
            readTimeChainDepth: options.readTimeChainDepth ?? 3,
            permissionRelationsCache: new Map(),
        };
    }
    /**
     * The compiled graph configuration. Exposed for advanced use cases and a
     * handful of tests that inspect or tweak runtime parameters such as
     * `maxChunkSize` or `mockWorkpool`.
     */
    get graphConfig() {
        return this._internal.graphConfig;
    }
    /** Stable content hash of the compiled config (mutations ship this). */
    get configHash() {
        return this._internal.configHash;
    }
    /**
     * Determine if a subject has a specific relationship with an object.
     */
    async hasRelationship(ctx, subject, relation, object) {
        const z = this._internal;
        const targets = resolveRelationInheritance(z, object.type, relation);
        if (targets.length === 0)
            return false;
        return planRelation(z, object.type, targets).check(ctx, subject, object);
    }
    async can(ctx, subject, permission, object) {
        const z = this._internal;
        const targets = resolvePermissionRelations(z, object.type, permission);
        if (targets.length === 0)
            return false;
        return planRelation(z, object.type, targets).check(ctx, subject, object);
    }
    /**
     * Return every permission the subject currently holds on the object,
     * resolved in one materialised query plus at most one shared RT branch per
     * unique derived relation. Declaration order is preserved.
     */
    async getPermissions(ctx, subject, object) {
        const z = this._internal;
        const permissions = Object.keys(z.schema.entities[object.type]?.permissions || {});
        if (permissions.length === 0)
            return [];
        const perms = permissions.map((permission) => ({
            permission: permission,
            targets: resolvePermissionRelations(z, object.type, permission),
        }));
        const granted = await evaluateManyPermissions(z, ctx, subject, object, perms);
        return granted;
    }
    /**
     * Asserts that a subject has a permission on an object, throwing a
     * PermissionError if denied.
     */
    async require(ctx, subject, permission, object) {
        if (!(await this.can(ctx, subject, permission, object))) {
            throw new PermissionError(`Permission denied: ${permission} on ${object.type}:${object.id}`);
        }
    }
    /** Fluent query builder for listing objects or subjects. */
    list() {
        return new ListQueryBuilder(this._internal);
    }
    /** Fluent query builder for listing **direct** (base) relationships. */
    listDirect() {
        return new ListDirectQueryBuilder(this._internal);
    }
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
    async _runWrite(ctx, mutationRef, payload) {
        const z = this._internal;
        const attempt = (withConfig) => ctx.runMutation(mutationRef, {
            ...payload,
            configHash: z.configHash,
            graphConfig: withConfig ? z.graphConfig : undefined,
            asyncWrites: z.asyncWrites,
        });
        let result;
        if (!this._configRegistered) {
            result = await attempt(true);
        }
        else {
            try {
                result = await attempt(false);
            }
            catch (error) {
                if (!isConfigUnregisteredError(error))
                    throw error;
                result = await attempt(true);
            }
        }
        this._configRegistered = true;
        return result;
    }
    /**
     * Add a relationship between a subject and an object. If the relation has
     * schema-defined properties, pass them via `options.properties`.
     */
    async addRelation(ctx, subject, relation, object, options) {
        const z = this._internal;
        validateRelationParameter(z, subject, relation, object);
        if (options?.properties !== undefined) {
            validateProperties(z, object.type, relation, options.properties);
        }
        return this._runWrite(ctx, this.component.mutations.addRelation, {
            subject,
            relation,
            object,
            properties: options?.properties,
        });
    }
    /**
     * Update a relationship to a new relation, executed atomically via
     * Add-Before-Remove.
     */
    async updateRelation(ctx, subject, oldRelation, newRelation, object, options) {
        const z = this._internal;
        validateRelationParameter(z, subject, oldRelation, object);
        validateRelationParameter(z, subject, newRelation, object);
        if (options?.properties !== undefined) {
            validateProperties(z, object.type, newRelation, options.properties);
        }
        return this._runWrite(ctx, this.component.mutations.updateRelation, {
            subject,
            oldRelation,
            newRelation,
            object,
            properties: options?.properties,
        });
    }
    /**
     * Add a relationship, clearing any existing relationships between the
     * subject and object atomically.
     */
    async setRelation(ctx, subject, relation, object, options) {
        const z = this._internal;
        validateRelationParameter(z, subject, relation, object);
        if (options?.properties !== undefined) {
            validateProperties(z, object.type, relation, options.properties);
        }
        const objectRelations = Object.keys(z.schema.entities[object.type]?.relations || {});
        return this._runWrite(ctx, this.component.mutations.setRelation, {
            subject,
            relation,
            object,
            objectRelations,
            properties: options?.properties,
        });
    }
    /** Remove a relationship between a subject and an object. */
    async removeRelation(ctx, subject, relation, object) {
        const z = this._internal;
        validateRelationParameter(z, subject, relation, object);
        return this._runWrite(ctx, this.component.mutations.removeRelation, {
            subject,
            relation,
            object,
        });
    }
    /** Delete an entity and all its associated relationships. */
    async deleteEntity(ctx, entity) {
        return this._runWrite(ctx, this.component.mutations.deleteEntity, {
            entity,
        });
    }
}
//# sourceMappingURL=index.js.map