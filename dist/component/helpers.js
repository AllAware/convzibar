import { expandRelationTargets } from "../shared/relation-def";
function expandRelation(schema, objectType, relation) {
    return expandRelationTargets(schema, objectType, [relation], {
        strictLocalRefs: true,
    });
}
function getTargetEntityTypes(schema, objectType, relation) {
    const expanded = expandRelation(schema, objectType, relation);
    const types = new Set();
    for (const exp of expanded) {
        const relDef = schema.entities[objectType]?.relations?.[exp.relation];
        if (relDef) {
            const defs = Array.isArray(relDef) ? relDef : [relDef];
            for (const d of defs) {
                if (typeof d === "string" && schema.entities[d]) {
                    types.add(d);
                }
                else if (typeof d === "object" && d !== null && "type" in d) {
                    if (typeof d.type === "string" &&
                        schema.entities[d.type]) {
                        types.add(d.type);
                    }
                }
            }
        }
    }
    return Array.from(types);
}
export function parseSchemaToGraphConfig(schema) {
    // Deep-clone entities so that Pass 2 reverse-edge resolution does not
    // mutate the caller's schema object.
    schema = { ...schema, entities: JSON.parse(JSON.stringify(schema.entities || {})) };
    const rules = [];
    // reverseEdges: objectType -> relation -> subjectType -> reverseRelation
    const reverseEdges = {};
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
        const relations = def.relations || {};
        for (const [relName, relDef] of Object.entries(relations)) {
            const defs = Array.isArray(relDef) ? relDef : [relDef];
            for (const item of defs) {
                if (typeof item === "object" && item !== null && "reverse" in item) {
                    const objItem = item;
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
            if (!relDef)
                continue;
            const defs = Array.isArray(relDef) ? relDef : [relDef];
            for (const d of defs) {
                if (typeof d === "object" && d !== null && "reverse" in d) {
                    const receiverEntity = d.type;
                    const actualReverseName = d.reverse;
                    if (!actualReverseName)
                        continue;
                    const receiverRels = schema.entities[receiverEntity]?.relations;
                    if (!receiverRels)
                        continue;
                    const current = receiverRels[actualReverseName];
                    if (current === undefined) {
                        receiverRels[actualReverseName] = entityType;
                    }
                    else {
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
        const relations = def.relations || {};
        for (const [derivedRelName, relDef] of Object.entries(relations)) {
            const defs = Array.isArray(relDef) ? relDef : [relDef];
            for (const item of defs) {
                let traversalRel = undefined;
                let usersetRef = undefined;
                let refCondition = undefined;
                if (typeof item === "string") {
                    if (item.includes("#")) {
                        usersetRef = item;
                    }
                    else if (item.includes(".")) {
                        traversalRel = item;
                    }
                }
                else if (typeof item === "object" &&
                    item !== null &&
                    "relation" in item) {
                    const rel = item.relation;
                    if (typeof rel === "string") {
                        if (rel.includes("#")) {
                            usersetRef = rel;
                            refCondition = item.condition;
                        }
                        else if (rel.includes(".")) {
                            traversalRel = rel;
                            refCondition = item.condition;
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
                    const expandedTargets = expandRelation(schema, usersetType, targetRelBase);
                    for (const target of expandedTargets) {
                        const combinedConditions = [];
                        if (refCondition)
                            combinedConditions.push(refCondition);
                        if (target.condition)
                            combinedConditions.push(target.condition);
                        const uniqueConditions = Array.from(new Set(combinedConditions));
                        rules.push({
                            sourceObjectType: entityType,
                            sourceRelation: derivedRelName,
                            targetRelation: target.relation,
                            derivedRelation: derivedRelName,
                            conditions: uniqueConditions.length > 0 ? uniqueConditions : undefined,
                        });
                    }
                }
                if (traversalRel) {
                    const [sourceRelBase, targetRelBase] = traversalRel.split(".");
                    // Relation-based distant traversal
                    const expandedSources = expandRelation(schema, entityType, sourceRelBase);
                    for (const source of expandedSources) {
                        const targetEntityTypes = getTargetEntityTypes(schema, entityType, source.relation);
                        for (const targetType of targetEntityTypes) {
                            const expandedTargets = expandRelation(schema, targetType, targetRelBase);
                            for (const target of expandedTargets) {
                                const combinedConditions = [];
                                if (refCondition)
                                    combinedConditions.push(refCondition);
                                if (source.condition)
                                    combinedConditions.push(source.condition);
                                if (target.condition)
                                    combinedConditions.push(target.condition);
                                const uniqueConditions = Array.from(new Set(combinedConditions));
                                rules.push({
                                    sourceObjectType: entityType,
                                    sourceRelation: source.relation,
                                    targetRelation: target.relation,
                                    derivedRelation: derivedRelName,
                                    conditions: uniqueConditions.length > 0
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
    const triggerGroups = new Map();
    // Group rules by their trigger edge
    for (const rule of rules) {
        const triggerKey = `${rule.sourceObjectType}:${rule.sourceRelation}:${rule.targetRelation}`;
        if (!triggerGroups.has(triggerKey)) {
            triggerGroups.set(triggerKey, []);
        }
        triggerGroups.get(triggerKey).push(rule);
    }
    const optimizedRules = rules.filter((ruleB, _) => {
        const triggerKey = `${ruleB.sourceObjectType}:${ruleB.sourceRelation}:${ruleB.targetRelation}`;
        const group = triggerGroups.get(triggerKey);
        const i = group.indexOf(ruleB);
        let isDominated = false;
        for (let j = 0; j < group.length; j++) {
            if (i === j)
                continue;
            const ruleA = group[j];
            let conditionCompatible = false;
            if (!ruleA.conditions || ruleA.conditions.length === 0) {
                conditionCompatible = true;
            }
            else if (ruleB.conditions) {
                conditionCompatible = ruleA.conditions.every((c) => ruleB.conditions.includes(c));
            }
            if (conditionCompatible) {
                const expandedB = expandRelation(schema, triggerKey.split(":")[0], ruleB.derivedRelation);
                if (expandedB.some((exp) => exp.relation === ruleA.derivedRelation)) {
                    if (ruleA.derivedRelation === ruleB.derivedRelation) {
                        if (i > j) {
                            isDominated = true;
                            break;
                        }
                    }
                    else {
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
    const readTimePaths = [];
    for (const [entityType, def] of Object.entries(schema.entities || {})) {
        const rtRels = def.readTimeRelations;
        if (!rtRels)
            continue;
        for (const rt of rtRels) {
            if (rt.dotPath.includes("#")) {
                const [sourceType, targetRelation] = rt.dotPath.split("#");
                if (!sourceType || !targetRelation)
                    continue;
                // Validation: the derived relation must declare `sourceType` as a
                // typed target — otherwise there's no way to write a subject of
                // that type to the relation, and the RT declaration is dead weight.
                const derivedTargetTypes = getTargetEntityTypes(schema, entityType, rt.derivedRelation);
                if (!derivedTargetTypes.includes(sourceType)) {
                    throw new Error(`Zbar Schema Error: readTimeRelation('${rt.derivedRelation}', '${rt.dotPath}') on '${entityType}' requires '${rt.derivedRelation}' to declare '${sourceType}' as a typed target. Add it to the .relation('${rt.derivedRelation}', ...) declaration.`);
                }
                readTimePaths.push({
                    objectType: entityType,
                    derivedRelation: rt.derivedRelation,
                    sourceRelation: rt.derivedRelation,
                    targetRelation,
                    sourceTypes: [sourceType],
                });
            }
            else {
                const parts = rt.dotPath.split(".");
                if (parts.length !== 2)
                    continue;
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
    // Reject schemas whose read-time declarations form a cycle. A cyclic RT
    // path at runtime would either loop forever or — with the
    // `readTimeChainDepth` cap — silently return false when the cap is hit,
    // which is a denies-when-should-grant correctness bug. Rejecting at
    // schema load makes the problem surface at enableComponent time, long
    // before any request would see the wrong answer.
    if (readTimePaths.length > 0) {
        detectReadTimePathCycle(readTimePaths);
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
function detectReadTimePathCycle(paths) {
    const edges = new Map();
    const keyOf = (type, rel) => `${type}#${rel}`;
    for (const rt of paths) {
        const from = keyOf(rt.objectType, rt.derivedRelation);
        const bucket = edges.get(from) ?? [];
        for (const sourceType of rt.sourceTypes) {
            bucket.push(keyOf(sourceType, rt.targetRelation));
        }
        edges.set(from, bucket);
    }
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map();
    const stack = [];
    const visit = (node) => {
        const c = color.get(node) ?? WHITE;
        if (c === BLACK)
            return;
        if (c === GRAY) {
            const loopStart = stack.indexOf(node);
            const loop = [...stack.slice(loopStart), node].join(" → ");
            throw new Error(`Read-time relation declarations form a cycle: ${loop}. Break the loop by removing or restructuring one of the readTimeRelation() declarations on this chain.`);
        }
        color.set(node, GRAY);
        stack.push(node);
        for (const next of edges.get(node) ?? [])
            visit(next);
        stack.pop();
        color.set(node, BLACK);
    };
    for (const node of edges.keys())
        visit(node);
}
//# sourceMappingURL=helpers.js.map