export interface TraversalRule {
  sourceObjectType: string;
  sourceRelation: string; // "parent_org"
  targetRelation: string; // "admin"
  derivedRelation: string; // "editor"
  condition?: string; // name of condition to apply
}

export interface GraphConfig {
  traversalRules: TraversalRule[];
  reverseEdges: Record<string, Record<string, string>>; // sourceObjectType -> relation -> reverseRelation
  maxWriteDepth?: number; // limits how deep relationship expansion can go (default 10)
  maxChunkSize?: number; // limits size of queue processed in one task
  mockWorkpool?: boolean; // testing escape hatch
}
