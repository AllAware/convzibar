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
import type { GraphConfig, TraversalRule } from "./types";
export interface QueueItem {
    subject: {
        type: string;
        id: string;
    };
    relation: string;
    object: {
        type: string;
        id: string;
    };
    path: {
        baseIds: string[];
    };
    depth: number;
    skipReverse?: boolean;
}
/** One effective-row match produced by a traversal rule against a current edge. */
export interface RuleDerivation {
    rule: TraversalRule;
    /** The matched `effectiveRelationships` row (carries `paths`). */
    match: any;
    derivedSubject: {
        type: string;
        id: string;
    };
    derivedObject: {
        type: string;
        id: string;
    };
}
/**
 * For a single `current` edge, find every traversal rule it triggers and the
 * effective rows each rule joins against, yielding the derived
 * `(subject, derivedRelation, object)` endpoints. Order-independent of what the
 * caller does with the result (combine paths on add, propagate token deletion
 * on remove).
 */
export declare function collectRuleDerivations(ctx: any, current: {
    subject: {
        type: string;
        id: string;
    };
    relation: string;
    object: {
        type: string;
        id: string;
    };
}, graphConfig: GraphConfig): Promise<RuleDerivation[]>;
/**
 * Add-path: for a single `current` queue item, apply every traversal rule +
 * reverse-edge declaration and push the derived items onto `queue`.
 */
export declare function applyTraversalRulesToItem(ctx: any, args: {
    current: QueueItem;
    queue: QueueItem[];
    graphConfig: GraphConfig;
}): Promise<void>;
//# sourceMappingURL=expand.d.ts.map