import { v } from "convex/values";
import { buildScopeKey, decodeScopeKey } from "../shared/keys";
import { internal } from "./_generated/api";
import { internalMutation, mutation } from "./_generated/server";
import { writeAuditLog } from "./audit";
import { applyTraversalRulesToItem } from "./expand";
import { canonicalizePath, pathKey } from "./paths";
import { runOrEnqueue } from "./runOrEnqueue";
import type { GraphConfig } from "./types";
import {
  conditionValidator,
  objectValidator,
  propertiesValidator,
  subjectValidator,
} from "./validators";

export const addRelation = mutation({
  args: {
    tenantId: v.optional(v.string()),
    subject: subjectValidator,
    relation: v.string(),
    object: objectValidator,
    condition: conditionValidator,
    properties: propertiesValidator,
    createdBy: v.optional(v.string()),
    graphConfig: v.any(), // GraphConfig
    enableAuditLog: v.optional(v.boolean()),
    asyncWrites: v.optional(v.boolean()),
    onComplete: v.optional(v.any()), // { action: "remove", args: any } | { action: "removeBatch", args: any[] }
  },
  handler: async (ctx: any, args: any) => {
    return addRelationInternal(ctx, args);
  },
});

async function addRelationInternal(ctx: any, args: any) {
  const {
    tenantId,
    subject,
    relation,
    object,
    condition,
    properties,
    createdBy,
    enableAuditLog,
    onComplete,
  } = args;
  const graphConfig = args.graphConfig as GraphConfig;

  const existingRel = await ctx.db
    .query("relationships")
    .withIndex("by_tenant_subject_relation_object", (q: any) =>
      q
        .eq("tenantId", tenantId)
        .eq("subjectType", subject.type)
        .eq("subjectId", subject.id)
        .eq("relation", relation)
        .eq("objectType", object.type)
        .eq("objectId", object.id),
    )
    .unique();

  if (existingRel) {
    // Existing-row semantics:
    //   • If the caller's condition (or conditionContext) differs, we cannot
    //     silently keep the old one — every derived effective row baked the
    //     prior condition into its `path.conditions`. Mutating only the base
    //     row would leave stale baked conditions in the materialised view,
    //     so we throw and direct the caller at updateRelation, which runs
    //     a remove-cascade before the add.
    //   • If only `properties` differ, patch in place — properties live on
    //     the base edge only and are not replicated through the BFS.
    //   • Otherwise, no-op and return the existing id.
    //
    // Either way, pending `onComplete` cleanups still fire because the
    // caller's intent (typically "old relation removed by update/set") is
    // independent of whether the new add was a no-op or a real insert.
    const existingCondition = existingRel.condition ?? undefined;
    const existingConditionContext = existingRel.conditionContext ?? undefined;
    const newCondition = condition?.condition ?? undefined;
    const newConditionContext = condition?.conditionContext ?? undefined;

    const conditionChanged =
      existingCondition !== newCondition ||
      JSON.stringify(existingConditionContext) !==
        JSON.stringify(newConditionContext);

    if (conditionChanged) {
      throw new Error(
        `Zbar: addRelation cannot change the condition on an existing relationship ` +
          `(${subject.type}:${subject.id} -[${relation}]-> ${object.type}:${object.id}). ` +
          `Use updateRelation to replace the relation, or removeRelation followed by addRelation.`,
      );
    }

    if (
      properties !== undefined &&
      JSON.stringify(existingRel.properties ?? null) !==
        JSON.stringify(properties ?? null)
    ) {
      await ctx.db.patch(existingRel._id, { properties });
    }

    if (onComplete) {
      await executeOnComplete(ctx, onComplete, args.asyncWrites);
    }
    return existingRel._id;
  }

  const relId = await ctx.db.insert("relationships", {
    tenantId,
    subjectType: subject.type,
    subjectId: subject.id,
    relation,
    objectType: object.type,
    objectId: object.id,
    condition: condition?.condition,
    conditionContext: condition?.conditionContext,
    properties,
  });

  await writeAuditLog(ctx, {
    tenantId,
    enableAuditLog,
    action: "relation_added",
    subject,
    relation,
    object,
    actorId: createdBy,
  });

  const pathItem = {
    baseIds: [relId],
    conditions: condition ? [condition] : undefined,
  };

  const queue: Array<{
    subject: { type: string; id: string };
    relation: string;
    object: { type: string; id: string };
    path: any;
    depth: number;
    skipReverse?: boolean;
  }> = [
    {
      subject,
      relation,
      object,
      path: pathItem,
      depth: 1,
      // The auto-inserted reverse below handles the base-reverse side for
      // this explicit add. Skip the BFS effective-reverse-edge push here so
      // we don't create duplicate effective paths for the same underlying
      // base pair.
      skipReverse: true,
    },
  ];

  // Auto-insert reverse edge if declared in the schema.
  // e.g. device.container has { type: 'group', reverse: 'device_member' }
  // → when (group → container → device) is added, also insert (device → device_member → group)
  const reverseRel =
    graphConfig.reverseEdges?.[object.type]?.[relation]?.[subject.type];
  if (reverseRel) {
    const existingReverse = await ctx.db
      .query("relationships")
      .withIndex("by_tenant_subject_relation_object", (q: any) =>
        q
          .eq("tenantId", tenantId)
          .eq("subjectType", object.type)
          .eq("subjectId", object.id)
          .eq("relation", reverseRel)
          .eq("objectType", subject.type)
          .eq("objectId", subject.id),
      )
      .unique();

    if (!existingReverse) {
      const revId = await ctx.db.insert("relationships", {
        tenantId,
        subjectType: object.type,
        subjectId: object.id,
        relation: reverseRel,
        objectType: subject.type,
        objectId: subject.id,
      });

      queue.push({
        subject: object,
        relation: reverseRel,
        object: subject,
        path: { baseIds: [revId] },
        depth: 1,
        skipReverse: true,
      });
    }
  }

  await runOrEnqueue(ctx, {
    asyncWrites: args.asyncWrites,
    graphConfig,
    chunkRef: internal.mutations.processAddChunk,
    payload: {
      tenantId,
      baseRelId: relId,
      queue,
      graphConfig,
      onComplete,
      asyncWrites: args.asyncWrites ?? false,
    },
    inlineFn: processAddChunkInternal,
  });

  return relId;
}

export const processAddChunk = internalMutation({
  args: {
    tenantId: v.optional(v.string()),
    baseRelId: v.id("relationships"),
    queue: v.array(v.any()),
    graphConfig: v.any(),
    onComplete: v.optional(v.any()),
    asyncWrites: v.optional(v.boolean()),
  },
  handler: async (ctx: any, args: any) => {
    await processAddChunkInternal(ctx, args);
  },
});

async function executeOnComplete(
  ctx: any,
  onComplete: any,
  asyncWrites?: boolean,
): Promise<void> {
  if (!onComplete) return;

  // Normalise single/batch variants to a uniform array so each action has
  // one branch, not two.
  const kind = onComplete.action === "removeRelationBatch"
    ? "removeRelation"
    : onComplete.action === "enqueueRemoveChunkBatch"
      ? "enqueueRemoveChunk"
      : onComplete.action;
  const isBatch =
    onComplete.action === "removeRelationBatch" ||
    onComplete.action === "enqueueRemoveChunkBatch";
  const argsList: any[] = isBatch ? onComplete.args : [onComplete.args];

  for (const args of argsList) {
    if (kind === "removeRelation") {
      await removeRelationInternal(ctx, { ...args, asyncWrites });
    } else if (kind === "enqueueRemoveChunk") {
      await runOrEnqueue(ctx, {
        asyncWrites,
        graphConfig: args.graphConfig,
        chunkRef: internal.mutations.processRemoveChunk,
        payload: args,
        inlineFn: processRemoveChunkInternal,
      });
    }
  }
}

async function processAddChunkInternal(
  ctx: any,
  args: any,
): Promise<void> {
  const { tenantId, baseRelId, queue, graphConfig, onComplete, asyncWrites } =
    args;

  // Validation: Ensure the base relationship still exists. If not, abort.
  const baseRel = await ctx.db.get(baseRelId);
  if (!baseRel) {
    // If we get aborted by a rapid subsequent update,
    // ensure we still fire our cleanup tasks so nothing gets orphaned!
    if (onComplete) {
      await executeOnComplete(ctx, onComplete, asyncWrites);
    }
    return; // Base relation was deleted, abort expansion
  }

  const CHUNK_SIZE = graphConfig.maxChunkSize ?? 50;
  let processed = 0;

  while (queue.length > 0 && (!asyncWrites || processed < CHUNK_SIZE)) {
    processed++;
    const current = queue.shift()!;
    const sKey = buildScopeKey(current.subject.type, current.subject.id);
    const oKey = buildScopeKey(current.object.type, current.object.id);

    let eff = await ctx.db
      .query("effectiveRelationships")
      .withIndex("by_tenant_subject_relation_object", (q: any) =>
        q
          .eq("tenantId", tenantId)
          .eq("subjectKey", sKey)
          .eq("relation", current.relation)
          .eq("objectKey", oKey),
      )
      .unique();

    let isNewOrUpdated = false;

    const currentPathKey = pathKey(current.path);
    const canonicalCurrentPath = canonicalizePath(current.path);

    if (!eff) {
      eff = {
        _id: await ctx.db.insert("effectiveRelationships", {
          tenantId,
          subjectKey: sKey,
          relation: current.relation,
          objectKey: oKey,
          paths: [canonicalCurrentPath],
        }),
      };
      isNewOrUpdated = true;
    } else {
      const pathExists = eff.paths.some(
        (p: any) => pathKey(p) === currentPathKey,
      );

      if (!pathExists) {
        const newPaths = [...eff.paths, canonicalCurrentPath];
        await ctx.db.patch(eff._id, { paths: newPaths });
        isNewOrUpdated = true;
      }
    }

    if (isNewOrUpdated) {
      await applyTraversalRulesToItem(ctx, {
        tenantId,
        current,
        queue,
        graphConfig,
      });
    }
  }

  if (queue.length > 0) {
    if (asyncWrites) {
      await runOrEnqueue(ctx, {
        asyncWrites,
        graphConfig,
        chunkRef: internal.mutations.processAddChunk,
        payload: {
          tenantId,
          baseRelId,
          queue,
          graphConfig,
          onComplete,
          asyncWrites,
        },
      });
    }
  } else if (onComplete) {
    await executeOnComplete(ctx, onComplete, asyncWrites);
  }
}

async function deleteBaseRelationAndLog(ctx: any, args: any) {
  const {
    tenantId,
    subject,
    relation,
    object,
    actorId,
    enableAuditLog,
    existingRel,
  } = args;

  await ctx.db.delete(existingRel._id);

  await writeAuditLog(ctx, {
    tenantId,
    enableAuditLog,
    action: "relation_removed",
    subject,
    relation,
    object,
    actorId,
  });

  const queue: Array<{
    subject: { type: string; id: string };
    relation: string;
    object: { type: string; id: string };
    removedRelationId: string;
  }> = [
    {
      subject,
      relation,
      object,
      removedRelationId: existingRel._id,
    },
  ];

  // Auto-remove reverse edge if declared in the schema.
  const graphConfig = args.graphConfig as GraphConfig;
  const reverseRel =
    graphConfig.reverseEdges?.[object.type]?.[relation]?.[subject.type];
  if (reverseRel) {
    const existingReverse = await ctx.db
      .query("relationships")
      .withIndex("by_tenant_subject_relation_object", (q: any) =>
        q
          .eq("tenantId", tenantId)
          .eq("subjectType", object.type)
          .eq("subjectId", object.id)
          .eq("relation", reverseRel)
          .eq("objectType", subject.type)
          .eq("objectId", subject.id),
      )
      .unique();

    if (existingReverse) {
      await ctx.db.delete(existingReverse._id);
      queue.push({
        subject: object,
        relation: reverseRel,
        object: subject,
        removedRelationId: existingReverse._id,
      });
    }
  }

  return {
    tenantId,
    queue,
    graphConfig: args.graphConfig,
  };
}

async function removeRelationInternal(
  ctx: any,
  args: any,
): Promise<false | { removed: true; effectiveRelationshipsRemoved: number }> {
  const {
    tenantId,
    subject,
    relation,
    object,
    actorId,
    enableAuditLog,
    expectedRelId,
  } = args;
  const graphConfig = args.graphConfig as GraphConfig;

  const existingRel = await ctx.db
    .query("relationships")
    .withIndex("by_tenant_subject_relation_object", (q: any) =>
      q
        .eq("tenantId", tenantId)
        .eq("subjectType", subject.type)
        .eq("subjectId", subject.id)
        .eq("relation", relation)
        .eq("objectType", object.type)
        .eq("objectId", object.id),
    )
    .unique();

  if (!existingRel) {
    return false;
  }

  // In a concurrent rapid-update scenario, the relation might have been deleted and re-added.
  // If we are executing an onComplete cleanup from an older update, we MUST NOT delete the new row!
  if (expectedRelId && existingRel._id !== expectedRelId) {
    return false;
  }

  await ctx.db.delete(existingRel._id);

  await writeAuditLog(ctx, {
    tenantId,
    enableAuditLog,
    action: "relation_removed",
    subject,
    relation,
    object,
    actorId,
  });

  const queue: Array<{
    subject: { type: string; id: string };
    relation: string;
    object: { type: string; id: string };
    removedRelationId: string;
  }> = [
    {
      subject,
      relation,
      object,
      removedRelationId: existingRel._id,
    },
  ];

  // Auto-remove reverse edge if declared in the schema.
  const reverseRel =
    graphConfig.reverseEdges?.[object.type]?.[relation]?.[subject.type];
  if (reverseRel) {
    const existingReverse = await ctx.db
      .query("relationships")
      .withIndex("by_tenant_subject_relation_object", (q: any) =>
        q
          .eq("tenantId", tenantId)
          .eq("subjectType", object.type)
          .eq("subjectId", object.id)
          .eq("relation", reverseRel)
          .eq("objectType", subject.type)
          .eq("objectId", subject.id),
      )
      .unique();

    if (existingReverse) {
      await ctx.db.delete(existingReverse._id);
      queue.push({
        subject: object,
        relation: reverseRel,
        object: subject,
        removedRelationId: existingReverse._id,
      });
    }
  }

  const inlineRemoved = await runOrEnqueue<number>(ctx, {
    asyncWrites: args.asyncWrites,
    graphConfig,
    chunkRef: internal.mutations.processRemoveChunk,
    payload: { tenantId, queue, graphConfig },
    inlineFn: processRemoveChunkInternal,
  });

  return {
    removed: true,
    effectiveRelationshipsRemoved: inlineRemoved ?? 0,
  };
}

export const processRemoveChunk = internalMutation({
  args: {
    tenantId: v.optional(v.string()),
    queue: v.array(v.any()),
    graphConfig: v.any(),
    asyncWrites: v.optional(v.boolean()),
  },
  handler: async (ctx: any, args: any) => {
    await processRemoveChunkInternal(ctx, args);
  },
});

async function processRemoveChunkInternal(
  ctx: any,
  args: any,
): Promise<number> {
  const { tenantId, queue, graphConfig, asyncWrites } = args;
  let effectiveRelationshipsRemoved = 0;
  const CHUNK_SIZE = graphConfig.maxChunkSize ?? 50;
  let processed = 0;
  const seen = new Set<string>();

  for (const item of queue) {
    seen.add(
      `${buildScopeKey(item.subject.type, item.subject.id)}:${item.relation}:${buildScopeKey(item.object.type, item.object.id)}:${item.removedRelationId}`,
    );
  }

  while (queue.length > 0 && (!asyncWrites || processed < CHUNK_SIZE)) {
    processed++;
    const current = queue.shift()!;
    const sKey = buildScopeKey(current.subject.type, current.subject.id);
    const oKey = buildScopeKey(current.object.type, current.object.id);

    const eff = await ctx.db
      .query("effectiveRelationships")
      .withIndex("by_tenant_subject_relation_object", (q: any) =>
        q
          .eq("tenantId", tenantId)
          .eq("subjectKey", sKey)
          .eq("relation", current.relation)
          .eq("objectKey", oKey),
      )
      .unique();

    if (eff) {
      const remainingPaths = eff.paths.filter(
        (p: any) =>
          !p.baseIds || !p.baseIds.includes(current.removedRelationId),
      );

      let shouldCascade = false;
      const cascadeId = current.removedRelationId;

      if (remainingPaths.length === 0) {
        await ctx.db.delete(eff._id);
        effectiveRelationshipsRemoved++;
        shouldCascade = true;
      } else if (remainingPaths.length !== eff.paths.length) {
        await ctx.db.patch(eff._id, { paths: remainingPaths });
        shouldCascade = true;
      }

      if (shouldCascade) {
        // If this effective relationship was modified or deleted, cascade the token downstream
        for (const rule of graphConfig.traversalRules) {
          if (
            current.object.type === rule.sourceObjectType &&
            current.relation === rule.sourceRelation
          ) {
            const matches = await ctx.db
              .query("effectiveRelationships")
              .withIndex("by_tenant_object_relation_subject", (q: any) =>
                q
                  .eq("tenantId", tenantId)
                  .eq("objectKey", sKey)
                  .eq("relation", rule.targetRelation),
              )
              .collect();

            for (const match of matches) {
              const [matchSubjectType, matchSubjectId] = decodeScopeKey(
                match.subjectKey,
              );
              const derivedSubject = {
                type: matchSubjectType,
                id: matchSubjectId,
              };
              const derivedObject = current.object;
              const queueKey = `${buildScopeKey(derivedSubject.type, derivedSubject.id)}:${rule.derivedRelation}:${buildScopeKey(derivedObject.type, derivedObject.id)}:${cascadeId}`;
              if (!seen.has(queueKey)) {
                seen.add(queueKey);
                queue.push({
                  subject: derivedSubject,
                  relation: rule.derivedRelation,
                  object: derivedObject,
                  removedRelationId: cascadeId,
                });
              }
            }
          }

          if (current.relation === rule.targetRelation) {
            const matches = await ctx.db
              .query("effectiveRelationships")
              .withIndex("by_tenant_subject_relation_object", (q: any) =>
                q
                  .eq("tenantId", tenantId)
                  .eq("subjectKey", oKey)
                  .eq("relation", rule.sourceRelation),
              )
              .collect();

            for (const match of matches) {
              const [matchObjectType, matchObjectId] = decodeScopeKey(
                match.objectKey,
              );
              if (matchObjectType === rule.sourceObjectType) {
                const derivedSubject = current.subject;
                const derivedObject = {
                  type: matchObjectType,
                  id: matchObjectId,
                };
                const queueKey = `${buildScopeKey(derivedSubject.type, derivedSubject.id)}:${rule.derivedRelation}:${buildScopeKey(derivedObject.type, derivedObject.id)}:${cascadeId}`;
                if (!seen.has(queueKey)) {
                  seen.add(queueKey);
                  queue.push({
                    subject: derivedSubject,
                    relation: rule.derivedRelation,
                    object: derivedObject,
                    removedRelationId: cascadeId,
                  });
                }
              }
            }
          }
        }

        // Cascade through effective reverse edges — mirror of the add-path
        // logic. When a derived relationship is torn down, the effective
        // relationship on the reverse side must be pruned too. The `seen`
        // set prevents reverse-of-reverse loops since re-queuing the same
        // (subject, relation, object, cascadeId) is a no-op.
        if (graphConfig.reverseEdges) {
          const reverseRel =
            graphConfig.reverseEdges?.[current.object.type]?.[
              current.relation
            ]?.[current.subject.type];
          if (reverseRel) {
            const queueKey = `${buildScopeKey(current.object.type, current.object.id)}:${reverseRel}:${buildScopeKey(current.subject.type, current.subject.id)}:${cascadeId}`;
            if (!seen.has(queueKey)) {
              seen.add(queueKey);
              queue.push({
                subject: current.object,
                relation: reverseRel,
                object: current.subject,
                removedRelationId: cascadeId,
              });
            }
          }
        }
      }
    }
  }

  if (queue.length > 0) {
    if (asyncWrites) {
      await runOrEnqueue(ctx, {
        asyncWrites,
        graphConfig,
        chunkRef: internal.mutations.processRemoveChunk,
        payload: {
          tenantId,
          queue,
          graphConfig,
          asyncWrites,
        },
      });
    }
  }

  return effectiveRelationshipsRemoved;
}

export const removeRelation = mutation({
  args: {
    tenantId: v.optional(v.string()),
    subject: subjectValidator,
    relation: v.string(),
    object: objectValidator,
    actorId: v.optional(v.string()),
    graphConfig: v.any(), // GraphConfig
    enableAuditLog: v.optional(v.boolean()),
    asyncWrites: v.optional(v.boolean()),
  },
  handler: async (ctx: any, args: any) => {
    const res = await removeRelationInternal(ctx, args);
    return res ? res.removed : false;
  },
});

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

export const deleteEntity = mutation({
  args: {
    tenantId: v.optional(v.string()),
    entity: subjectValidator, // { type, id }
    actorId: v.optional(v.string()),
    graphConfig: v.any(),
    enableAuditLog: v.optional(v.boolean()),
    asyncWrites: v.optional(v.boolean()),
  },
  handler: async (ctx: any, args: any) => {
    const {
      tenantId,
      entity,
      actorId,
      graphConfig,
      enableAuditLog,
      asyncWrites,
    } = args;

    let relationshipsRemoved = 0;
    let effectiveRelationshipsRemoved = 0;

    // 1. Where entity is subject
    const subjectMatches = await ctx.db
      .query("relationships")
      .withIndex("by_tenant_subject_relation_object", (q: any) =>
        q
          .eq("tenantId", tenantId)
          .eq("subjectType", entity.type)
          .eq("subjectId", entity.id),
      )
      .collect();

    for (const match of subjectMatches) {
      const res = await removeRelationInternal(ctx, {
        tenantId,
        subject: { type: match.subjectType, id: match.subjectId },
        relation: match.relation,
        object: { type: match.objectType, id: match.objectId },
        actorId,
        graphConfig,
        enableAuditLog,
        asyncWrites,
      });
      if (res) {
        relationshipsRemoved++;
        effectiveRelationshipsRemoved += res.effectiveRelationshipsRemoved;
      }
    }

    // 2. Where entity is object
    const objectMatches = await ctx.db
      .query("relationships")
      .withIndex("by_tenant_object", (q: any) =>
        q
          .eq("tenantId", tenantId)
          .eq("objectType", entity.type)
          .eq("objectId", entity.id),
      )
      .collect();

    for (const match of objectMatches) {
      const res = await removeRelationInternal(ctx, {
        tenantId,
        subject: { type: match.subjectType, id: match.subjectId },
        relation: match.relation,
        object: { type: match.objectType, id: match.objectId },
        actorId,
        graphConfig,
        enableAuditLog,
        asyncWrites,
      });
      if (res) {
        relationshipsRemoved++;
        effectiveRelationshipsRemoved += res.effectiveRelationshipsRemoved;
      }
    }

    return {
      relationshipsRemoved,
      effectiveRelationshipsRemoved,
    };
  },
});

export const updateRelation = mutation({
  args: {
    tenantId: v.optional(v.string()),
    subject: subjectValidator,
    oldRelation: v.string(),
    newRelation: v.string(),
    object: objectValidator,
    condition: conditionValidator,
    properties: propertiesValidator,
    createdBy: v.optional(v.string()),
    graphConfig: v.any(), // GraphConfig
    enableAuditLog: v.optional(v.boolean()),
    asyncWrites: v.optional(v.boolean()),
  },
  handler: async (ctx: any, args: any) => {
    const {
      tenantId,
      subject,
      oldRelation,
      newRelation,
      object,
      condition,
      properties,
      createdBy,
      enableAuditLog,
      graphConfig,
      asyncWrites,
    } = args;

    const existingOldRel = await ctx.db
      .query("relationships")
      .withIndex("by_tenant_subject_relation_object", (q: any) =>
        q
          .eq("tenantId", tenantId)
          .eq("subjectType", subject.type)
          .eq("subjectId", subject.id)
          .eq("relation", oldRelation)
          .eq("objectType", object.type)
          .eq("objectId", object.id),
      )
      .unique();

    let onComplete: any = undefined;

    if (existingOldRel) {
      const removedData = await deleteBaseRelationAndLog(ctx, {
        tenantId,
        subject,
        relation: oldRelation,
        object,
        actorId: createdBy,
        enableAuditLog,
        existingRel: existingOldRel,
        graphConfig,
      });

      onComplete = {
        action: "enqueueRemoveChunk",
        args: removedData,
      };
    }

    return addRelationInternal(ctx, {
      tenantId,
      subject,
      relation: newRelation,
      object,
      condition,
      properties,
      createdBy,
      enableAuditLog,
      graphConfig,
      asyncWrites,
      onComplete,
    });
  },
});

export const setRelation = mutation({
  args: {
    tenantId: v.optional(v.string()),
    subject: subjectValidator,
    relation: v.string(),
    object: objectValidator,
    objectRelations: v.array(v.string()),
    condition: conditionValidator,
    properties: propertiesValidator,
    createdBy: v.optional(v.string()),
    graphConfig: v.any(), // GraphConfig
    enableAuditLog: v.optional(v.boolean()),
    asyncWrites: v.optional(v.boolean()),
  },
  handler: async (ctx: any, args: any) => {
    const {
      tenantId,
      subject,
      relation,
      object,
      condition,
      properties,
      createdBy,
      enableAuditLog,
      graphConfig,
      asyncWrites,
    } = args;

    // Query each known relation for this object type using the fully-qualified index.
    // The client passes objectRelations (all relation names for this object type),
    // so we can issue precise index lookups instead of a broad subject-only scan.
    const { objectRelations } = args;

    const queries = objectRelations
      .filter((r: string) => r !== relation)
      .map((candidateRel: string) =>
        ctx.db
          .query("relationships")
          .withIndex("by_tenant_subject_relation_object", (q: any) =>
            q
              .eq("tenantId", tenantId)
              .eq("subjectType", subject.type)
              .eq("subjectId", subject.id)
              .eq("relation", candidateRel)
              .eq("objectType", object.type)
              .eq("objectId", object.id),
          )
          .unique(),
      );

    const results = await Promise.all(queries);
    const relationsToDrop = results.filter((r: any) => r !== null);

    const onCompleteArgs = [];
    for (const r of relationsToDrop) {
      const removedData = await deleteBaseRelationAndLog(ctx, {
        tenantId,
        subject,
        relation: r.relation,
        object,
        actorId: createdBy,
        enableAuditLog,
        existingRel: r,
        graphConfig,
      });
      onCompleteArgs.push(removedData);
    }

    const onComplete =
      onCompleteArgs.length > 0
        ? {
            action: "enqueueRemoveChunkBatch",
            args: onCompleteArgs,
          }
        : undefined;

    return addRelationInternal(ctx, {
      tenantId,
      subject,
      relation,
      object,
      condition,
      properties,
      createdBy,
      enableAuditLog,
      graphConfig,
      asyncWrites,
      onComplete,
    });
  },
});
