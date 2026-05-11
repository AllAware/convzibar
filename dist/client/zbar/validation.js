import { iterateRelationTargets } from "../../shared/relation-def";
/**
 * Verify that the (subject.type, relation, object.type) triple is consistent
 * with what the schema declares. Throws a descriptive error otherwise.
 *
 * "Valid subject types" are collected from every declaration on the relation:
 *   • bare entity-type strings (`'user'`)
 *   • typed-target objects (`{ type: 'user' }`, `{ type: 'group', reverse: ... }`)
 *   • userset references (`'group#viewer'` → `'group'`)
 *   • local-relation references (recursively expanded — a relation that
 *     references another local relation inherits the latter's typed targets)
 *
 * Dot-path declarations (`'owner.viewer'`) contribute no direct subject
 * types — they describe a derived/read-time path. If a relation has only
 * dot-paths (and no other typed contribution), it is considered derived
 * and cannot be written directly: throw rather than silently accepting any
 * subject.
 */
export function validateRelationParameter(z, subject, relation, object) {
    const objectEntity = z.schema.entities[object.type];
    if (!objectEntity?.relations || !(relation in objectEntity.relations)) {
        throw new Error(`Zbar Schema Error: Relation '${relation}' is not defined for object type '${object.type}'.`);
    }
    const validSubjectTypes = collectDirectSubjectTypes(z, object.type, relation, new Set());
    if (validSubjectTypes.size === 0) {
        throw new Error(`Zbar Schema Error: Relation '${relation}' on '${object.type}' declares no direct typed subjects ` +
            `(it is derived via dot-path or read-time declarations). Write the underlying base edge instead.`);
    }
    if (!validSubjectTypes.has(subject.type)) {
        throw new Error(`Zbar Schema Error: Subject type '${subject.type}' is not a valid subject for relation '${relation}' on object type '${object.type}'. Valid subject types: ${[...validSubjectTypes].join(", ")}.`);
    }
}
/**
 * Walk a relation's declarations to collect every entity type that may
 * appear as a subject when an edge with this relation is written directly.
 * Local-relation references are followed transitively (cycles broken via
 * `visited`). Dot-paths and other derived constructs contribute nothing.
 */
function collectDirectSubjectTypes(z, objectType, relation, visited) {
    if (visited.has(relation))
        return new Set();
    visited.add(relation);
    const entity = z.schema.entities[objectType];
    const localRelations = entity?.relations ?? {};
    const relDef = localRelations[relation];
    if (relDef === undefined)
        return new Set();
    const classifyCtx = {
        localRelations: localRelations,
        entities: z.schema.entities,
    };
    const types = new Set();
    for (const target of iterateRelationTargets(relDef, classifyCtx)) {
        switch (target.kind) {
            case "typed":
                types.add(target.entityType);
                break;
            case "userset":
                types.add(target.entityType);
                break;
            case "entity":
                types.add(target.entityType);
                break;
            case "localRef":
                for (const t of collectDirectSubjectTypes(z, objectType, target.relation, visited)) {
                    types.add(t);
                }
                break;
            // dotPath / unknown → no direct subject contribution
        }
    }
    return types;
}
/**
 * Validate edge properties against the schema-defined validators.
 * Throws if required fields are missing or types don't match.
 */
export function validateProperties(z, objectType, relation, properties) {
    const entityDef = z.schema.entities[objectType];
    const validators = entityDef?.propertyValidators?.[relation];
    if (!validators) {
        throw new Error(`Zbar Schema Error: No properties defined for relation '${relation}' on entity type '${objectType}'. ` +
            `Remove the 'properties' option or define properties with .properties('${relation}', { ... }) in the schema.`);
    }
    if (typeof properties !== "object" || properties === null) {
        throw new Error(`Zbar Schema Error: Properties for relation '${relation}' on '${objectType}' must be an object.`);
    }
    const props = properties;
    // Check for required fields (non-optional validators)
    for (const [key, validator] of Object.entries(validators)) {
        const val = validator;
        if (val.isOptional !== "optional" && !(key in props)) {
            throw new Error(`Zbar Schema Error: Missing required property '${key}' for relation '${relation}' on '${objectType}'.`);
        }
    }
    // Check for unknown fields
    for (const key of Object.keys(props)) {
        if (!(key in validators)) {
            throw new Error(`Zbar Schema Error: Unknown property '${key}' for relation '${relation}' on '${objectType}'. ` +
                `Defined properties: ${Object.keys(validators).join(", ")}.`);
        }
    }
}
/**
 * Invoke a single named condition with the standard policy context. Returns
 * `false` on throw so a buggy condition fails closed rather than 500-ing.
 */
export async function evaluateCondition(z, conditionName, ctx, subject, object, permission, data) {
    const conditionFn = z.schema.conditions?.[conditionName];
    if (!conditionFn)
        return false;
    const policyCtx = {
        subject,
        resource: object,
        action: permission,
        data,
    };
    try {
        return await Promise.resolve(conditionFn(ctx, policyCtx));
    }
    catch {
        return false;
    }
}
/**
 * Walk a single materialised path's conditions plus the target's own
 * condition. Each condition can short-circuit (false) or augment the data
 * carried forward (object return). Returns true only if every gate passes.
 */
export async function validatePath(z, path, targetDef, ctx, subject, object, permission, requestContext) {
    let currentData = {
        ...(requestContext || {}),
        ...(path.conditions?.[0]?.conditionContext || {}),
    };
    if (path.conditions) {
        for (const c of path.conditions) {
            // Include context from the relationship edge
            if (c !== path.conditions[0] && c.conditionContext) {
                currentData = { ...currentData, ...c.conditionContext };
            }
            const ok = await evaluateCondition(z, c.condition, ctx, subject, object, permission, currentData);
            if (ok === false) {
                return false;
            }
            else if (typeof ok === "object" && ok !== null) {
                currentData = { ...currentData, ...ok };
            }
        }
    }
    if (targetDef?.condition) {
        const ok = await evaluateCondition(z, targetDef.condition, ctx, subject, object, permission, currentData);
        if (ok === false) {
            return false;
        }
    }
    return true;
}
/**
 * Filter a batch of effective relations down to those that pass condition
 * validation, deduplicating by extracted id. Used by both list-objects and
 * list-subjects flows — the resolvers parameterise how subject/object are
 * built from each row.
 */
export async function listWithValidation(z, ctx, effectiveRels, targets, getId, subjectResolver, objectResolver, permission, requestContext) {
    const results = [];
    const seen = new Set();
    for (const eff of effectiveRels) {
        const id = getId(eff);
        if (seen.has(id))
            continue;
        const targetDef = targets.find((t) => t.relation === eff.relation);
        let valid = false;
        for (const path of eff.paths) {
            const subject = subjectResolver(eff, id);
            const object = objectResolver(eff, id);
            const isValid = await validatePath(z, path, targetDef, ctx, subject, object, permission, requestContext);
            if (isValid) {
                valid = true;
                break;
            }
        }
        if (valid) {
            seen.add(id);
            results.push({ id });
        }
    }
    return results;
}
//# sourceMappingURL=validation.js.map