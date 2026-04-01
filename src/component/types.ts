export interface TraversalRule {
  sourceObjectType: string;
  sourceRelation: string; // "parent_org"
  targetRelation?: string; // "admin" (optional for local inheritance)
  derivedRelation: string; // "editor"
  conditions?: string[]; // names of conditions to apply
}

export interface GraphConfig {
  traversalRules: TraversalRule[];
  maxWriteDepth?: number; // limits how deep relationship expansion can go (default 10)
  maxChunkSize?: number; // limits size of queue processed in one task
  mockWorkpool?: boolean; // testing escape hatch
}
