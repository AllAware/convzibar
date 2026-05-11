/**
 * Workpool dispatch helper — wraps the "if asyncWrites, enqueue; else run
 * inline" branch that the add/remove chunk processors repeat at every
 * continuation point.
 */
import { expansionPool } from "./workpool";
/**
 * Either enqueue `chunkRef` onto the workpool (when `asyncWrites` and we're
 * not using the mock) or call `inlineFn` directly, returning the inline
 * result. The async path returns `undefined` — callers that need a value
 * (e.g. `effectiveRelationshipsRemoved` from the remove chunk) should
 * tolerate that or skip `runOrEnqueue` for the rare case it matters.
 *
 * `chunkRef` is the internal mutation reference registered on the workpool.
 * `graphConfig.mockWorkpool` routes enqueue through the test-time mock table.
 */
export async function runOrEnqueue(ctx, args) {
    if (args.asyncWrites) {
        if (args.graphConfig?.mockWorkpool) {
            const mutationName = args.payload?.baseRelId !== undefined
                ? "processAddChunk"
                : "processRemoveChunk";
            await ctx.db.insert("mockWorkpool", {
                mutationName,
                args: args.payload,
            });
        }
        else {
            await expansionPool.enqueueMutation(ctx, args.chunkRef, args.payload);
        }
        return undefined;
    }
    if (args.inlineFn) {
        return await args.inlineFn(ctx, args.payload);
    }
    return undefined;
}
//# sourceMappingURL=runOrEnqueue.js.map