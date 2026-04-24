/**
 * Shared helpers for the `${type}:${id}` scope-key convention used by
 * `effectiveRelationships.subjectKey` / `objectKey`. One module — one
 * implementation — so the convention can't silently drift.
 */

export function buildScopeKey(type: string, id: string): string {
  return `${type}:${id}`;
}

/**
 * Decode `${type}:${id}` preserving any colons in `id`. The naive
 * `split(":")` truncates ids that themselves contain a colon, silently
 * matching the wrong row.
 */
export function decodeScopeKey(scopeKey: string): [type: string, id: string] {
  const idx = scopeKey.indexOf(":");
  return [scopeKey.slice(0, idx), scopeKey.slice(idx + 1)];
}

export function entityFromKey(scopeKey: string): { type: string; id: string } {
  const [type, id] = decodeScopeKey(scopeKey);
  return { type, id };
}

export function idFromKey(scopeKey: string): string {
  const idx = scopeKey.indexOf(":");
  return scopeKey.slice(idx + 1);
}
