/**
 * Compiled-config storage. The client compiles its schema into a `GraphConfig`
 * once and identifies it by a stable content hash. Mutations ship only that
 * hash (plus the full config on first use, to register it) instead of
 * re-serialising the entire rule set into every call, every workpool chunk,
 * and every onComplete payload.
 */
import type { GraphConfig } from "./types";
/**
 * Stable marker embedded in the unregistered-config error. The client matches
 * on it to fall back to resending the full config when its local
 * "already registered" belief turns out to be stale (e.g. the registering
 * transaction rolled back after the client flipped its flag, or component
 * data was wiped/restored while a warm isolate still held the instance).
 */
export declare const CONFIG_UNREGISTERED_MARKER = "[convzibar:config-unregistered]";
/**
 * Resolve a compiled config by hash. When `maybeConfig` is supplied (the
 * client's first call for this hash) it is registered first. Throws if the
 * hash is unknown and no config was supplied — the caller must re-register.
 */
export declare function loadConfig(ctx: any, hash: string, maybeConfig?: GraphConfig): Promise<GraphConfig>;
//# sourceMappingURL=config.d.ts.map