import { Workpool } from "@convex-dev/workpool";
import { components } from "./_generated/api";
export const expansionPool = new Workpool(components.workpool, {
    maxParallelism: 10,
    retryActionsByDefault: true,
    defaultRetryBehavior: {
        maxAttempts: 5,
        base: 2,
        initialBackoffMs: 100
    }
});
//# sourceMappingURL=workpool.js.map