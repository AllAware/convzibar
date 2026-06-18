/**
 * Compiled-config storage. The client compiles its schema into a `GraphConfig`
 * once and identifies it by a stable content hash. Mutations ship only that
 * hash (plus the full config on first use, to register it) instead of
 * re-serialising the entire rule set into every call, every workpool chunk,
 * and every onComplete payload.
 */

import type { GraphConfig } from "./types";

/** Insert a compiled config keyed by `hash` if not already present (idempotent). */
async function ensureConfig(
  ctx: any,
  hash: string,
  config: GraphConfig,
): Promise<void> {
  const existing = await ctx.db
    .query("configs")
    .withIndex("by_hash", (q: any) => q.eq("hash", hash))
    .unique();
  if (!existing) {
    await ctx.db.insert("configs", { hash, config });
  }
}

/**
 * Resolve a compiled config by hash. When `maybeConfig` is supplied (the
 * client's first call for this hash) it is registered first. Throws if the
 * hash is unknown and no config was supplied — the caller must re-register.
 */
export async function loadConfig(
  ctx: any,
  hash: string,
  maybeConfig?: GraphConfig,
): Promise<GraphConfig> {
  if (maybeConfig !== undefined) {
    await ensureConfig(ctx, hash, maybeConfig);
    return maybeConfig;
  }
  const row = await ctx.db
    .query("configs")
    .withIndex("by_hash", (q: any) => q.eq("hash", hash))
    .unique();
  if (!row) {
    throw new Error(
      `Zbar: graph config '${hash}' is not registered. The first mutation from a Zbar client registers it automatically — re-run after re-creating the client.`,
    );
  }
  return row.config as GraphConfig;
}
