/**
 * Compiled-config storage. The client compiles its schema into a `GraphConfig`
 * once and identifies it by a stable content hash. Mutations ship only that
 * hash (plus the full config on first use, to register it) instead of
 * re-serialising the entire rule set into every call, every workpool chunk,
 * and every onComplete payload.
 */
/**
 * Stable marker embedded in the unregistered-config error. The client matches
 * on it to fall back to resending the full config when its local
 * "already registered" belief turns out to be stale (e.g. the registering
 * transaction rolled back after the client flipped its flag, or component
 * data was wiped/restored while a warm isolate still held the instance).
 */
export const CONFIG_UNREGISTERED_MARKER = "[convzibar:config-unregistered]";
/** Insert a compiled config keyed by `hash` if not already present (idempotent). */
async function ensureConfig(ctx, hash, config) {
    const existing = await ctx.db
        .query("configs")
        .withIndex("by_hash", (q) => q.eq("hash", hash))
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
export async function loadConfig(ctx, hash, maybeConfig) {
    if (maybeConfig !== undefined) {
        await ensureConfig(ctx, hash, maybeConfig);
        return maybeConfig;
    }
    const row = await ctx.db
        .query("configs")
        .withIndex("by_hash", (q) => q.eq("hash", hash))
        .unique();
    if (!row) {
        throw new Error(`Zbar: graph config '${hash}' is not registered. ${CONFIG_UNREGISTERED_MARKER} ` +
            `The first mutation from a Zbar client registers it automatically.`);
    }
    return row.config;
}
//# sourceMappingURL=config.js.map