import type { ActionCtx, QueryCtx, ZbarInternal } from "../internal";
import { planRelation } from "./traversal";

/**
 * Structural connectivity check for `.via()` gate / chain hops — "does
 * subject reach object via any of `relations`, whether through a direct
 * or read-time schema path?".
 *
 * Delegates to `planRelation` with no `permission`, which builds the
 * schema walk as a plain (non-validating) leaf plus any declared RT
 * branches. Conditions are deliberately not evaluated at this layer:
 * via gates/chains test connectivity, not end-to-end permission. The
 * condition-aware check runs at the verify step (`plan.checkBatch` /
 * `plan.checkBatchSubjects` in `list/builder.ts`).
 */
export async function hasAccessOrRT(
  z: ZbarInternal,
  ctx: QueryCtx | ActionCtx,
  subject: { type: string; id: string },
  acceptableRelations: string[],
  object: { type: string; id: string },
): Promise<boolean> {
  return planRelation(
    z,
    object.type,
    acceptableRelations.map((r) => ({ relation: r })),
  ).check(ctx, subject, object);
}
