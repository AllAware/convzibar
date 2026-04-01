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

// Reverse of expandRelation: find all relations on entityType that
// include targetRelation through local inheritance. For example, if
// admin includes member, reverseExpandRelation('group', 'member')
// returns ['member', 'admin'].
function reverseExpandRelation(
  schema: any,
  entityType: string,
  targetRelation: string,
): Array<{ relation: string; condition?: string }> {
  const results: Array<{ relation: string; condition?: string }> = [];
  const relations = schema.entities[entityType]?.relations || {};

  for (const relName of Object.keys(relations)) {
    const expanded = expandRelation(schema, entityType, relName);
    for (const exp of expanded) {
      if (exp.relation === targetRelation) {
        results.push({ relation: relName, condition: exp.condition });
        break;
      }
    }
  }

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

          // Check if this is a userset reference (entityType.relation)
          // vs a relation-based traversal (localRelation.targetRelation).
          // A userset reference means: "when a subject of this entity type
          // is added to this relation, expand through that subject's relation."
          const isLocalRelation = relations[sourceRelBase] !== undefined;
          const isEntityType =
            schema.entities[sourceRelBase] !== undefined;

          if (!isLocalRelation && isEntityType) {
            // Userset expansion: e.g. 'group.member' on folder's editor relation
            // means "when a group is added as editor, expand through that group's
            // member relation to find transitive subjects."
            //
            // We use reverseExpandRelation to also find relations that IMPLY
            // the target through local inheritance. E.g., if admin includes member,
            // we generate rules for both admin and member so that admins of the
            // group also get the derived relation.
            const usersetType = sourceRelBase;
            const expandedTargets = expandRelation(
              schema,
              usersetType,
              targetRelBase,
            );

            for (const target of expandedTargets) {
              const impliedBy = reverseExpandRelation(
                schema,
                usersetType,
                target.relation,
              );

              for (const implied of impliedBy) {
                const combinedConditions: string[] = [];
                if (distantCondition) combinedConditions.push(distantCondition);
                if (target.condition) combinedConditions.push(target.condition);
                if (implied.condition) combinedConditions.push(implied.condition);
                const uniqueConditions = Array.from(
                  new Set(combinedConditions),
                );

                rules.push({
                  sourceObjectType: entityType,
                  sourceRelation: derivedRelName,
                  targetRelation: implied.relation,
                  derivedRelation: derivedRelName,
                  conditions:
                    uniqueConditions.length > 0 ? uniqueConditions : undefined,
                });
              }
            }
          } else {
            // Existing: relation-based distant traversal
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
                  if (distantCondition)
                    combinedConditions.push(distantCondition);
                  if (source.condition)
                    combinedConditions.push(source.condition);
                  if (target.condition)
                    combinedConditions.push(target.condition);

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
                      uniqueConditions.length > 0
                        ? uniqueConditions
                        : undefined,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  // Third pass: Optimize traversal rules by pruning redundant local derivations
  const triggerGroups = new Map<string, TraversalRule[]>();

  // Group rules by their trigger edge
  for (const rule of rules) {
    const triggerKey = `${rule.sourceObjectType}:${rule.sourceRelation}:${rule.targetRelation}`;
    if (!triggerGroups.has(triggerKey)) {
      triggerGroups.set(triggerKey, []);
    }
    triggerGroups.get(triggerKey)!.push(rule);
  }

  const optimizedRules = rules.filter((ruleB, _) => {
    const triggerKey = `${ruleB.sourceObjectType}:${ruleB.sourceRelation}:${ruleB.targetRelation}`;
    const group = triggerGroups.get(triggerKey)!;
    const i = group.indexOf(ruleB);

    let isDominated = false;
    for (let j = 0; j < group.length; j++) {
      if (i === j) continue;
      const ruleA = group[j];

      let conditionCompatible = false;
      if (!ruleA.conditions || ruleA.conditions.length === 0) {
        conditionCompatible = true;
      } else if (ruleB.conditions) {
        conditionCompatible = ruleA.conditions.every((c) =>
          ruleB.conditions!.includes(c),
        );
      }

      if (conditionCompatible) {
        const expandedB = expandRelation(
          schema,
          triggerKey.split(":")[0],
          ruleB.derivedRelation,
        );
        if (expandedB.some((exp) => exp.relation === ruleA.derivedRelation)) {
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
    return !isDominated;
  });

  return { traversalRules: optimizedRules, reverseEdges };
}
