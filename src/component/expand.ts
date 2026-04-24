/**
 * Shared rule-application core for the BFS that materialises
 * `effectiveRelationships`. Both the add-path BFS (`processAddChunk` in
 * `mutations.ts`) and the rebuild BFS (`expandTraversalRules` in
 * `unsafe.ts`) call this helper to apply every traversal rule + reverse
 * edge to a single "current" queue item.
 *
 * The caller still owns the outer loop, the effective-relationship
 * upsert, and the `seen`/dedup strategy (which differs between add and
 * rebuild). This function only produces the new queue pushes.
 */

import { buildScopeKey, decodeScopeKey } from "../shared/keys";
import type { GraphConfig, TraversalRule } from "./types";

export interface QueueItem {
  subject: { type: string; id: string };
  relation: string;
  object: { type: string; id: string };
  path: {
    baseIds: string[];
    conditions?: Array<{ condition: string; conditionContext?: unknown }>;
  };
  depth: number;
  skipReverse?: boolean;
}

/**
 * For a single `current` item, scan every traversal rule + reverse-edge
 * declaration and push the derived items onto `queue`. The depth / cycle
 * / reverse-edge invariants mirror what the original inline loops enforced.
 *
 * `combineConditionsLeading` controls the order conditions are stitched
 * together when a rule matches as the *source* side — which determines
 * whether `matchPath.conditions` come before or after `current.path.conditions`.
 * The add-path and rebuild-path always agree, so this isn't configurable.
 */
export async function applyTraversalRulesToItem(
  ctx: any,
  args: {
    tenantId: string | undefined;
    current: QueueItem;
    queue: QueueItem[];
    graphConfig: GraphConfig;
  },
): Promise<void> {
  const { tenantId, current, queue, graphConfig } = args;
  const maxWriteDepth = graphConfig.maxWriteDepth ?? 10;
  const sKey = buildScopeKey(current.subject.type, current.subject.id);
  const oKey = buildScopeKey(current.object.type, current.object.id);

  for (const rule of graphConfig.traversalRules) {
    // Source-side match: current is the `source` of a rule, look up its
    // existing `target` rows as subjects pointing into us.
    if (
      current.object.type === rule.sourceObjectType &&
      current.relation === rule.sourceRelation
    ) {
      await applySourceSideMatch(ctx, {
        tenantId,
        current,
        rule,
        sKey,
        queue,
        maxWriteDepth,
      });
    }

    // Target-side match: current is the `target` of a rule; look up
    // `source` rows whose object points at our object, deriving a two-hop.
    if (current.relation === rule.targetRelation) {
      await applyTargetSideMatch(ctx, {
        tenantId,
        current,
        rule,
        oKey,
        queue,
        maxWriteDepth,
      });
    }
  }

  // Effective reverse edges: mirror a declared `{ reverse: … }` across the
  // materialised side. `skipReverse` is set by producers that already
  // handled the reverse side (e.g. initial-add pairs) to prevent loops.
  if (graphConfig.reverseEdges && !current.skipReverse) {
    const reverseRel =
      graphConfig.reverseEdges?.[current.object.type]?.[current.relation]?.[
        current.subject.type
      ];
    if (reverseRel && current.depth < maxWriteDepth) {
      queue.push({
        subject: current.object,
        relation: reverseRel,
        object: current.subject,
        path: current.path,
        depth: current.depth + 1,
        skipReverse: true,
      });
    }
  }
}

async function applySourceSideMatch(
  ctx: any,
  args: {
    tenantId: string | undefined;
    current: QueueItem;
    rule: TraversalRule;
    sKey: string;
    queue: QueueItem[];
    maxWriteDepth: number;
  },
): Promise<void> {
  const { tenantId, current, rule, sKey, queue, maxWriteDepth } = args;
  const matches = await ctx.db
    .query("effectiveRelationships")
    .withIndex("by_tenant_object_relation_subject", (q: any) =>
      q
        .eq("tenantId", tenantId)
        .eq("objectKey", sKey)
        .eq("relation", rule.targetRelation),
    )
    .collect();

  for (const match of matches) {
    const [matchSubjectType, matchSubjectId] = decodeScopeKey(
      match.subjectKey,
    );
    const derivedSubject = { type: matchSubjectType, id: matchSubjectId };
    const derivedObject = current.object;

    for (const matchPath of match.paths) {
      const hasCycle = current.path.baseIds.some((t: string) =>
        matchPath.baseIds.includes(t),
      );
      if (hasCycle) continue;
      if (current.depth >= maxWriteDepth) continue;

      queue.push({
        subject: derivedSubject,
        relation: rule.derivedRelation,
        object: derivedObject,
        path: combinePath(current.path, matchPath, rule, "matchFirst"),
        depth: current.depth + 1,
      });
    }
  }
}

async function applyTargetSideMatch(
  ctx: any,
  args: {
    tenantId: string | undefined;
    current: QueueItem;
    rule: TraversalRule;
    oKey: string;
    queue: QueueItem[];
    maxWriteDepth: number;
  },
): Promise<void> {
  const { tenantId, current, rule, oKey, queue, maxWriteDepth } = args;
  const matches = await ctx.db
    .query("effectiveRelationships")
    .withIndex("by_tenant_subject_relation_object", (q: any) =>
      q
        .eq("tenantId", tenantId)
        .eq("subjectKey", oKey)
        .eq("relation", rule.sourceRelation),
    )
    .collect();

  for (const match of matches) {
    const [matchObjectType, matchObjectId] = decodeScopeKey(match.objectKey);
    if (matchObjectType !== rule.sourceObjectType) continue;

    const derivedSubject = current.subject;
    const derivedObject = { type: matchObjectType, id: matchObjectId };

    for (const matchPath of match.paths) {
      const hasCycle = current.path.baseIds.some((t: string) =>
        matchPath.baseIds.includes(t),
      );
      if (hasCycle) continue;
      if (current.depth >= maxWriteDepth) continue;

      queue.push({
        subject: derivedSubject,
        relation: rule.derivedRelation,
        object: derivedObject,
        path: combinePath(current.path, matchPath, rule, "currentFirst"),
        depth: current.depth + 1,
      });
    }
  }
}

/**
 * Join `current.path` with `matchPath` conditions in the order appropriate
 * to which side of the rule matched, append any schema-defined rule
 * conditions, and produce the canonicalised new path (deduped + sorted
 * baseIds). Returns `undefined` for conditions when the combined list is
 * empty, to match the pre-refactor wire format.
 */
function combinePath(
  currentPath: QueueItem["path"],
  matchPath: { baseIds: string[]; conditions?: Array<{ condition: string; conditionContext?: unknown }> },
  rule: TraversalRule,
  order: "matchFirst" | "currentFirst",
): QueueItem["path"] {
  const schemaCondition = rule.conditions
    ? rule.conditions.map((c: string) => ({ condition: c }))
    : [];
  const combinedConditions =
    order === "matchFirst"
      ? [
          ...(matchPath.conditions || []),
          ...(currentPath.conditions || []),
          ...schemaCondition,
        ]
      : [
          ...(currentPath.conditions || []),
          ...(matchPath.conditions || []),
          ...schemaCondition,
        ];

  return {
    baseIds: [
      ...new Set([...currentPath.baseIds, ...matchPath.baseIds]),
    ].sort(),
    conditions:
      combinedConditions.length > 0 ? combinedConditions : undefined,
  };
}
