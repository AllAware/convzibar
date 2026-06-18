/**
 * Shared helpers for walking `SchemaRelation` definitions.
 *
 * The schema stores relation targets as a heterogeneous union (bare strings,
 * typed objects, userset strings, dot-paths, or arrays of the above). Multiple
 * modules need to discriminate and walk those shapes — keeping the
 * string-parsing rules in one place makes sure they stay consistent.
 */

// ============================================================================
// Tagged target shapes.
// ============================================================================

/**
 * A single classified target of a relation. Strings are parsed against the
 * caller-provided context (`localRelations`, `entities`) so the discriminant
 * captures the string's *meaning*, not just its syntax.
 */
export type RelationTargetShape =
  /** `{ type: X }` or `{ type: X, reverse: Y }` — a typed subject reference. */
  | { kind: "typed"; entityType: string; reverse?: string }
  /** `"source.target"` — a read-time dot-path. */
  | { kind: "dotPath"; source: string; target: string }
  /** `"type#relation"` — a userset rewrite. */
  | { kind: "userset"; entityType: string; targetRelation: string }
  /** A bare string that resolves to a local relation on the current entity. */
  | { kind: "localRef"; relation: string }
  /** A bare string that resolves to an entity type in the schema. */
  | { kind: "entity"; entityType: string }
  /** A bare string that matches neither a local relation nor a declared entity. */
  | { kind: "unknown"; raw: string };

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
export function classifyStringRef(
  raw: string,
  ctx: ClassificationContext,
): RelationTargetShape {
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
export function* iterateRelationTargets(
  relDef: unknown,
  ctx: ClassificationContext,
): Generator<RelationTargetShape> {
  if (relDef === undefined || relDef === null) return;
  const defs = Array.isArray(relDef) ? relDef : [relDef];
  for (const d of defs) {
    if (typeof d === "string") {
      yield classifyStringRef(d, ctx);
      continue;
    }
    if (typeof d !== "object" || d === null) continue;

    if ("type" in d && typeof (d as { type: unknown }).type === "string") {
      const reverse =
        "reverse" in d && typeof (d as { reverse: unknown }).reverse === "string"
          ? (d as { reverse: string }).reverse
          : undefined;
      yield {
        kind: "typed",
        entityType: (d as { type: string }).type,
        reverse,
      };
    }
  }
}

// ============================================================================
// Unified inheritance walker.
//
// Walks a relation's local userset rewrites to produce every relation name it
// transitively contains, given a seed of bare relation names. Used by both the
// client (relation/permission inheritance) and the schema compiler.
// ============================================================================

export interface ExpandOptions {
  /**
   * When true, the walker recurses ONLY into strings that resolve to a
   * local relation on the object entity. When false (default), any string
   * without a `.` is treated as a recurrable ref — matching the historical
   * client behaviour where userset strings would be added to the result set
   * (harmless but noisy; no effective rows match).
   */
  strictLocalRefs?: boolean;
}

/**
 * Expand a seed set of relation names into every relation name they
 * transitively contain via local userset rewrites on `objectType`.
 */
export function expandRelationTargets(
  schema: {
    entities: Record<string, { relations?: Record<string, unknown> } | undefined>;
  },
  objectType: string,
  seed: ReadonlyArray<string>,
  options: ExpandOptions = {},
): string[] {
  const strict = options.strictLocalRefs ?? false;
  const localRelations =
    (schema.entities[objectType]?.relations as Record<string, unknown>) ?? {};
  const results: string[] = [];
  const seen = new Set<string>();

  const recurseString = (ref: string) => {
    if (ref.includes(".")) return;
    if (strict) {
      if (ref.includes("#")) return;
      if (localRelations[ref] === undefined) return;
    }
    expand(ref);
  };

  const expand = (rel: string) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    results.push(rel);

    const relDef = localRelations[rel];
    if (!relDef) return;
    const defs = Array.isArray(relDef) ? relDef : [relDef];

    for (const d of defs) {
      if (typeof d === "string") recurseString(d);
    }
  };

  for (const s of seed) expand(s);

  return results;
}
