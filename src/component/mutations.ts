import { internalMutation, mutation } from "./_generated/server";
async function enqueueToWorkpool(
  ctx: any,
  mutationRef: any,
  args: any,
  graphConfig: any,
) {
  if (graphConfig?.mockWorkpool) {
    const mutationName =
      args.baseRelId !== undefined ? "processAddChunk" : "processRemoveChunk";
    await ctx.db.insert("mockWorkpool", {
      mutationName,
      args,
    });
  } else {
    await expansionPool.enqueueMutation(ctx, mutationRef, args);
  }
}
import { v } from "convex/values";
import {
  conditionValidator,
  objectValidator,
  propertiesValidator,
  subjectValidator,
} from "./validators";
import type { GraphConfig } from "./types";
import { expansionPool } from "./workpool";
import { internal } from "./_generated/api";

function buildScopeKey(type: string, id: string) {
  return `${type}:${id}`;
}

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
    // If the relationship already exists, we don't need to do the Add graph expansion.
    // However, if there are pending `onComplete` tasks (like cleaning up old relations in an update),
    // we MUST execute them immediately, because we aren't going to fire off the processAddChunk job.
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

  if (enableAuditLog !== false) {
    await ctx.db.insert("auditLog", {
      tenantId,
      timestamp: Date.now(),
      action: "relation_added",
      userId: subject.type === "user" ? subject.id : "system",
      actorId: createdBy,
      details: {
        relation,
        subject: `${subject.type}:${subject.id}`,
        object: `${object.type}:${object.id}`,
      },
    });
  }

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
  }> = [
    {
      subject,
      relation,
      object,
      path: pathItem,
      depth: 1,
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
      });
    }
  }

  if (args.asyncWrites) {
    await enqueueToWorkpool(
      ctx,
      internal.mutations.processAddChunk,
      {
        tenantId,
        baseRelId: relId,
        queue,
        graphConfig,
        onComplete,
        asyncWrites: true,
      },
      graphConfig,
    );
  } else {
    await processAddChunkInternal(ctx, {
      tenantId,
      baseRelId: relId,
      queue,
      graphConfig,
      onComplete,
      asyncWrites: false,
    });
  }

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
) {
  if (!onComplete) return;

  if (onComplete.action === "removeRelation") {
    await removeRelationInternal(ctx, { ...onComplete.args, asyncWrites });
  } else if (onComplete.action === "removeRelationBatch") {
    for (const args of onComplete.args) {
      await removeRelationInternal(ctx, { ...args, asyncWrites });
    }
  } else if (onComplete.action === "enqueueRemoveChunk") {
    if (asyncWrites) {
      await enqueueToWorkpool(
        ctx,
        internal.mutations.processRemoveChunk,
        onComplete.args,
        onComplete.args.graphConfig,
      );
    } else {
      await processRemoveChunkInternal(ctx, onComplete.args);
    }
  } else if (onComplete.action === "enqueueRemoveChunkBatch") {
    for (const args of onComplete.args) {
      if (asyncWrites) {
        await enqueueToWorkpool(
          ctx,
          internal.mutations.processRemoveChunk,
          args,
          args.graphConfig,
        );
      } else {
        await processRemoveChunkInternal(ctx, args);
      }
    }
  }
}

async function processAddChunkInternal(ctx: any, args: any) {
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

  const maxWriteDepth = graphConfig.maxWriteDepth ?? 10;
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

    const getPathKey = (p: any) => {
      const sortedBaseIds = [...new Set(p.baseIds || [])].sort();
      const sortedConditions = [...(p.conditions || [])]
        .map((c: any) => JSON.stringify(c))
        .sort();
      return JSON.stringify({
        baseIds: sortedBaseIds,
        conditions: sortedConditions,
      });
    };

    const currentPathKey = getPathKey(current.path);
    const canonicalCurrentPath = {
      baseIds: [...new Set(current.path.baseIds || [])].sort(),
      conditions: current.path.conditions,
    };

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
        (p: any) => getPathKey(p) === currentPathKey,
      );

      if (!pathExists) {
        const newPaths = [...eff.paths, canonicalCurrentPath];
        await ctx.db.patch(eff._id, { paths: newPaths });
        isNewOrUpdated = true;
      }
    }

    if (isNewOrUpdated) {
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
            const [matchSubjectType, matchSubjectId] =
              match.subjectKey.split(":");
            const derivedSubject = {
              type: matchSubjectType,
              id: matchSubjectId,
            };
            const derivedObject = current.object;

            for (const matchPath of match.paths) {
              const schemaCondition = rule.conditions
                ? rule.conditions.map((c: string) => ({ condition: c }))
                : [];
              const combinedConditions = [
                ...(matchPath.conditions || []),
                ...(current.path.conditions || []),
                ...schemaCondition,
              ];

              const hasCycle = current.path.baseIds.some((t: string) =>
                matchPath.baseIds.includes(t),
              );
              if (hasCycle) continue;

              if (current.depth >= maxWriteDepth) continue;

              queue.push({
                subject: derivedSubject,
                relation: rule.derivedRelation,
                object: derivedObject,
                path: {
                  baseIds: [
                    ...new Set([...current.path.baseIds, ...matchPath.baseIds]),
                  ].sort(),
                  conditions:
                    combinedConditions.length > 0
                      ? combinedConditions
                      : undefined,
                },
                depth: current.depth + 1,
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
            const [matchObjectType, matchObjectId] = match.objectKey.split(":");
            if (matchObjectType === rule.sourceObjectType) {
              const derivedSubject = current.subject;
              const derivedObject = {
                type: matchObjectType,
                id: matchObjectId,
              };

              for (const matchPath of match.paths) {
                const schemaCondition = rule.conditions
                  ? rule.conditions.map((c: string) => ({ condition: c }))
                  : [];
                const combinedConditions = [
                  ...(current.path.conditions || []),
                  ...(matchPath.conditions || []),
                  ...schemaCondition,
                ];

                const hasCycle = current.path.baseIds.some((t: string) =>
                  matchPath.baseIds.includes(t),
                );
                if (hasCycle) continue;

                if (current.depth >= maxWriteDepth) continue;

                queue.push({
                  subject: derivedSubject,
                  relation: rule.derivedRelation,
                  object: derivedObject,
                  path: {
                    baseIds: [
                      ...new Set([
                        ...current.path.baseIds,
                        ...matchPath.baseIds,
                      ]),
                    ].sort(),
                    conditions:
                      combinedConditions.length > 0
                        ? combinedConditions
                        : undefined,
                  },
                  depth: current.depth + 1,
                });
              }
            }
          }
        }
      }
    }
  }

  if (queue.length > 0) {
    if (asyncWrites) {
      await enqueueToWorkpool(
        ctx,
        internal.mutations.processAddChunk,
        {
          tenantId,
          baseRelId,
          queue,
          graphConfig,
          onComplete,
          asyncWrites,
        },
        graphConfig,
      );
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

  if (enableAuditLog !== false) {
    await ctx.db.insert("auditLog", {
      tenantId,
      timestamp: Date.now(),
      action: "relation_removed",
      userId: subject.type === "user" ? subject.id : "system",
      actorId,
      details: {
        relation,
        subject: `${subject.type}:${subject.id}`,
        object: `${object.type}:${object.id}`,
      },
    });
  }

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

async function removeRelationInternal(ctx: any, args: any) {
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

  if (enableAuditLog !== false) {
    await ctx.db.insert("auditLog", {
      tenantId,
      timestamp: Date.now(),
      action: "relation_removed",
      userId: subject.type === "user" ? subject.id : "system",
      actorId,
      details: {
        relation,
        subject: `${subject.type}:${subject.id}`,
        object: `${object.type}:${object.id}`,
      },
    });
  }

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

  let effectiveRelationshipsRemoved = 0;

  if (args.asyncWrites) {
    await enqueueToWorkpool(
      ctx,
      internal.mutations.processRemoveChunk,
      {
        tenantId,
        queue,
        graphConfig,
      },
      graphConfig,
    );
  } else {
    effectiveRelationshipsRemoved = await processRemoveChunkInternal(ctx, {
      tenantId,
      queue,
      graphConfig,
    });
  }

  return { removed: true, effectiveRelationshipsRemoved };
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

async function processRemoveChunkInternal(ctx: any, args: any) {
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
              const [matchSubjectType, matchSubjectId] =
                match.subjectKey.split(":");
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
              const [matchObjectType, matchObjectId] =
                match.objectKey.split(":");
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
      }
    }
  }

  if (queue.length > 0) {
    if (asyncWrites) {
      await enqueueToWorkpool(
        ctx,
        internal.mutations.processRemoveChunk,
        {
          tenantId,
          queue,
          graphConfig,
          asyncWrites,
        },
        graphConfig,
      );
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
