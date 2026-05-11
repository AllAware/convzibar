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
 * Classify a string reference found inside a relation def. The kind is
 * determined by syntax (dot-path, userset) first, then by lookup
 * (`localRelations` then `entities`), falling back to `unknown`.
 */
export function classifyStringRef(raw, ctx, condition) {
    if (raw.includes(".")) {
        const [source, target] = raw.split(".");
        return { kind: "dotPath", source, target, condition };
    }
    if (raw.includes("#")) {
        const [entityType, targetRelation] = raw.split("#");
        return { kind: "userset", entityType, targetRelation, condition };
    }
    if (ctx.localRelations && raw in ctx.localRelations) {
        return { kind: "localRef", relation: raw, condition };
    }
    if (raw in ctx.entities) {
        return { kind: "entity", entityType: raw, condition };
    }
    return { kind: "unknown", raw, condition };
}
/**
 * Iterate the targets of a relation def, yielding one tagged shape per
 * entry. Handles the array-or-single wrapping and the string / typed /
 * {relation, condition} dispatch — callers match on `kind` instead of
 * re-parsing strings.
 */
export function* iterateRelationTargets(relDef, ctx) {
    if (relDef === undefined || relDef === null)
        return;
    const defs = Array.isArray(relDef) ? relDef : [relDef];
    for (const d of defs) {
        if (typeof d === "string") {
            yield classifyStringRef(d, ctx);
            continue;
        }
        if (typeof d !== "object" || d === null)
            continue;
        if ("type" in d &&
            typeof d.type === "string") {
            const reverse = "reverse" in d && typeof d.reverse === "string"
                ? (d.reverse)
                : undefined;
            yield {
                kind: "typed",
                entityType: d.type,
                reverse,
            };
            continue;
        }
        if ("relation" in d &&
            typeof d.relation === "string") {
            const condition = "condition" in d && typeof d.condition === "string"
                ? (d.condition)
                : undefined;
            yield classifyStringRef(d.relation, ctx, condition);
        }
    }
}
/**
 * Walk a relation's local userset rewrites to produce every `(relation,
 * condition)` pair it transitively contains, given a seed of either bare
 * relation names or `{relation, condition}` pairs (the shape stored on
 * `EntityDefinition.permissions`).
 */
export function expandRelationTargets(schema, objectType, seed, options = {}) {
    const strict = options.strictLocalRefs ?? false;
    const localRelations = schema.entities[objectType]?.relations ?? {};
    const results = [];
    const recurseString = (ref, cond) => {
        if (ref.includes("."))
            return;
        if (strict) {
            if (ref.includes("#"))
                return;
            if (localRelations[ref] === undefined)
                return;
        }
        expand(ref, cond);
    };
    const expand = (rel, currentCondition) => {
        if (results.some((r) => r.relation === rel && r.condition === currentCondition)) {
            return;
        }
        results.push({ relation: rel, condition: currentCondition });
        const relDef = localRelations[rel];
        if (!relDef)
            return;
        const defs = Array.isArray(relDef) ? relDef : [relDef];
        for (const d of defs) {
            if (typeof d === "string") {
                recurseString(d, currentCondition);
            }
            else if (typeof d === "object" && d !== null && "relation" in d) {
                const relRef = d.relation;
                if (typeof relRef === "string") {
                    const cond = d.condition ?? currentCondition;
                    recurseString(relRef, cond);
                }
            }
        }
    };
    for (const s of seed) {
        if (typeof s === "string")
            expand(s, undefined);
        else
            expand(s.relation, s.condition);
    }
    return results;
}
//# sourceMappingURL=relation-def.js.map