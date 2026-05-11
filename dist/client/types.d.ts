import type { GenericActionCtx, GenericDataModel, GenericQueryCtx } from "convex/server";
import type { ObjectType as ConvexObjectType, PropertyValidators } from "convex/values";
export interface PolicyContext<Data = any> {
    subject: {
        type: string;
        id: string;
    };
    resource?: {
        type: string;
        id: string;
    };
    action?: string;
    data: Data;
}
export type ConditionFunction<Data = any> = (ctx: GenericQueryCtx<GenericDataModel> | GenericActionCtx<GenericDataModel>, policyCtx: PolicyContext<Data>) => boolean | Partial<Data> | Promise<boolean | Partial<Data>>;
export type SchemaRelation = string | {
    type: string;
} | {
    type: string;
    reverse: string;
} | {
    relation: string;
    condition: string;
} | Array<string | {
    type: string;
} | {
    type: string;
    reverse: string;
} | {
    relation: string;
    condition: string;
}>;
export interface EntityDefinition {
    relations?: Record<string, SchemaRelation>;
    permissions?: Record<string, Array<string | {
        relation: string;
        condition: string;
    }>>;
    propertyValidators?: Record<string, PropertyValidators>;
    /**
     * Dot-path relations evaluated at read time instead of materialised at
     * write time. See {@link EntityBuilder.readTimeRelation}.
     */
    readTimeRelations?: Array<{
        derivedRelation: string;
        dotPath: string;
    }>;
}
export interface ZbarSchema<Data = any> {
    conditions?: Record<string, ConditionFunction<Data>>;
    entities: Record<string, EntityDefinition>;
}
export type BuiltZbarSchema<Data, Conditions extends Record<string, any>, Entities extends Record<string, {
    relations: Record<string, string>;
    permissions: string;
    properties: Record<string, PropertyValidators>;
}>> = {
    conditions: Record<keyof Conditions & string, ConditionFunction<Data>>;
    entities: {
        [E in keyof Entities]: {
            relations: Record<keyof Entities[E]["relations"] & string, SchemaRelation>;
            permissions: Record<Entities[E]["permissions"] & string, Array<string | {
                relation: string;
                condition: string;
            }>>;
            propertyValidators: Entities[E]["properties"];
        };
    };
};
export interface SubjectOrObject {
    type: string;
    id: string;
}
export type EntityPermissions<Schema extends ZbarSchema, ObjectType extends keyof Schema["entities"]> = Schema["entities"][ObjectType] extends {
    permissions: infer P;
} ? keyof P & string : never;
export type EntityRelations<Schema extends ZbarSchema, ObjectType extends keyof Schema["entities"]> = Schema["entities"][ObjectType] extends {
    relations: infer R;
} ? keyof R & string : never;
export type SchemaConditions<Schema extends ZbarSchema<any>> = Schema extends {
    conditions: infer C;
} ? keyof C & string : never;
/**
 * Extract the property validators for a specific relation on an entity type.
 * Returns `never` if the relation has no properties defined.
 */
export type EntityRelationProperties<Schema extends ZbarSchema, ObjType extends keyof Schema["entities"], Relation extends string> = Schema["entities"][ObjType] extends {
    propertyValidators: infer PV;
} ? PV extends Record<string, PropertyValidators> ? Relation extends keyof PV ? ConvexObjectType<PV[Relation]> : never : never : never;
/**
 * Resolve the inferred property type for a relation.
 * Returns `undefined` when no properties are declared.
 */
export type ResolvedProperties<Schema extends ZbarSchema, OT extends keyof Schema["entities"] & string, Rel extends string> = EntityRelationProperties<Schema, OT, Rel> extends never ? undefined : EntityRelationProperties<Schema, OT, Rel>;
export declare class PermissionError extends Error {
    constructor(message: string);
}
//# sourceMappingURL=types.d.ts.map