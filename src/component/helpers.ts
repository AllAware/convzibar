import type { GraphConfig, TraversalRule } from "./types";

export function parseSchemaToGraphConfig(schema: any): GraphConfig {
  const rules: TraversalRule[] = [];
  const reverseEdges: Record<string, Record<string, string>> = {};

  for (const [entityType, def] of Object.entries(schema.entities || {})) {
    const relations = (def as any).relations || {};

    for (const [relName, relDef] of Object.entries(relations)) {
      const defs = Array.isArray(relDef) ? relDef : [relDef];

      for (const item of defs) {
        if (typeof item === "string") {
          if (item.includes(".")) {
            // e.g., "parent_org.admin" -> traversal rule
            const [sourceRel, targetRel] = item.split(".");
            rules.push({
              sourceObjectType: entityType,
              sourceRelation: sourceRel,
              targetRelation: targetRel,
              derivedRelation: relName,
            });
          }
        } else if (typeof item === "object" && item !== null) {
          // It's an object with reverse edge or condition
          if ("reverse" in item) {
            const objItem = item as { type: string; reverse?: string };
            if (objItem.reverse) {
              reverseEdges[entityType] = reverseEdges[entityType] || {};
              reverseEdges[entityType][relName] = objItem.reverse;
            }
          } else if ("relation" in item) {
            const objItem = item as { relation: string; condition: string };
            if (objItem.relation.includes(".")) {
              const [sourceRel, targetRel] = objItem.relation.split(".");
              rules.push({
                sourceObjectType: entityType,
                sourceRelation: sourceRel,
                targetRelation: targetRel,
                derivedRelation: relName,
                condition: objItem.condition,
              });
            }
          }
        }
      }
    }
  }

  return { traversalRules: rules, reverseEdges };
}
