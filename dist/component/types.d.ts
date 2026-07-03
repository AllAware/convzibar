export interface TraversalRule {
    sourceObjectType: string;
    sourceRelation: string;
    targetRelation?: string;
    derivedRelation: string;
}
/**
 * A dot-path relation that is evaluated at read time rather than materialised
 * at write time. Skips traversal-rule generation entirely, so writes incur no
 * extra cost; `can()` and `list()` instead walk the path with 2–3 indexed
 * queries at read time.
 *
 * `sourceTypes` is populated by the schema compiler from the (resolved) set
 * of entity types that `sourceRelation` targets on `objectType`.
 */
export interface ReadTimePath {
    objectType: string;
    derivedRelation: string;
    sourceRelation: string;
    targetRelation: string;
    sourceTypes: string[];
}
export interface GraphConfig {
    traversalRules: TraversalRule[];
    reverseEdges?: Record<string, Record<string, Record<string, string>>>;
    readTimePaths?: ReadTimePath[];
    maxWriteDepth?: number;
    maxChunkSize?: number;
    mockWorkpool?: boolean;
}
//# sourceMappingURL=types.d.ts.map