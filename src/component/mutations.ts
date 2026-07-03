import { v } from "convex/values";
import { buildScopeKey } from "../shared/keys";
import { internal } from "./_generated/api";
import { internalMutation, mutation } from "./_generated/server";
import { loadConfig } from "./config";
import { applyTraversalRulesToItem, collectRuleDerivations } from "./expand";
import { canonicalizePath, pathKey } from "./paths";
import { runOrEnqueue } from "./runOrEnqueue";
import type { GraphConfig } from "./types";
import {
  objectValidator,
  propertiesValidator,
  subjectValidator,
} from "./validators";

type Entity = { type: string; id: string };

// The config arg shape shared by every public mutation: the client always
// sends the content hash, and additionally the full compiled config the first
// time it uses a hash (which the component registers).
const configHashArg = v.string();
const graphConfigArg = v.optional(v.any());

// ---------------------------------------------------------------------------
// Reverse-edge helpers (single source of truth — used by add/remove/delete).
// ---------------------------------------------------------------------------

function reverseEdgeName(
  config: GraphConfig,
  objectType: string,
  relation: string,
  subjectType: string,
): string | undefined {
  return config.reverseEdges?.[objectType]?.[relation]?.[subjectType];
}

async function findRelationship(
  ctx: any,
  subject: Entity,
  relation: string,
  object: Entity,
) {
  return ctx.db
    .query("relationships")
    .withIndex("by_subject_relation_object", (q: any) =>
      q
        .eq("subjectType", subject.type)
        .eq("subjectId", subject.id)
        .eq("relation", relation)
        .eq("objectType", object.type)
        .eq("objectId", object.id),
    )
    .unique();
}

/**
 * If `(subject)-[relation]->(object)` declares a reverse, insert the mirrored
 * base edge (unless it already exists) and return its descriptor for queueing.
 */
async function insertReverseEdge(
  ctx: any,
  config: GraphConfig,
  subject: Entity,
  relation: string,
  object: Entity,
): Promise<{ revId: string; reverseRel: string } | null> {
  const reverseRel = reverseEdgeName(config, object.type, relation, subject.type);
  if (!reverseRel) return null;
  const existing = await findRelationship(ctx, object, reverseRel, subject);
  if (existing) return null;
  const revId = await ctx.db.insert("relationships", {
    subjectType: object.type,
    subjectId: object.id,
    relation: reverseRel,
    objectType: subject.type,
    objectId: subject.id,
  });
  return { revId, reverseRel };
}

/** Mirror of `insertReverseEdge` for removal. */
async function deleteReverseEdge(
  ctx: any,
  config: GraphConfig,
  subject: Entity,
  relation: string,
  object: Entity,
): Promise<{ revId: string; reverseRel: string } | null> {
  const reverseRel = reverseEdgeName(config, object.type, relation, subject.type);
  if (!reverseRel) return null;
  const existing = await findRelationship(ctx, object, reverseRel, subject);
  if (!existing) return null;
  await ctx.db.delete(existing._id);
  return { revId: existing._id, reverseRel };
}

// ---------------------------------------------------------------------------
// addRelation
// ---------------------------------------------------------------------------

export const addRelation = mutation({
  args: {
    subject: subjectValidator,
    relation: v.string(),
    object: objectValidator,
    properties: propertiesValidator,
    configHash: configHashArg,
    graphConfig: graphConfigArg,
    asyncWrites: v.optional(v.boolean()),
    onComplete: v.optional(v.any()),
  },
  handler: async (ctx: any, args: any) => {
    const config = await loadConfig(ctx, args.configHash, args.graphConfig);
    return addRelationInternal(ctx, { ...args, config });
  },
});

async function addRelationInternal(ctx: any, args: any): Promise<string> {
  const { subject, relation, object, properties, onComplete, configHash, asyncWrites } = args;
  const config = args.config as GraphConfig;

  const existingRel = await findRelationship(ctx, subject, relation, object);

  if (existingRel) {
    // Only `properties` can differ now (conditions are gone). Patch in place;
    // properties live on the base edge and are not replicated through the BFS.
    if (
      properties !== undefined &&
      JSON.stringify(existingRel.properties ?? null) !==
        JSON.stringify(properties ?? null)
    ) {
      await ctx.db.patch(existingRel._id, { properties });
    }
    if (onComplete) await executeOnComplete(ctx, onComplete, config, configHash, asyncWrites);
    return existingRel._id;
  }

  const relId = await ctx.db.insert("relationships", {
    subjectType: subject.type,
    subjectId: subject.id,
    relation,
    objectType: object.type,
    objectId: object.id,
    properties,
  });

  const queue: any[] = [
    {
      subject,
      relation,
      object,
      path: { baseIds: [relId] },
      depth: 1,
      // The auto-inserted reverse below handles the base-reverse side for this
      // explicit add; skip the BFS effective-reverse push here to avoid
      // duplicate effective paths for the same underlying base pair.
      skipReverse: true,
    },
  ];

  const rev = await insertReverseEdge(ctx, config, subject, relation, object);
  if (rev) {
    queue.push({
      subject: object,
      relation: rev.reverseRel,
      object: subject,
      path: { baseIds: [rev.revId] },
      depth: 1,
      skipReverse: true,
    });
  }

  await runOrEnqueue(ctx, {
    asyncWrites,
    mockWorkpool: config.mockWorkpool,
    chunkRef: internal.mutations.processAddChunk,
    payload: { baseRelId: relId, queue, configHash, onComplete, asyncWrites: asyncWrites ?? false },
    inlineFn: (c, p) => processAddChunkInternal(c, { ...p, config }),
  });

  return relId;
}

export const processAddChunk = internalMutation({
  args: {
    baseRelId: v.id("relationships"),
    queue: v.array(v.any()),
    configHash: v.string(),
    onComplete: v.optional(v.any()),
    asyncWrites: v.optional(v.boolean()),
  },
  handler: async (ctx: any, args: any) => {
    const config = await loadConfig(ctx, args.configHash);
    await processAddChunkInternal(ctx, { ...args, config });
  },
});

async function processAddChunkInternal(ctx: any, args: any): Promise<void> {
  const { baseRelId, queue, onComplete, asyncWrites, configHash } = args;
  const config = args.config as GraphConfig;

  // Abort if the base relationship was deleted by a rapid subsequent update,
  // but still fire cleanups so nothing is orphaned.
  const baseRel = await ctx.db.get(baseRelId);
  if (!baseRel) {
    if (onComplete) await executeOnComplete(ctx, onComplete, config, configHash, asyncWrites);
    return;
  }

  const CHUNK_SIZE = config.maxChunkSize ?? 50;
  let processed = 0;

  while (queue.length > 0 && (!asyncWrites || processed < CHUNK_SIZE)) {
    processed++;
    const current = queue.shift()!;
    const sKey = buildScopeKey(current.subject.type, current.subject.id);
    const oKey = buildScopeKey(current.object.type, current.object.id);

    let eff = await ctx.db
      .query("effectiveRelationships")
      .withIndex("by_subject_relation_object", (q: any) =>
        q.eq("subjectKey", sKey).eq("relation", current.relation).eq("objectKey", oKey),
      )
      .unique();

    let isNewOrUpdated = false;
    const currentPathKey = pathKey(current.path);
    const canonicalCurrentPath = canonicalizePath(current.path);

    if (!eff) {
      eff = {
        _id: await ctx.db.insert("effectiveRelationships", {
          subjectKey: sKey,
          relation: current.relation,
          objectKey: oKey,
          paths: [canonicalCurrentPath],
        }),
      };
      isNewOrUpdated = true;
    } else if (!eff.paths.some((p: any) => pathKey(p) === currentPathKey)) {
      await ctx.db.patch(eff._id, { paths: [...eff.paths, canonicalCurrentPath] });
      isNewOrUpdated = true;
    }

    if (isNewOrUpdated) {
      await applyTraversalRulesToItem(ctx, { current, queue, graphConfig: config });
    }
  }

  if (queue.length > 0) {
    if (asyncWrites) {
      await runOrEnqueue(ctx, {
        asyncWrites,
        mockWorkpool: config.mockWorkpool,
        chunkRef: internal.mutations.processAddChunk,
        payload: { baseRelId, queue, configHash, onComplete, asyncWrites },
      });
    }
  } else if (onComplete) {
    await executeOnComplete(ctx, onComplete, config, configHash, asyncWrites);
  }
}

// ---------------------------------------------------------------------------
// onComplete (Add-Before-Remove chaining)
// ---------------------------------------------------------------------------

async function executeOnComplete(
  ctx: any,
  onComplete: any,
  config: GraphConfig,
  configHash: string,
  asyncWrites?: boolean,
): Promise<void> {
  if (!onComplete) return;

  const kind =
    onComplete.action === "removeRelationBatch"
      ? "removeRelation"
      : onComplete.action === "enqueueRemoveChunkBatch"
        ? "enqueueRemoveChunk"
        : onComplete.action;
  const isBatch =
    onComplete.action === "removeRelationBatch" ||
    onComplete.action === "enqueueRemoveChunkBatch";
  const argsList: any[] = isBatch ? onComplete.args : [onComplete.args];

  for (const a of argsList) {
    if (kind === "removeRelation") {
      await removeRelationInternal(ctx, { ...a, config, configHash, asyncWrites });
    } else if (kind === "enqueueRemoveChunk") {
      await runOrEnqueue(ctx, {
        asyncWrites,
        mockWorkpool: config.mockWorkpool,
        chunkRef: internal.mutations.processRemoveChunk,
        payload: { queue: a.queue, configHash, asyncWrites },
        inlineFn: (c, p) => processRemoveChunkInternal(c, { ...p, config }),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// removeRelation
// ---------------------------------------------------------------------------

/** Delete a base edge (+ its declared reverse) and return the cascade seed queue. */
async function deleteBaseRelation(ctx: any, config: GraphConfig, existingRel: any) {
  const subject = { type: existingRel.subjectType, id: existingRel.subjectId };
  const object = { type: existingRel.objectType, id: existingRel.objectId };
  await ctx.db.delete(existingRel._id);

  const queue: any[] = [
    { subject, relation: existingRel.relation, object, removedRelationId: existingRel._id },
  ];
  const rev = await deleteReverseEdge(ctx, config, subject, existingRel.relation, object);
  if (rev) {
    queue.push({ subject: object, relation: rev.reverseRel, object: subject, removedRelationId: rev.revId });
  }
  return { queue };
}

async function removeRelationInternal(
  ctx: any,
  args: any,
): Promise<false | { removed: true; effectiveRelationshipsRemoved: number }> {
  const { subject, relation, object, configHash, asyncWrites } = args;
  const config = args.config as GraphConfig;

  const existingRel = await findRelationship(ctx, subject, relation, object);
  if (!existingRel) return false;

  const { queue } = await deleteBaseRelation(ctx, config, existingRel);

  const inlineRemoved = await runOrEnqueue<number>(ctx, {
    asyncWrites,
    mockWorkpool: config.mockWorkpool,
    chunkRef: internal.mutations.processRemoveChunk,
    payload: { queue, configHash, asyncWrites },
    inlineFn: (c, p) => processRemoveChunkInternal(c, { ...p, config }),
  });

  return { removed: true, effectiveRelationshipsRemoved: inlineRemoved ?? 0 };
}

export const processRemoveChunk = internalMutation({
  args: {
    queue: v.array(v.any()),
    configHash: v.string(),
    asyncWrites: v.optional(v.boolean()),
  },
  handler: async (ctx: any, args: any) => {
    const config = await loadConfig(ctx, args.configHash);
    await processRemoveChunkInternal(ctx, { ...args, config });
  },
});

async function processRemoveChunkInternal(ctx: any, args: any): Promise<number> {
  const { queue, configHash, asyncWrites } = args;
  const config = args.config as GraphConfig;
  let removedCount = 0;
  const CHUNK_SIZE = config.maxChunkSize ?? 50;
  let processed = 0;
  const seen = new Set<string>();

  const queueKey = (s: Entity, rel: string, o: Entity, id: string) =>
    `${buildScopeKey(s.type, s.id)}:${rel}:${buildScopeKey(o.type, o.id)}:${id}`;

  for (const item of queue) {
    seen.add(queueKey(item.subject, item.relation, item.object, item.removedRelationId));
  }

  while (queue.length > 0 && (!asyncWrites || processed < CHUNK_SIZE)) {
    processed++;
    const current = queue.shift()!;
    const sKey = buildScopeKey(current.subject.type, current.subject.id);
    const oKey = buildScopeKey(current.object.type, current.object.id);
    const cascadeId = current.removedRelationId;

    const eff = await ctx.db
      .query("effectiveRelationships")
      .withIndex("by_subject_relation_object", (q: any) =>
        q.eq("subjectKey", sKey).eq("relation", current.relation).eq("objectKey", oKey),
      )
      .unique();
    if (!eff) continue;

    const remainingPaths = eff.paths.filter(
      (p: any) => !p.baseIds || !p.baseIds.includes(cascadeId),
    );

    let shouldCascade = false;
    if (remainingPaths.length === 0) {
      await ctx.db.delete(eff._id);
      removedCount++;
      shouldCascade = true;
    } else if (remainingPaths.length !== eff.paths.length) {
      await ctx.db.patch(eff._id, { paths: remainingPaths });
      shouldCascade = true;
    }

    if (!shouldCascade) continue;

    // Propagate the token deletion downstream through the same rule matching
    // the add-path BFS uses (shared via collectRuleDerivations).
    const enqueue = (s: Entity, rel: string, o: Entity) => {
      const k = queueKey(s, rel, o, cascadeId);
      if (seen.has(k)) return;
      seen.add(k);
      queue.push({ subject: s, relation: rel, object: o, removedRelationId: cascadeId });
    };

    for (const { rule, derivedSubject, derivedObject } of await collectRuleDerivations(
      ctx,
      current,
      config,
    )) {
      enqueue(derivedSubject, rule.derivedRelation, derivedObject);
    }

    // Effective reverse-edge cascade (mirror of the add path).
    const reverseRel = reverseEdgeName(
      config,
      current.object.type,
      current.relation,
      current.subject.type,
    );
    if (reverseRel) {
      enqueue(current.object, reverseRel, current.subject);
    }
  }

  if (queue.length > 0 && asyncWrites) {
    await runOrEnqueue(ctx, {
      asyncWrites,
      mockWorkpool: config.mockWorkpool,
      chunkRef: internal.mutations.processRemoveChunk,
      payload: { queue, configHash, asyncWrites },
    });
  }

  return removedCount;
}

export const removeRelation = mutation({
  args: {
    subject: subjectValidator,
    relation: v.string(),
    object: objectValidator,
    configHash: configHashArg,
    graphConfig: graphConfigArg,
    asyncWrites: v.optional(v.boolean()),
  },
  handler: async (ctx: any, args: any) => {
    const config = await loadConfig(ctx, args.configHash, args.graphConfig);
    const res = await removeRelationInternal(ctx, { ...args, config });
    return res ? res.removed : false;
  },
});

// ---------------------------------------------------------------------------
// updateRelation / setRelation (Add-Before-Remove)
// ---------------------------------------------------------------------------

export const updateRelation = mutation({
  args: {
    subject: subjectValidator,
    oldRelation: v.string(),
    newRelation: v.string(),
    object: objectValidator,
    properties: propertiesValidator,
    configHash: configHashArg,
    graphConfig: graphConfigArg,
    asyncWrites: v.optional(v.boolean()),
  },
  handler: async (ctx: any, args: any) => {
    const { subject, oldRelation, newRelation, object, properties, configHash, asyncWrites } = args;
    const config = await loadConfig(ctx, configHash, args.graphConfig);

    let onComplete: any = undefined;
    const existingOldRel = await findRelationship(ctx, subject, oldRelation, object);
    if (existingOldRel) {
      const removedData = await deleteBaseRelation(ctx, config, existingOldRel);
      onComplete = { action: "enqueueRemoveChunk", args: removedData };
    }

    return addRelationInternal(ctx, {
      subject,
      relation: newRelation,
      object,
      properties,
      config,
      configHash,
      asyncWrites,
      onComplete,
    });
  },
});

export const setRelation = mutation({
  args: {
    subject: subjectValidator,
    relation: v.string(),
    object: objectValidator,
    objectRelations: v.array(v.string()),
    properties: propertiesValidator,
    configHash: configHashArg,
    graphConfig: graphConfigArg,
    asyncWrites: v.optional(v.boolean()),
  },
  handler: async (ctx: any, args: any) => {
    const { subject, relation, object, objectRelations, properties, configHash, asyncWrites } = args;
    const config = await loadConfig(ctx, configHash, args.graphConfig);

    const queries = objectRelations
      .filter((r: string) => r !== relation)
      .map((candidateRel: string) => findRelationship(ctx, subject, candidateRel, object));
    const results = await Promise.all(queries);
    const relationsToDrop = results.filter((r: any) => r !== null);

    const onCompleteArgs = [];
    for (const r of relationsToDrop) {
      onCompleteArgs.push(await deleteBaseRelation(ctx, config, r));
    }

    const onComplete =
      onCompleteArgs.length > 0
        ? { action: "enqueueRemoveChunkBatch", args: onCompleteArgs }
        : undefined;

    return addRelationInternal(ctx, {
      subject,
      relation,
      object,
      properties,
      config,
      configHash,
      asyncWrites,
      onComplete,
    });
  },
});

// ---------------------------------------------------------------------------
// deleteEntity
// ---------------------------------------------------------------------------

export const deleteEntity = mutation({
  args: {
    entity: subjectValidator,
    configHash: configHashArg,
    graphConfig: graphConfigArg,
    asyncWrites: v.optional(v.boolean()),
  },
  handler: async (ctx: any, args: any) => {
    const { entity, configHash, asyncWrites } = args;
    const config = await loadConfig(ctx, configHash, args.graphConfig);

    let relationshipsRemoved = 0;
    let effectiveRelationshipsRemoved = 0;

    const remove = async (subject: Entity, relation: string, object: Entity) => {
      const res = await removeRelationInternal(ctx, {
        subject,
        relation,
        object,
        config,
        configHash,
        asyncWrites,
      });
      if (res) {
        relationshipsRemoved++;
        effectiveRelationshipsRemoved += res.effectiveRelationshipsRemoved;
      }
    };

    const subjectMatches = await ctx.db
      .query("relationships")
      .withIndex("by_subject_relation_object", (q: any) =>
        q.eq("subjectType", entity.type).eq("subjectId", entity.id),
      )
      .collect();
    for (const m of subjectMatches) {
      await remove(
        { type: m.subjectType, id: m.subjectId },
        m.relation,
        { type: m.objectType, id: m.objectId },
      );
    }

    const objectMatches = await ctx.db
      .query("relationships")
      .withIndex("by_object", (q: any) =>
        q.eq("objectType", entity.type).eq("objectId", entity.id),
      )
      .collect();
    for (const m of objectMatches) {
      await remove(
        { type: m.subjectType, id: m.subjectId },
        m.relation,
        { type: m.objectType, id: m.objectId },
      );
    }

    return { relationshipsRemoved, effectiveRelationshipsRemoved };
  },
});

// ---------------------------------------------------------------------------
// Test-only mock workpool helpers.
// ---------------------------------------------------------------------------

export const popMockWorkpool = internalMutation({
  args: {},
  handler: async (ctx: any) => {
    const task = await ctx.db.query("mockWorkpool").first();
    if (task) {
      await ctx.db.delete(task._id);
      return task;
    }
    return null;
  },
});

export const getMockWorkpool = internalMutation({
  args: {},
  handler: async (ctx: any) => {
    return await ctx.db.query("mockWorkpool").collect();
  },
});

export const deleteMockWorkpoolTask = internalMutation({
  args: { id: v.id("mockWorkpool") },
  handler: async (ctx: any, args: any) => {
    await ctx.db.delete(args.id);
  },
});
