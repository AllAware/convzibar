import {
  expandRelationTargets,
  iterateRelationTargets,
} from "../shared/relation-def";
import type { GraphConfig, ReadTimePath, TraversalRule } from "./types";

function expandRelation(
  schema: any,
  objectType: string,
  relation: string,
): string[] {
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
    const relDef = schema.entities[objectType]?.relations?.[exp];
    if (relDef) {
      const defs = Array.isArray(relDef) ? relDef : [relDef];
      for (const d of defs) {
        if (typeof d === "string") {
          if (d.includes("#")) {
            // Userset target `type#rel` — the reachable entity is `type`.
            // Without this, a dot-path readTimeRelation whose source relation
            // targets its intermediate only through a userset compiles with an
            // empty `sourceTypes`, silently denying at read time.
            const usersetType = d.split("#")[0];
            if (schema.entities[usersetType]) types.add(usersetType);
          } else if (schema.entities[d]) {
            types.add(d);
          }
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
  // reverse name, so we key by (objectType, relation, subjectType). We also
  // store the INVERSE mapping so the lookup works symmetrically from either
  // direction of the relationship.
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

  // Resolve reverse-edge target types into the receiving relation. When entity
  // A declares { type: 'B', reverse: 'foo' }, B.foo must include A as an
  // entity-type target so getTargetEntityTypes can discover what is reachable
  // through B.foo. If B.foo is still an undefined placeholder, set it to A;
  // if already populated (e.g. by .extend()), merge A in.
  for (const [entityType, relMap] of Object.entries(reverseEdges)) {
    for (const [relName] of Object.entries(relMap)) {
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
  // silently ignores them — turning a one-character typo into a silent
  // authorization gap. Surfacing it at schema load converts a
  // deny-when-should-grant bug into a load-time error. Runs AFTER reverse-edge
  // resolution so back-filled placeholder relations are seen as entity-typed.
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

  // Generate distant traversal rules with fully expanded local aliases.
  // Note: we do NOT emit rules for local inheritance — that is computed in
  // memory at read time to avoid write-time materialisation.
  for (const [entityType, def] of Object.entries(schema.entities || {})) {
    const relations = (def as any).relations || {};

    for (const [derivedRelName, relDef] of Object.entries(relations)) {
      const defs = Array.isArray(relDef) ? relDef : [relDef];

      for (const item of defs) {
        if (typeof item !== "string") continue;

        if (item.includes("#")) {
          // Userset expansion: e.g. 'group#viewer' on device's viewer relation
          // means "when a group is added as viewer of a device, expand through
          // that group's viewer relation to find transitive subjects." We
          // follow the local inheritance chain on the userset entity.
          const [usersetType, targetRelBase] = item.split("#");
          for (const target of expandRelation(schema, usersetType, targetRelBase)) {
            rules.push({
              sourceObjectType: entityType,
              sourceRelation: derivedRelName,
              targetRelation: target,
              derivedRelation: derivedRelName,
            });
          }
        } else if (item.includes(".")) {
          const [sourceRelBase, targetRelBase] = item.split(".");
          for (const source of expandRelation(schema, entityType, sourceRelBase)) {
            for (const targetType of getTargetEntityTypes(schema, entityType, source)) {
              for (const target of expandRelation(schema, targetType, targetRelBase)) {
                rules.push({
                  sourceObjectType: entityType,
                  sourceRelation: source,
                  targetRelation: target,
                  derivedRelation: derivedRelName,
                });
              }
            }
          }
        }
      }
    }
  }

  // Optimise traversal rules by pruning redundant local derivations. A rule is
  // dominated when another rule on the same trigger edge derives a relation
  // that the dominated rule's derived relation already contains via read-time
  // local inheritance (so a query for it still finds the survivor).
  const triggerGroups = new Map<string, TraversalRule[]>();
  for (const rule of rules) {
    const triggerKey = `${rule.sourceObjectType}:${rule.sourceRelation}:${rule.targetRelation}`;
    if (!triggerGroups.has(triggerKey)) triggerGroups.set(triggerKey, []);
    triggerGroups.get(triggerKey)!.push(rule);
  }

  const optimizedRules = rules.filter((ruleB) => {
    const triggerKey = `${ruleB.sourceObjectType}:${ruleB.sourceRelation}:${ruleB.targetRelation}`;
    const group = triggerGroups.get(triggerKey)!;
    const i = group.indexOf(ruleB);

    for (let j = 0; j < group.length; j++) {
      if (i === j) continue;
      const ruleA = group[j];
      const expandedB = expandRelation(
        schema,
        triggerKey.split(":")[0],
        ruleB.derivedRelation,
      );
      if (expandedB.includes(ruleA.derivedRelation)) {
        if (ruleA.derivedRelation === ruleB.derivedRelation) {
          if (i > j) return false; // dominated
        } else {
          return false; // dominated
        }
      }
    }
    return true;
  });

  // Collect read-time relation declarations. These deliberately produce NO
  // traversal rules — the BFS ignores them at write time.
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
        // The derived relation must declare `sourceType` as a typed target —
        // otherwise there's no way to write a subject of that type to it.
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
        const sourceTypes = getTargetEntityTypes(schema, entityType, sourceRelation);
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

  // Reject schemas whose read-time declarations form a cycle. A cyclic RT path
  // at runtime would silently return false when the depth cap is hit — a
  // denies-when-should-grant bug. Rejecting at schema load surfaces it early.
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
 * relation)` pairs; edges run from a derived relation to every relation the
 * target relation locally contains (mirroring runtime inheritance chaining).
 * Throws on the first cycle, with the full loop in the message.
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
      for (const member of expandRelationTargets(schema, sourceType, [
        rt.targetRelation,
      ])) {
        bucket.push(keyOf(sourceType, member));
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
