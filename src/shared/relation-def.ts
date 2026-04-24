/**
 * Shared helpers for walking `SchemaRelation` definitions.
 *
 * The schema stores relation targets as a heterogeneous union (bare strings,
 * typed objects, userset strings, dot-paths, {relation, condition} pairs,
 * or arrays of the above). Multiple modules need to discriminate and walk
 * those shapes — keeping the string-parsing rules in one place makes sure
 * they stay consistent.
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
  | { kind: "typed"; entityType: string; reverse?: string; condition?: string }
  /** `"source.target"` — a read-time dot-path. */
  | { kind: "dotPath"; source: string; target: string; condition?: string }
  /** `"type#relation"` — a userset rewrite. */
  | { kind: "userset"; entityType: string; targetRelation: string; condition?: string }
  /** A bare string that resolves to a local relation on the current entity. */
  | { kind: "localRef"; relation: string; condition?: string }
  /** A bare string that resolves to an entity type in the schema. */
  | { kind: "entity"; entityType: string; condition?: string }
  /** A bare string that matches neither a local relation nor a declared entity. */
  | { kind: "unknown"; raw: string; condition?: string };

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
  condition?: string,
): RelationTargetShape {
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

    if (
      "type" in d &&
      typeof (d as { type: unknown }).type === "string"
    ) {
      const reverse =
        "reverse" in d && typeof (d as { reverse: unknown }).reverse === "string"
          ? ((d as { reverse: string }).reverse)
          : undefined;
      yield {
        kind: "typed",
        entityType: (d as { type: string }).type,
        reverse,
      };
      continue;
    }

    if (
      "relation" in d &&
      typeof (d as { relation: unknown }).relation === "string"
    ) {
      const condition =
        "condition" in d && typeof (d as { condition: unknown }).condition === "string"
          ? ((d as { condition: string }).condition)
          : undefined;
      yield classifyStringRef(
        (d as { relation: string }).relation,
        ctx,
        condition,
      );
    }
  }
}

// ============================================================================
// Unified inheritance walker.
//
// Replaces three near-identical recursive expanders that previously lived in
// client/zbar/resolvers.ts (permission + relation variants) and
// component/helpers.ts. The only real difference between them was the
// starting seed and whether lookups of unrecognised string refs were
// tolerated — both are now parameters.
// ============================================================================

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
export function expandRelationTargets(
  schema: {
    entities: Record<string, { relations?: Record<string, unknown> } | undefined>;
  },
  objectType: string,
  seed: ReadonlyArray<string | { relation: string; condition?: string }>,
  options: ExpandOptions = {},
): Array<{ relation: string; condition?: string }> {
  const strict = options.strictLocalRefs ?? false;
  const localRelations =
    (schema.entities[objectType]?.relations as Record<string, unknown>) ?? {};
  const results: Array<{ relation: string; condition?: string }> = [];

  const recurseString = (ref: string, cond: string | undefined) => {
    if (ref.includes(".")) return;
    if (strict) {
      if (ref.includes("#")) return;
      if (localRelations[ref] === undefined) return;
    }
    expand(ref, cond);
  };

  const expand = (rel: string, currentCondition?: string) => {
    if (
      results.some(
        (r) => r.relation === rel && r.condition === currentCondition,
      )
    ) {
      return;
    }
    results.push({ relation: rel, condition: currentCondition });

    const relDef = localRelations[rel];
    if (!relDef) return;
    const defs = Array.isArray(relDef) ? relDef : [relDef];

    for (const d of defs) {
      if (typeof d === "string") {
        recurseString(d, currentCondition);
      } else if (typeof d === "object" && d !== null && "relation" in d) {
        const relRef = (d as { relation: unknown }).relation;
        if (typeof relRef === "string") {
          const cond =
            (d as { condition?: string }).condition ?? currentCondition;
          recurseString(relRef, cond);
        }
      }
    }
  };

  for (const s of seed) {
    if (typeof s === "string") expand(s, undefined);
    else expand(s.relation, s.condition);
  }

  return results;
}
