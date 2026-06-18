import {
  expandRelationTargets,
  iterateRelationTargets,
} from "../shared/relation-def";
import type { GraphConfig, ReadTimePath, TraversalRule } from "./types";

function expandRelation(
  schema: any,
  objectType: string,
  relation: string,
): Array<{ relation: string; condition?: string }> {
  return expandRelationTargets(schema, objectType, [relation], {
    strictLocalRefs: true,
  });
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
        if (typeof d === "string") {
          if (d.includes("#")) {
            // Userset target `type#rel` — the reachable entity is `type`.
            // Without this, a dot-path readTimeRelation whose source relation
            // targets its intermediate only through a userset compiled with an
            // empty `sourceTypes`, silently denying at read time.
            const usersetType = d.split("#")[0];
            if (schema.entities[usersetType]) types.add(usersetType);
          } else if (schema.entities[d]) {
            types.add(d);
          }
        } else if (typeof d === "object" && d !== null) {
          if (
            "type" in d &&
            typeof (d as any).type === "string" &&
            schema.entities[(d as any).type]
          ) {
            types.add((d as any).type);
          } else if (
            "relation" in d &&
            typeof (d as any).relation === "string" &&
            (d as any).relation.includes("#")
          ) {
            const usersetType = (d as any).relation.split("#")[0];
            if (schema.entities[usersetType]) types.add(usersetType);
          }
        }
      }
    }
  }
  return Array.from(types);
}

export function parseSchemaToGraphConfig(schema: any): GraphConfig {
  // Deep-clone entities so that Pass 2 reverse-edge resolution does not
  // mutate the caller's schema object. Use structuredClone rather than a
  // JSON round-trip: JSON.stringify silently DROPS keys whose value is
  // `undefined`, which is exactly how placeholder relations are stored
  // (`.relation('admin')` with no target). Dropping them detaches any
  // local-inheritance reference to a placeholder (e.g. `viewer: 'admin'`
  // where `admin` is RT-derived), turning it into an "unknown" target.
  schema = { ...schema, entities: structuredClone(schema.entities || {}) };

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

  // Reject bare-string relation targets that resolve to neither a declared
  // relation on the owning entity nor a known entity type. classifyStringRef
  // tags these as `kind: "unknown"`, after which every downstream consumer
  // (validation, rule generation, traversal) silently ignores them — turning
  // a one-character typo into a silent authorization gap. Surfacing it at
  // schema load converts a deny-when-should-grant bug into a load-time error.
  // Runs AFTER reverse-edge resolution so back-filled placeholder relations
  // are seen as entity-typed targets rather than "unknown".
  for (const [entityType, def] of Object.entries(schema.entities || {})) {
    const relations = ((def as any).relations || {}) as Record<string, unknown>;
    const classifyCtx = {
      localRelations: relations,
      entities: schema.entities as Record<string, unknown>,
    };
    for (const [relName, relDef] of Object.entries(relations)) {
      for (const target of iterateRelationTargets(relDef, classifyCtx)) {
        if (target.kind === "unknown") {
          const knownRelations = Object.keys(relations).filter(
            (r) => r !== relName,
          );
          const knownEntities = Object.keys(schema.entities || {});
          throw new Error(
            `Zbar Schema Error: relation '${relName}' on '${entityType}' references '${target.raw}', ` +
              `which is neither a relation declared on '${entityType}' nor a known entity type. ` +
              `Use a declared relation [${knownRelations.join(", ")}], an entity type [${knownEntities.join(", ")}], ` +
              `a dot-path ('source.target'), or a userset ('type#relation').`,
          );
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
  // Two path shapes land here:
  //   • dot-path `source.target` → sourceRelation=source, sourceTypes
  //     resolved from the (placeholder-filled) schema, targetRelation=target.
  //   • userset  `type#target`   → sourceRelation=derivedRelation (the
  //     relation subjects of `type` are written into), sourceTypes=[type],
  //     targetRelation=target. Validated against the derivedRelation's
  //     declared typed targets so a broken declaration fails at schema load
  //     instead of silently returning empty at read time.
  const readTimePaths: ReadTimePath[] = [];
  for (const [entityType, def] of Object.entries(schema.entities || {})) {
    const rtRels = (def as any).readTimeRelations as
      | Array<{ derivedRelation: string; dotPath: string }>
      | undefined;
    if (!rtRels) continue;
    for (const rt of rtRels) {
      if (rt.dotPath.includes("#")) {
        const [sourceType, targetRelation] = rt.dotPath.split("#");
        if (!sourceType || !targetRelation) continue;
        // Validation: the derived relation must declare `sourceType` as a
        // typed target — otherwise there's no way to write a subject of
        // that type to the relation, and the RT declaration is dead weight.
        const derivedTargetTypes = getTargetEntityTypes(
          schema,
          entityType,
          rt.derivedRelation,
        );
        if (!derivedTargetTypes.includes(sourceType)) {
          throw new Error(
            `Zbar Schema Error: readTimeRelation('${rt.derivedRelation}', '${rt.dotPath}') on '${entityType}' requires '${rt.derivedRelation}' to declare '${sourceType}' as a typed target. Add it to the .relation('${rt.derivedRelation}', ...) declaration.`,
          );
        }
        readTimePaths.push({
          objectType: entityType,
          derivedRelation: rt.derivedRelation,
          sourceRelation: rt.derivedRelation,
          targetRelation,
          sourceTypes: [sourceType],
        });
      } else {
        const parts = rt.dotPath.split(".");
        if (parts.length !== 2) {
          throw new Error(
            `Zbar Schema Error: readTimeRelation('${rt.derivedRelation}', '${rt.dotPath}') on '${entityType}' must be a single dot-path of the form 'source.target' (exactly one '.'). Got ${parts.length} segment(s).`,
          );
        }
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
  }

  // Reject schemas whose read-time declarations form a cycle. A cyclic RT
  // path at runtime would either loop forever or — with the
  // `readTimeChainDepth` cap — silently return false when the cap is hit,
  // which is a denies-when-should-grant correctness bug. Rejecting at
  // schema load makes the problem surface at enableComponent time, long
  // before any request would see the wrong answer.
  if (readTimePaths.length > 0) {
    detectReadTimePathCycle(readTimePaths, schema);
  }

  return {
    traversalRules: optimizedRules,
    reverseEdges: Object.keys(reverseEdges).length > 0 ? reverseEdges : undefined,
    readTimePaths: readTimePaths.length > 0 ? readTimePaths : undefined,
  };
}

/**
 * 3-color DFS over the read-time-path graph. Nodes are `(entityType,
 * relation)` pairs; edges run from a derived relation to the target
 * relation on each of its declared source types. Throws on the first
 * cycle encountered, with the full loop in the error message.
 */
function detectReadTimePathCycle(
  paths: readonly ReadTimePath[],
  schema: any,
): void {
  const edges = new Map<string, string[]>();
  const keyOf = (type: string, rel: string) => `${type}#${rel}`;
  for (const rt of paths) {
    const from = keyOf(rt.objectType, rt.derivedRelation);
    const bucket = edges.get(from) ?? [];
    for (const sourceType of rt.sourceTypes) {
      // Mirror runtime chaining: `rtBranches` recurses into
      // resolveRelationInheritance(sourceType, targetRelation), so a cycle
      // can close through ANY relation that `targetRelation` locally
      // contains — not just `targetRelation` itself. Building only the
      // literal edge here misses inheritance-closing loops, which then run
      // to `readTimeChainDepth` at runtime and silently deny.
      for (const member of expandRelationTargets(schema, sourceType, [
        rt.targetRelation,
      ])) {
        bucket.push(keyOf(sourceType, member.relation));
      }
    }
    edges.set(from, bucket);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (node: string): void => {
    const c = color.get(node) ?? WHITE;
    if (c === BLACK) return;
    if (c === GRAY) {
      const loopStart = stack.indexOf(node);
      const loop = [...stack.slice(loopStart), node].join(" → ");
      throw new Error(
        `Read-time relation declarations form a cycle: ${loop}. Break the loop by removing or restructuring one of the readTimeRelation() declarations on this chain.`,
      );
    }
    color.set(node, GRAY);
    stack.push(node);
    for (const next of edges.get(node) ?? []) visit(next);
    stack.pop();
    color.set(node, BLACK);
  };

  for (const node of edges.keys()) visit(node);
}
