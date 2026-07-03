import type { ZbarInternal } from "../internal";
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
export declare function validateRelationParameter(z: ZbarInternal, subject: {
    type: string;
}, relation: string, object: {
    type: string;
}): void;
/**
 * Validate edge properties against the schema-defined validators.
 * Throws if required fields are missing or unknown fields are present.
 */
export declare function validateProperties(z: ZbarInternal, objectType: string, relation: string, properties: unknown): void;
//# sourceMappingURL=validation.d.ts.map