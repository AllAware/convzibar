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
import type { GraphConfig } from "./types";
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
        conditions?: Array<{
            condition: string;
            conditionContext?: unknown;
        }>;
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
export declare function applyTraversalRulesToItem(ctx: any, args: {
    tenantId: string | undefined;
    current: QueueItem;
    queue: QueueItem[];
    graphConfig: GraphConfig;
}): Promise<void>;
//# sourceMappingURL=expand.d.ts.map