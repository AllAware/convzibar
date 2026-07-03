export class EntityBuilder {
    def = { relations: {}, permissions: {}, propertyValidators: {} };
    /**
     * When true, `.relation()` merges new targets into existing relation
     * definitions instead of overwriting them. Set by `SchemaBuilder.extend()`.
     */
    _mergeMode = false;
    // Implementation
    relation(name, ...targets) {
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
            const merged = [...existingArr];
            for (const t of newArr) {
                const isDuplicate = merged.some((m) => typeof t === "string" && typeof m === "string" ? t === m
                    : typeof t === "object" && typeof m === "object" && t !== null && m !== null
                        ? JSON.stringify(t) === JSON.stringify(m)
                        : false);
                if (!isDuplicate) {
                    merged.push(t);
                }
            }
            this.def.relations[name] = merged.length === 1 ? merged[0] : merged;
        }
        else {
            this.def.relations[name] = newValue;
        }
        return this;
    }
    permission(name, ...targets) {
        this.def.permissions[name] = targets;
        return this;
    }
    /**
     * Define typed properties for a relation using Convex validators.
     *
     * Properties are stored on direct edges and returned by `.listDirect()`.
     * They are validated at write-time by the client before being persisted.
     */
    properties(relation, validators) {
        this.def.propertyValidators[relation] = validators;
        return this;
    }
    /**
     * Declare a path that should be evaluated at **read time** rather than
     * materialised at write time. Read-time paths produce **no** traversal
     * rules; `can()` and `list()` evaluate them on demand using 2–3 indexed
     * queries.
     *
     * Two path forms are supported:
     *   1. Dot-path `'source.target'` — follow the local `source` relation to
     *      an intermediate entity, then pick up its `target` relation.
     *   2. Userset `'type#target'` — when a subject of `type` is assigned to
     *      the derived relation, expand through that entity's `target` relation
     *      at read time. The derived relation must declare `type` as a typed
     *      target.
     */
    readTimeRelation(derivedRelation, ...paths) {
        for (const path of paths) {
            if (!path.includes(".") && !path.includes("#")) {
                throw new Error(`Zbar Schema Error: readTimeRelation requires a dot-path ('source.target') or a userset ('type#target'). Got '${path}'.`);
            }
            if (path.includes(".") && path.includes("#")) {
                throw new Error(`Zbar Schema Error: readTimeRelation path '${path}' mixes '.' and '#'; use exactly one.`);
            }
            this.def.readTimeRelations = this.def.readTimeRelations ?? [];
            this.def.readTimeRelations.push({ derivedRelation, dotPath: path });
        }
        return this;
    }
}
export class SchemaBuilder {
    _schema = { entities: {} };
    entity(name, build) {
        if (build) {
            const e = build(new EntityBuilder());
            this._schema.entities[name] = e.def;
        }
        else {
            this._schema.entities[name] = { relations: {}, permissions: {} };
        }
        return this;
    }
    /**
     * Extend an already-defined entity with additional relations and/or
     * permissions. Use this to add forward references that depend on entities
     * defined later in the schema chain.
     */
    extend(name, build) {
        const existing = this._schema.entities[name];
        if (!existing) {
            throw new Error(`Zbar Schema Error: Cannot extend entity '${name}' — it has not been defined yet. Call .entity('${name}', ...) first.`);
        }
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
        const result = build(builder);
        this._schema.entities[name] = result.def;
        return this;
    }
    build() {
        // Reverse-edge wiring happens at runtime in `parseSchemaToGraphConfig`.
        return this._schema;
    }
}
export function createZbarSchema() {
    return new SchemaBuilder();
}
//# sourceMappingURL=builder.js.map