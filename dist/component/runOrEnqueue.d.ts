/**
 * Workpool dispatch helper — wraps the "if asyncWrites, enqueue; else run
 * inline" branch that the add/remove chunk processors repeat at every
 * continuation point.
 */
/**
 * Either enqueue `chunkRef` onto the workpool (when `asyncWrites` and we're not
 * using the mock) or call `inlineFn` directly, returning the inline result. The
 * async path returns `undefined`.
 *
 * `mockWorkpool` routes enqueue through the test-time mock table instead of the
 * real workpool. `payload` carries a `configHash` (not the full config) so
 * continuations stay O(1) in schema size.
 */
export declare function runOrEnqueue<R = void>(ctx: any, args: {
    asyncWrites: boolean | undefined;
    mockWorkpool?: boolean;
    chunkRef: any;
    payload: any;
    inlineFn?: (ctx: any, payload: any) => Promise<R>;
}): Promise<R | undefined>;
//# sourceMappingURL=runOrEnqueue.d.ts.map