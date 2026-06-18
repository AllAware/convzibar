/**
 * Shared rule-application core for the BFS that materialises
 * `effectiveRelationships`.
 *
 * `collectRuleDerivations` is the single place that knows how a traversal rule
 * matches a "current" edge and which effective rows it joins against. Both the
 * add-path BFS (`applyTraversalRulesToItem`) and the remove-path cascade
 * (`processRemoveChunkInternal` in `mutations.ts`) call it, so the two
 * directions can never drift in how they walk the rule set.
 */

import { buildScopeKey, decodeScopeKey } from "../shared/keys";
import type { GraphConfig, TraversalRule } from "./types";

export interface QueueItem {
  subject: { type: string; id: string };
  relation: string;
  object: { type: string; id: string };
  path: { baseIds: string[] };
  depth: number;
  skipReverse?: boolean;
}

/** One effective-row match produced by a traversal rule against a current edge. */
export interface RuleDerivation {
  rule: TraversalRule;
  /** The matched `effectiveRelationships` row (carries `paths`). */
  match: any;
  derivedSubject: { type: string; id: string };
  derivedObject: { type: string; id: string };
}

/**
 * For a single `current` edge, find every traversal rule it triggers and the
 * effective rows each rule joins against, yielding the derived
 * `(subject, derivedRelation, object)` endpoints. Order-independent of what the
 * caller does with the result (combine paths on add, propagate token deletion
 * on remove).
 */
export async function collectRuleDerivations(
  ctx: any,
  current: { subject: { type: string; id: string }; relation: string; object: { type: string; id: string } },
  graphConfig: GraphConfig,
): Promise<RuleDerivation[]> {
  const sKey = buildScopeKey(current.subject.type, current.subject.id);
  const oKey = buildScopeKey(current.object.type, current.object.id);
  const out: RuleDerivation[] = [];

  for (const rule of graphConfig.traversalRules) {
    // Source-side: `current` is the `source` hop. Find rows pointing INTO
    // current.subject via the rule's target relation; each is a predecessor.
    if (
      current.object.type === rule.sourceObjectType &&
      current.relation === rule.sourceRelation
    ) {
      const matches = await ctx.db
        .query("effectiveRelationships")
        .withIndex("by_object_relation_subject", (q: any) =>
          q.eq("objectKey", sKey).eq("relation", rule.targetRelation),
        )
        .collect();
      for (const match of matches) {
        const [t, id] = decodeScopeKey(match.subjectKey);
        out.push({
          rule,
          match,
          derivedSubject: { type: t, id },
          derivedObject: current.object,
        });
      }
    }

    // Target-side: `current` is the `target` hop. Find rows whose object is
    // current.object via the rule's source relation; each completes a two-hop.
    if (current.relation === rule.targetRelation) {
      const matches = await ctx.db
        .query("effectiveRelationships")
        .withIndex("by_subject_relation_object", (q: any) =>
          q.eq("subjectKey", oKey).eq("relation", rule.sourceRelation),
        )
        .collect();
      for (const match of matches) {
        const [matchObjectType, matchObjectId] = decodeScopeKey(match.objectKey);
        if (matchObjectType !== rule.sourceObjectType) continue;
        out.push({
          rule,
          match,
          derivedSubject: current.subject,
          derivedObject: { type: matchObjectType, id: matchObjectId },
        });
      }
    }
  }

  return out;
}

/**
 * Add-path: for a single `current` queue item, apply every traversal rule +
 * reverse-edge declaration and push the derived items onto `queue`.
 */
export async function applyTraversalRulesToItem(
  ctx: any,
  args: {
    current: QueueItem;
    queue: QueueItem[];
    graphConfig: GraphConfig;
  },
): Promise<void> {
  const { current, queue, graphConfig } = args;
  const maxWriteDepth = graphConfig.maxWriteDepth ?? 10;

  for (const { rule, match, derivedSubject, derivedObject } of await collectRuleDerivations(
    ctx,
    current,
    graphConfig,
  )) {
    for (const matchPath of match.paths) {
      // Cycle guard: a path may not reuse a base edge it already traversed.
      const hasCycle = current.path.baseIds.some((t: string) =>
        matchPath.baseIds.includes(t),
      );
      if (hasCycle) continue;
      if (current.depth >= maxWriteDepth) continue;

      queue.push({
        subject: derivedSubject,
        relation: rule.derivedRelation,
        object: derivedObject,
        path: combinePath(current.path, matchPath),
        depth: current.depth + 1,
      });
    }
  }

  // Effective reverse edges: mirror a declared `{ reverse: … }` across the
  // materialised side. `skipReverse` is set by producers that already handled
  // the reverse side (e.g. initial-add pairs) to prevent loops.
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

/** Union two paths' baseIds into a canonical (deduped, sorted) path. */
function combinePath(
  currentPath: QueueItem["path"],
  matchPath: { baseIds: string[] },
): QueueItem["path"] {
  return {
    baseIds: [...new Set([...currentPath.baseIds, ...matchPath.baseIds])].sort(),
  };
}
