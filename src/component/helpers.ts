import type { GraphConfig, ReadTimePath, TraversalRule } from "./types";

function expandRelation(
  schema: any,
  objectType: string,
  relation: string,
): Array<{ relation: string; condition?: string }> {
  const results: Array<{ relation: string; condition?: string }> = [];
  const localRelations = schema.entities[objectType]?.relations || {};
  const expand = (rel: string, currentCondition?: string) => {
    if (
      results.some(
        (r) => r.relation === rel && r.condition === currentCondition,
      )
    )
      return;
    results.push({ relation: rel, condition: currentCondition });

    const relDef = localRelations[rel];
    if (relDef) {
      const defs = Array.isArray(relDef) ? relDef : [relDef];
      for (const d of defs) {
        // Only recurse into local relation references (not entity type targets,
        // dot-path traversals, or userset references).
        if (
          typeof d === "string" &&
          !d.includes(".") &&
          !d.includes("#") &&
          localRelations[d] !== undefined
        ) {
          expand(d, currentCondition);
        } else if (typeof d === "object" && d !== null && "relation" in d) {
          const rel = (d as any).relation;
          if (
            typeof rel === "string" &&
            !rel.includes(".") &&
            !rel.includes("#") &&
            localRelations[rel] !== undefined
          ) {
            expand(rel, (d as any).condition || currentCondition);
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
  // Deep-clone entities so that Pass 2 reverse-edge resolution does not
  // mutate the caller's schema object.
  schema = { ...schema, entities: JSON.parse(JSON.stringify(schema.entities || {})) };

  const rules: TraversalRule[] = [];
  // reverseEdges: objectType -> relation -> subjectType -> reverseRelation
  const reverseEdges: Record<string, Record<string, Record<string, string>>> =
    {};

  // First pass: collect all reverse edges declared via { type, reverse } syntax.
  // A single relation may target multiple entity types, each with its own
  // reverse name, so we key by (objectType, relation, subjectType).
  //
  // We also store the INVERSE mapping so the lookup works symmetrically from
  // either direction of the relationship. Given a declaration
  //   entityType.relName = { type: targetType, reverse: reverseRel }
  // the forward entry is reverseEdges[entityType][relName][targetType] = reverseRel
  // and the inverse entry is reverseEdges[targetType][reverseRel][entityType] = relName.
  // The initial-add lookup (reverseEdges[object.type][relation][subject.type])
  // matches forward when adding the declared direction and matches the
  // inverse when adding the reverse direction — giving bidirectional base
  // edge auto-insertion. The BFS-effective-reverse-edge lookup uses the same
  // key pattern, so derived relationships in either direction trigger the
  // corresponding reverse.
  for (const [entityType, def] of Object.entries(schema.entities || {})) {
    const relations = (def as any).relations || {};
    for (const [relName, relDef] of Object.entries(relations)) {
      const defs = Array.isArray(relDef) ? relDef : [relDef];
      for (const item of defs) {
        if (typeof item === "object" && item !== null && "reverse" in item) {
          const objItem = item as { type: string; reverse?: string };
          if (objItem.reverse) {
            reverseEdges[entityType] = reverseEdges[entityType] || {};
            reverseEdges[entityType][relName] =
              reverseEdges[entityType][relName] || {};
            reverseEdges[entityType][relName][objItem.type] = objItem.reverse;

            // Inverse entry for bidirectional lookup.
            reverseEdges[objItem.type] = reverseEdges[objItem.type] || {};
            reverseEdges[objItem.type][objItem.reverse] =
              reverseEdges[objItem.type][objItem.reverse] || {};
            reverseEdges[objItem.type][objItem.reverse][entityType] = relName;
          }
        }
      }
    }
  }

  // Resolve reverse-edge target types into the receiving relation.
  // When entity A declares { type: 'B', reverse: 'foo' }, B.foo must
  // include A as an entity-type target so that getTargetEntityTypes can
  // discover what types are reachable through B.foo.
  //
  // If B.foo is still an undefined placeholder, simply set it to A.
  // If B.foo was already populated (e.g. by .extend()), merge A into
  // the existing targets so the type information is not lost.
  for (const [entityType, relMap] of Object.entries(reverseEdges)) {
    for (const [relName, subjectMap] of Object.entries(relMap)) {
      const targetEntity = schema.entities[entityType];
      const relDef = targetEntity?.relations?.[relName];
      if (!relDef) continue;
      const defs = Array.isArray(relDef) ? relDef : [relDef];
      for (const d of defs) {
        if (typeof d === "object" && d !== null && "reverse" in d) {
          const receiverEntity = (d as any).type as string;
          const actualReverseName = (d as any).reverse as string;
          if (!actualReverseName) continue;
          const receiverRels = schema.entities[receiverEntity]?.relations;
          if (!receiverRels) continue;
          const current = receiverRels[actualReverseName];
          if (current === undefined) {
            receiverRels[actualReverseName] = entityType;
          } else {
            // Merge: ensure entityType is present as a target
            const currentArr = Array.isArray(current) ? current : [current];
            if (!currentArr.includes(entityType)) {
              currentArr.push(entityType);
              receiverRels[actualReverseName] =
                currentArr.length === 1 ? currentArr[0] : currentArr;
            }
          }
        }
      }
    }
  }

  // Generate distant traversal rules with fully expanded local aliases
  // Note: we NO LONGER emit rules for local inheritance to avoid materialization!
  for (const [entityType, def] of Object.entries(schema.entities || {})) {
    const relations = (def as any).relations || {};

    for (const [derivedRelName, relDef] of Object.entries(relations)) {
      const defs = Array.isArray(relDef) ? relDef : [relDef];

      for (const item of defs) {
        let traversalRel: string | undefined = undefined;
        let usersetRef: string | undefined = undefined;
        let refCondition: string | undefined = undefined;

        if (typeof item === "string") {
          if (item.includes("#")) {
            usersetRef = item;
          } else if (item.includes(".")) {
            traversalRel = item;
          }
        } else if (
          typeof item === "object" &&
          item !== null &&
          "relation" in item
        ) {
          const rel = (item as any).relation;
          if (typeof rel === "string") {
            if (rel.includes("#")) {
              usersetRef = rel;
              refCondition = (item as any).condition;
            } else if (rel.includes(".")) {
              traversalRel = rel;
              refCondition = (item as any).condition;
            }
          }
        }

        if (usersetRef) {
          // Userset expansion: e.g. 'group#viewer' on device's viewer relation
          // means "when a group is added as viewer of a device, expand through
          // that group's viewer relation to find transitive subjects."
          //
          // We use expandRelation to follow the local inheritance chain on the
          // userset entity. E.g., if viewer includes admin on the group entity,
          // expandRelation('viewer') = ['viewer', 'admin'], so we also check
          // admin records — because admins are implicitly viewers.
          const [usersetType, targetRelBase] = usersetRef.split("#");
          const expandedTargets = expandRelation(
            schema,
            usersetType,
            targetRelBase,
          );

          for (const target of expandedTargets) {
            const combinedConditions: string[] = [];
            if (refCondition) combinedConditions.push(refCondition);
            if (target.condition) combinedConditions.push(target.condition);
            const uniqueConditions = Array.from(
              new Set(combinedConditions),
            );

            rules.push({
              sourceObjectType: entityType,
              sourceRelation: derivedRelName,
              targetRelation: target.relation,
              derivedRelation: derivedRelName,
              conditions:
                uniqueConditions.length > 0 ? uniqueConditions : undefined,
            });
          }
        }

        if (traversalRel) {
          const [sourceRelBase, targetRelBase] = traversalRel.split(".");

          // Relation-based distant traversal
          const expandedSources = expandRelation(
            schema,
            entityType,
            sourceRelBase,
          );

          for (const source of expandedSources) {
            const targetEntityTypes = getTargetEntityTypes(
              schema,
              entityType,
              source.relation,
            );

            for (const targetType of targetEntityTypes) {
              const expandedTargets = expandRelation(
                schema,
                targetType,
                targetRelBase,
              );

              for (const target of expandedTargets) {
                const combinedConditions: string[] = [];
                if (refCondition)
                  combinedConditions.push(refCondition);
                if (source.condition)
                  combinedConditions.push(source.condition);
                if (target.condition)
                  combinedConditions.push(target.condition);

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

  // Collect read-time relation declarations. These deliberately produce NO
  // traversal rules — the BFS ignores them at write time. `can()` and
  // `list()` evaluate them on demand.
  //
  // `sourceTypes` is resolved from the (now placeholder-filled) schema so
  // the client can walk the first hop without re-running schema resolution
  // at read time.
  const readTimePaths: ReadTimePath[] = [];
  for (const [entityType, def] of Object.entries(schema.entities || {})) {
    const rtRels = (def as any).readTimeRelations as
      | Array<{ derivedRelation: string; dotPath: string }>
      | undefined;
    if (!rtRels) continue;
    for (const rt of rtRels) {
      const parts = rt.dotPath.split(".");
      if (parts.length !== 2) continue;
      const [sourceRelation, targetRelation] = parts;
      const sourceTypes = getTargetEntityTypes(
        schema,
        entityType,
        sourceRelation,
      );
      readTimePaths.push({
        objectType: entityType,
        derivedRelation: rt.derivedRelation,
        sourceRelation,
        targetRelation,
        sourceTypes,
      });
    }
  }

  return {
    traversalRules: optimizedRules,
    reverseEdges: Object.keys(reverseEdges).length > 0 ? reverseEdges : undefined,
    readTimePaths: readTimePaths.length > 0 ? readTimePaths : undefined,
  };
}
