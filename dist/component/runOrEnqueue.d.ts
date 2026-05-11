/**
 * Workpool dispatch helper — wraps the "if asyncWrites, enqueue; else run
 * inline" branch that the add/remove chunk processors repeat at every
 * continuation point.
 */
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
export declare function runOrEnqueue<R = void>(ctx: any, args: {
    asyncWrites: boolean | undefined;
    graphConfig: {
        mockWorkpool?: boolean;
    };
    chunkRef: any;
    payload: any;
    inlineFn?: (ctx: any, payload: any) => Promise<R>;
}): Promise<R | undefined>;
//# sourceMappingURL=runOrEnqueue.d.ts.map