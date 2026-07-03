import type { PropertyValidators } from "convex/values";
import type { BuiltZbarSchema } from "../types";
import type { EntityUsersetPath, ReverseTargetRelations, TargetRelationKeys } from "./builder-types";
export declare class EntityBuilder<EntName extends string, Entities extends Record<string, {
    relations: Record<string, string>;
    permissions: string;
    properties: Record<string, PropertyValidators>;
}>, Relations extends Record<string, string> = {}, Permissions extends string = never, Reverses extends Record<string, {
    relations: Record<string, string>;
    properties: Record<string, PropertyValidators>;
}> = {}, Properties extends Record<string, PropertyValidators> = {}> {
    _relations: Relations;
    _permissions: Permissions;
    _reverses: Reverses;
    _properties: Properties;
    def: any;
    /**
     * When true, `.relation()` merges new targets into existing relation
     * definitions instead of overwriting them. Set by `SchemaBuilder.extend()`.
     */
    _mergeMode: boolean;
    /**
     * Placeholder overload: declares a relation name with no subject type.
     * Used for reverse-edge targets that will be populated by entities
     * defined later in the schema chain.
     */
    relation<RelName extends string>(name: RelName): EntityBuilder<EntName, Entities, Relations & Record<RelName, string>, Permissions, Reverses, Properties>;
    /**
     * Full overload: declares a relation with one or more typed targets.
     */
    relation<RelName extends string, Target extends (keyof Entities | EntName) & string = (keyof Entities | EntName) & string, RTarget extends (keyof Entities | EntName) & string = never, RRev extends string = never>(name: RelName, ...targets: Array<Target | keyof Relations | {
        [K in keyof Relations & string]: `${K}.${TargetRelationKeys<Relations[K], EntName, Relations, Entities>}`;
    }[keyof Relations & string] | EntityUsersetPath<EntName, RelName, Relations, Entities> | {
        type: Target;
    } | {
        type: RTarget;
        reverse: RRev & ReverseTargetRelations<RTarget, EntName, Relations, Entities>;
    }>): EntityBuilder<EntName, Entities, Relations & Record<RelName, Target>, Permissions, Reverses & ([RRev] extends [never] ? {} : Record<RTarget & string, {
        relations: Record<RRev & string, EntName>;
        properties: {};
    }>), Properties>;
    permission<PermName extends string>(name: PermName, ...targets: Array<keyof Relations>): EntityBuilder<EntName, Entities, Relations, Permissions | PermName, Reverses, Properties>;
    /**
     * Define typed properties for a relation using Convex validators.
     *
     * Properties are stored on direct edges and returned by `.listDirect()`.
     * They are validated at write-time by the client before being persisted.
     */
    properties<RelName extends keyof Relations & string, P extends PropertyValidators>(relation: RelName, validators: P): EntityBuilder<EntName, Entities, Relations, Permissions, Reverses, Properties & Record<RelName, P>>;
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
    readTimeRelation(derivedRelation: keyof Relations & string, ...paths: string[]): this;
}
export declare class SchemaBuilder<Entities extends Record<string, {
    relations: Record<string, string>;
    permissions: string;
    properties: Record<string, PropertyValidators>;
}> = {}> {
    _schema: any;
    entity<Name extends string, Rel extends Record<string, string> = {}, Perm extends string = never, Rev extends Record<string, {
        relations: Record<string, string>;
        properties: Record<string, PropertyValidators>;
    }> = {}, Props extends Record<string, PropertyValidators> = {}>(name: Name, build?: (e: EntityBuilder<Name, Entities, {}, never, {}, {}>) => EntityBuilder<Name, Entities, Rel, Perm, Rev, Props>): SchemaBuilder<Entities & Record<Name, {
        relations: Rel;
        permissions: Perm;
        properties: Props;
    }> & Rev>;
    /**
     * Extend an already-defined entity with additional relations and/or
     * permissions. Use this to add forward references that depend on entities
     * defined later in the schema chain.
     */
    extend<Name extends keyof Entities & string, NewRel extends Record<string, string> = {}, NewPerm extends string = never, Rev extends Record<string, {
        relations: Record<string, string>;
        properties: Record<string, PropertyValidators>;
    }> = {}, NewProps extends Record<string, PropertyValidators> = {}>(name: Name, build: (e: EntityBuilder<Name, Entities, Entities[Name]["relations"], Entities[Name]["permissions"], {}, Entities[Name]["properties"]>) => EntityBuilder<Name, Entities, Entities[Name]["relations"] & NewRel, Entities[Name]["permissions"] | NewPerm, Rev, Entities[Name]["properties"] & NewProps>): SchemaBuilder<Omit<Entities, Name> & Record<Name, {
        relations: Entities[Name]["relations"] & NewRel;
        permissions: Entities[Name]["permissions"] | NewPerm;
        properties: Entities[Name]["properties"] & NewProps;
    }> & Rev>;
    build(): BuiltZbarSchema<Entities>;
}
export declare function createZbarSchema(): SchemaBuilder<{}>;
//# sourceMappingURL=builder.d.ts.map