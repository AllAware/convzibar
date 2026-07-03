import { iterateRelationTargets } from "../../shared/relation-def";
/**
 * Verify that the (subject.type, relation, object.type) triple is consistent
 * with what the schema declares. Throws a descriptive error otherwise.
 *
 * "Valid subject types" are collected from every declaration on the relation:
 * bare entity-type strings, typed-target objects, userset references, and
 * local-relation references (recursively expanded). Dot-path declarations
 * contribute no direct subject types — a relation with only dot-paths is
 * derived and cannot be written directly.
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
            case "userset":
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
 * Throws if required fields are missing or unknown fields are present.
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
    for (const [key, validator] of Object.entries(validators)) {
        const val = validator;
        if (val.isOptional !== "optional" && !(key in props)) {
            throw new Error(`Zbar Schema Error: Missing required property '${key}' for relation '${relation}' on '${objectType}'.`);
        }
    }
    for (const key of Object.keys(props)) {
        if (!(key in validators)) {
            throw new Error(`Zbar Schema Error: Unknown property '${key}' for relation '${relation}' on '${objectType}'. ` +
                `Defined properties: ${Object.keys(validators).join(", ")}.`);
        }
    }
}
//# sourceMappingURL=validation.js.map