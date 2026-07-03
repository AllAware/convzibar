/**
 * Workpool dispatch helper — wraps the "if asyncWrites, enqueue; else run
 * inline" branch that the add/remove chunk processors repeat at every
 * continuation point.
 */

import { expansionPool } from "./workpool";

/**
 * Either enqueue `chunkRef` onto the workpool (when `asyncWrites` and we're not
 * using the mock) or call `inlineFn` directly, returning the inline result. The
 * async path returns `undefined`.
 *
 * `mockWorkpool` routes enqueue through the test-time mock table instead of the
 * real workpool. `payload` carries a `configHash` (not the full config) so
 * continuations stay O(1) in schema size.
 */
export async function runOrEnqueue<R = void>(
  ctx: any,
  args: {
    asyncWrites: boolean | undefined;
    mockWorkpool?: boolean;
    chunkRef: any;
    payload: any;
    inlineFn?: (ctx: any, payload: any) => Promise<R>;
  },
): Promise<R | undefined> {
  if (args.asyncWrites) {
    if (args.mockWorkpool) {
      const mutationName =
        args.payload?.baseRelId !== undefined
          ? "processAddChunk"
          : "processRemoveChunk";
      await ctx.db.insert("mockWorkpool", {
        mutationName,
        args: args.payload,
      });
    } else {
      await expansionPool.enqueueMutation(ctx, args.chunkRef, args.payload);
    }
    return undefined;
  }
  if (args.inlineFn) {
    return await args.inlineFn(ctx, args.payload);
  }
  return undefined;
}
