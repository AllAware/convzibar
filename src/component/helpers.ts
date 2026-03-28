import type { GraphConfig, TraversalRule } from "./types";

function expandRelation(
  schema: any,
  objectType: string,
  relation: string,
): Array<{ relation: string; condition?: string }> {
  const results: Array<{ relation: string; condition?: string }> = [];
  const expand = (rel: string, currentCondition?: string) => {
    if (
      results.some(
        (r) => r.relation === rel && r.condition === currentCondition,
      )
    )
      return;
    results.push({ relation: rel, condition: currentCondition });

    const relDef = schema.entities[objectType]?.relations?.[rel];
    if (relDef) {
      const defs = Array.isArray(relDef) ? relDef : [relDef];
      for (const d of defs) {
        if (typeof d === "string" && !d.includes(".")) {
          expand(d, currentCondition);
        } else if (typeof d === "object" && d !== null && "relation" in d) {
          if (
            typeof (d as any).relation === "string" &&
            !(d as any).relation.includes(".")
          ) {
            expand(
              (d as any).relation,
              (d as any).condition || currentCondition,
            );
          }
        }
      }
    }
  };
  expand(relation, undefined);
  return results;
}

function getTargetEntityTypes(
  schema: any,
  objectType: string,
  relation: string,
): string[] {
  const expanded = expandRelation(schema, objectType, relation);
  const types = new Set<string>();
  for (const exp of expanded) {
    const relDef = schema.entities[objectType]?.relations?.[exp.relation];
    if (relDef) {
      const defs = Array.isArray(relDef) ? relDef : [relDef];
      for (const d of defs) {
        if (typeof d === "string" && schema.entities[d]) {
          types.add(d);
        } else if (typeof d === "object" && d !== null && "type" in d) {
          if (
            typeof (d as any).type === "string" &&
            schema.entities[(d as any).type]
          ) {
            types.add((d as any).type);
          }
        }
      }
    }
  }
  return Array.from(types);
}

export function parseSchemaToGraphConfig(schema: any): GraphConfig {
  const rules: TraversalRule[] = [];
  const reverseEdges: Record<string, Record<string, string>> = {};

  // First pass: collect all reverse edges
  for (const [entityType, def] of Object.entries(schema.entities || {})) {
    const relations = (def as any).relations || {};
    for (const [relName, relDef] of Object.entries(relations)) {
      const defs = Array.isArray(relDef) ? relDef : [relDef];
      for (const item of defs) {
        if (typeof item === "object" && item !== null && "reverse" in item) {
          const objItem = item as { type: string; reverse?: string };
          if (objItem.reverse) {
            reverseEdges[entityType] = reverseEdges[entityType] || {};
            reverseEdges[entityType][relName] = objItem.reverse;
          }
        }
      }
    }
  }

  // Second pass: generate distant traversal rules with fully expanded local aliases
  // Note: we NO LONGER emit rules for local inheritance to avoid materialization!
  for (const [entityType, def] of Object.entries(schema.entities || {})) {
    const relations = (def as any).relations || {};

    for (const [derivedRelName, relDef] of Object.entries(relations)) {
      const defs = Array.isArray(relDef) ? relDef : [relDef];

      for (const item of defs) {
        let distantRel: string | undefined = undefined;
        let distantCondition: string | undefined = undefined;

        if (typeof item === "string" && item.includes(".")) {
          distantRel = item;
        } else if (
          typeof item === "object" &&
          item !== null &&
          "relation" in item
        ) {
          if (
            typeof (item as any).relation === "string" &&
            (item as any).relation.includes(".")
          ) {
            distantRel = (item as any).relation;
            distantCondition = (item as any).condition;
          }
        }

        if (distantRel) {
          const [sourceRelBase, targetRelBase] = distantRel.split(".");

          // Expand the source relation
          const expandedSources = expandRelation(
            schema,
            entityType,
            sourceRelBase,
          );

          for (const source of expandedSources) {
            // Determine the target entity types for this source relation
            const targetEntityTypes = getTargetEntityTypes(
              schema,
              entityType,
              source.relation,
            );

            for (const targetType of targetEntityTypes) {
              // Expand the target relation on the target entity type
              const expandedTargets = expandRelation(
                schema,
                targetType,
                targetRelBase,
              );

              for (const target of expandedTargets) {
                // Combine conditions
                const combinedConditions: string[] = [];
                if (distantCondition) combinedConditions.push(distantCondition);
                if (source.condition) combinedConditions.push(source.condition);
                if (target.condition) combinedConditions.push(target.condition);

                // Deduplicate conditions
                const uniqueConditions = Array.from(
                  new Set(combinedConditions),
                );

                rules.push({
                  sourceObjectType: entityType,
                  sourceRelation: source.relation,
                  targetRelation: target.relation,
                  derivedRelation: derivedRelName,
                  conditions:
                    uniqueConditions.length > 0 ? uniqueConditions : undefined,
                });
              }
            }
          }
        }
      }
    }
  }

  // Third pass: Optimize traversal rules by pruning redundant local derivations
  const optimizedRules: TraversalRule[] = [];
  const triggerGroups = new Map<string, TraversalRule[]>();

  // Group rules by their trigger edge
  for (const rule of rules) {
    const triggerKey = `${rule.sourceObjectType}:${rule.sourceRelation}:${rule.targetRelation}`;
    if (!triggerGroups.has(triggerKey)) {
      triggerGroups.set(triggerKey, []);
    }
    triggerGroups.get(triggerKey)!.push(rule);
  }

  for (const [triggerKey, group] of triggerGroups.entries()) {
    // Determine the source object type for this trigger
    const sourceObjectType = triggerKey.split(":")[0];

    for (let i = 0; i < group.length; i++) {
      let isDominated = false;
      const ruleB = group[i];

      for (let j = 0; j < group.length; j++) {
        if (i === j) continue;
        const ruleA = group[j];

        // Check condition compatibility: RuleA's conditions must be a subset of RuleB's
        // If RuleA has no conditions, it's always compatible.
        let conditionCompatible = false;
        if (!ruleA.conditions || ruleA.conditions.length === 0) {
          conditionCompatible = true;
        } else if (ruleB.conditions) {
          // Check if every condition in ruleA exists in ruleB
          conditionCompatible = ruleA.conditions.every((c) =>
            ruleB.conditions!.includes(c),
          );
        }

        if (conditionCompatible) {
          // Check local implication: Does ruleA.derivedRelation imply ruleB.derivedRelation?
          // Since ruleA and ruleB are in the same trigger group, they apply to the same source object.
          // Therefore, if ruleB's derived relation locally implies ruleA's derived relation (meaning
          // having ruleA is sufficient to satisfy ruleB), then ruleA dominates ruleB, meaning ruleB
          // is redundant and can be pruned.
          const expandedB = expandRelation(
            schema,
            sourceObjectType,
            ruleB.derivedRelation,
          );
          if (expandedB.some((exp) => exp.relation === ruleA.derivedRelation)) {
            // Break ties if two rules derive the exact same relation to prevent pruning both
            if (ruleA.derivedRelation === ruleB.derivedRelation) {
              if (i > j) {
                isDominated = true;
                break;
              }
            } else {
              isDominated = true;
              break;
            }
          }
        }
      }

      if (!isDominated) {
        optimizedRules.push(ruleB);
      }
    }
  }

  return { traversalRules: optimizedRules, reverseEdges };
}
