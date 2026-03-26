import { Workpool } from "@convex-dev/workpool";
import { components } from "./_generated/api";

export const expansionPool = new Workpool(components.workpool, {
  maxParallelism: 10,
  retryActionsByDefault: false,
});
