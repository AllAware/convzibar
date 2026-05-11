import type { ActionCtx, MutationCtx, QueryCtx, ZbarInternal } from "../internal";
import type { SubjectOrObject } from "../types";
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
export declare function validateRelationParameter(z: ZbarInternal, subject: {
    type: string;
}, relation: string, object: {
    type: string;
}): void;
/**
 * Validate edge properties against the schema-defined validators.
 * Throws if required fields are missing or types don't match.
 */
export declare function validateProperties(z: ZbarInternal, objectType: string, relation: string, properties: unknown): void;
/**
 * Invoke a single named condition with the standard policy context. Returns
 * `false` on throw so a buggy condition fails closed rather than 500-ing.
 */
export declare function evaluateCondition<Data>(z: ZbarInternal, conditionName: string, ctx: QueryCtx | ActionCtx | MutationCtx, subject: SubjectOrObject, object: SubjectOrObject, permission: string, data: Data): Promise<boolean | Partial<Data>>;
/**
 * Walk a single materialised path's conditions plus the target's own
 * condition. Each condition can short-circuit (false) or augment the data
 * carried forward (object return). Returns true only if every gate passes.
 */
export declare function validatePath<Data>(z: ZbarInternal, path: any, targetDef: {
    relation: string;
    condition?: string;
} | undefined, ctx: QueryCtx | ActionCtx | MutationCtx, subject: SubjectOrObject, object: SubjectOrObject, permission: string, requestContext?: Data): Promise<boolean>;
/**
 * Filter a batch of effective relations down to those that pass condition
 * validation, deduplicating by extracted id. Used by both list-objects and
 * list-subjects flows — the resolvers parameterise how subject/object are
 * built from each row.
 */
export declare function listWithValidation<Data, T extends {
    id: string;
}>(z: ZbarInternal, ctx: QueryCtx | ActionCtx, effectiveRels: any[], targets: Array<{
    relation: string;
    condition?: string;
}>, getId: (eff: any) => string, subjectResolver: (eff: any, id: string) => SubjectOrObject, objectResolver: (eff: any, id: string) => SubjectOrObject, permission: string, requestContext?: Data): Promise<T[]>;
//# sourceMappingURL=validation.d.ts.map