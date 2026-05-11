/**
 * Shared helpers for walking `SchemaRelation` definitions.
 *
 * The schema stores relation targets as a heterogeneous union (bare strings,
 * typed objects, userset strings, dot-paths, {relation, condition} pairs,
 * or arrays of the above). Multiple modules need to discriminate and walk
 * those shapes — keeping the string-parsing rules in one place makes sure
 * they stay consistent.
 */
/**
 * A single classified target of a relation. Strings are parsed against the
 * caller-provided context (`localRelations`, `entities`) so the discriminant
 * captures the string's *meaning*, not just its syntax.
 */
export type RelationTargetShape = 
/** `{ type: X }` or `{ type: X, reverse: Y }` — a typed subject reference. */
{
    kind: "typed";
    entityType: string;
    reverse?: string;
    condition?: string;
}
/** `"source.target"` — a read-time dot-path. */
 | {
    kind: "dotPath";
    source: string;
    target: string;
    condition?: string;
}
/** `"type#relation"` — a userset rewrite. */
 | {
    kind: "userset";
    entityType: string;
    targetRelation: string;
    condition?: string;
}
/** A bare string that resolves to a local relation on the current entity. */
 | {
    kind: "localRef";
    relation: string;
    condition?: string;
}
/** A bare string that resolves to an entity type in the schema. */
 | {
    kind: "entity";
    entityType: string;
    condition?: string;
}
/** A bare string that matches neither a local relation nor a declared entity. */
 | {
    kind: "unknown";
    raw: string;
    condition?: string;
};
export interface ClassificationContext {
    /** Relations declared on the entity that *owns* the def being classified. */
    localRelations: Record<string, unknown> | undefined;
    /** All declared entity types — passed so bare-string entity refs resolve. */
    entities: Record<string, unknown>;
}
/**
 * Classify a string reference found inside a relation def. The kind is
 * determined by syntax (dot-path, userset) first, then by lookup
 * (`localRelations` then `entities`), falling back to `unknown`.
 */
export declare function classifyStringRef(raw: string, ctx: ClassificationContext, condition?: string): RelationTargetShape;
/**
 * Iterate the targets of a relation def, yielding one tagged shape per
 * entry. Handles the array-or-single wrapping and the string / typed /
 * {relation, condition} dispatch — callers match on `kind` instead of
 * re-parsing strings.
 */
export declare function iterateRelationTargets(relDef: unknown, ctx: ClassificationContext): Generator<RelationTargetShape>;
export interface ExpandOptions {
    /**
     * When true, the walker recurses ONLY into strings that resolve to a
     * local relation on the object entity. When false (default), any string
     * without a `.` is treated as a recurrable ref — matching the
     * pre-refactor client behaviour where userset strings would be added to
     * the result set (harmless but noisy; no effective rows match).
     */
    strictLocalRefs?: boolean;
}
/**
 * Walk a relation's local userset rewrites to produce every `(relation,
 * condition)` pair it transitively contains, given a seed of either bare
 * relation names or `{relation, condition}` pairs (the shape stored on
 * `EntityDefinition.permissions`).
 */
export declare function expandRelationTargets(schema: {
    entities: Record<string, {
        relations?: Record<string, unknown>;
    } | undefined>;
}, objectType: string, seed: ReadonlyArray<string | {
    relation: string;
    condition?: string;
}>, options?: ExpandOptions): Array<{
    relation: string;
    condition?: string;
}>;
//# sourceMappingURL=relation-def.d.ts.map