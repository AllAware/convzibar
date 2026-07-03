/**
 * Shared helpers for walking `SchemaRelation` definitions.
 *
 * The schema stores relation targets as a heterogeneous union (bare strings,
 * typed objects, userset strings, dot-paths, or arrays of the above). Multiple
 * modules need to discriminate and walk those shapes — keeping the
 * string-parsing rules in one place makes sure they stay consistent.
 */
/**
 * Classify a string reference found inside a relation def. The kind is
 * determined by syntax (dot-path, userset) first, then by lookup
 * (`localRelations` then `entities`), falling back to `unknown`.
 */
export function classifyStringRef(raw, ctx) {
    if (raw.includes(".")) {
        const [source, target] = raw.split(".");
        return { kind: "dotPath", source, target };
    }
    if (raw.includes("#")) {
        const [entityType, targetRelation] = raw.split("#");
        return { kind: "userset", entityType, targetRelation };
    }
    if (ctx.localRelations && raw in ctx.localRelations) {
        return { kind: "localRef", relation: raw };
    }
    if (raw in ctx.entities) {
        return { kind: "entity", entityType: raw };
    }
    return { kind: "unknown", raw };
}
/**
 * Iterate the targets of a relation def, yielding one tagged shape per
 * entry. Handles the array-or-single wrapping and the string / typed
 * dispatch — callers match on `kind` instead of re-parsing strings.
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
        if ("type" in d && typeof d.type === "string") {
            const reverse = "reverse" in d && typeof d.reverse === "string"
                ? d.reverse
                : undefined;
            yield {
                kind: "typed",
                entityType: d.type,
                reverse,
            };
        }
    }
}
/**
 * Expand a seed set of relation names into every relation name they
 * transitively contain via local userset rewrites on `objectType`.
 */
export function expandRelationTargets(schema, objectType, seed, options = {}) {
    const strict = options.strictLocalRefs ?? false;
    const localRelations = schema.entities[objectType]?.relations ?? {};
    const results = [];
    const seen = new Set();
    const recurseString = (ref) => {
        if (ref.includes("."))
            return;
        if (strict) {
            if (ref.includes("#"))
                return;
            if (localRelations[ref] === undefined)
                return;
        }
        expand(ref);
    };
    const expand = (rel) => {
        if (seen.has(rel))
            return;
        seen.add(rel);
        results.push(rel);
        const relDef = localRelations[rel];
        if (!relDef)
            return;
        const defs = Array.isArray(relDef) ? relDef : [relDef];
        for (const d of defs) {
            if (typeof d === "string")
                recurseString(d);
        }
    };
    for (const s of seed)
        expand(s);
    return results;
}
//# sourceMappingURL=relation-def.js.map