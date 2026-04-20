import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import { expansionPool } from "./workpool";
import type { GraphConfig } from "./types";

function buildScopeKey(type: string, id: string) {
  return `${type}:${id}`;
}

/**
 * Decode `${type}:${id}` preserving any colons in `id`. The naive
 * `split(":")` truncates ids that themselves contain a colon, silently
 * matching the wrong row.
 */
function decodeScopeKey(scopeKey: string): [type: string, id: string] {
  const idx = scopeKey.indexOf(":");
  return [scopeKey.slice(0, idx), scopeKey.slice(idx + 1)];
}

// ============================================================================
// Step 1: Read Primitives
// ============================================================================

export const scanRelationships = query({
  args: {
    tenantId: v.optional(v.string()),
    filter: v.optional(
      v.object({
        subjectType: v.optional(v.string()),
        subjectId: v.optional(v.string()),
        relation: v.optional(v.string()),
        objectType: v.optional(v.string()),
        objectId: v.optional(v.string()),
      }),
    ),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx: any, args: any) => {
    const { tenantId, filter, limit: rawLimit } = args;
    const limit = Math.min(rawLimit ?? 100, 1000);

    // Choose the best index based on available filters
    let results: any[];

    if (filter?.subjectType && filter?.subjectId && filter?.relation && filter?.objectType && filter?.objectId) {
      // Fully specified — use the most selective index
      const row = await ctx.db
        .query("relationships")
        .withIndex("by_tenant_subject_relation_object", (q: any) =>
          q
            .eq("tenantId", tenantId)
            .eq("subjectType", filter.subjectType)
            .eq("subjectId", filter.subjectId)
            .eq("relation", filter.relation)
            .eq("objectType", filter.objectType)
            .eq("objectId", filter.objectId),
        )
        .unique();
      results = row ? [row] : [];
    } else if (filter?.subjectType && filter?.subjectId) {
      // Subject-scoped scan
      results = await ctx.db
        .query("relationships")
        .withIndex("by_tenant_subject_relation_object", (q: any) => {
          let q2 = q
            .eq("tenantId", tenantId)
            .eq("subjectType", filter.subjectType)
            .eq("subjectId", filter.subjectId);
          if (filter.relation) q2 = q2.eq("relation", filter.relation);
          return q2;
        })
        .collect();
    } else if (filter?.objectType && filter?.objectId) {
      // Object-scoped scan
      results = await ctx.db
        .query("relationships")
        .withIndex("by_tenant_object", (q: any) =>
          q
            .eq("tenantId", tenantId)
            .eq("objectType", filter.objectType)
            .eq("objectId", filter.objectId),
        )
        .collect();
    } else if (filter?.objectType) {
      // Object type scan
      results = await ctx.db
        .query("relationships")
        .withIndex("by_tenant_object", (q: any) =>
          q.eq("tenantId", tenantId).eq("objectType", filter.objectType),
        )
        .collect();
    } else {
      // Full table scan for this tenant — use the object index as a prefix scan
      results = await ctx.db
        .query("relationships")
        .withIndex("by_tenant_object", (q: any) =>
          q.eq("tenantId", tenantId),
        )
        .collect();
    }

    // Apply remaining client-side filters that weren't covered by the index
    if (filter) {
      results = results.filter((r: any) => {
        if (filter.subjectType && r.subjectType !== filter.subjectType)
          return false;
        if (filter.subjectId && r.subjectId !== filter.subjectId) return false;
        if (filter.relation && r.relation !== filter.relation) return false;
        if (filter.objectType && r.objectType !== filter.objectType)
          return false;
        if (filter.objectId && r.objectId !== filter.objectId) return false;
        return true;
      });
    }

    // Apply cursor-based pagination
    let startIndex = 0;
    if (args.cursor) {
      const cursorIdx = results.findIndex(
        (r: any) => r._id === args.cursor,
      );
      if (cursorIdx >= 0) {
        startIndex = cursorIdx + 1;
      }
    }

    const page = results.slice(startIndex, startIndex + limit);
    const nextCursor =
      startIndex + limit < results.length
        ? page[page.length - 1]?._id
        : undefined;

    return {
      rows: page.map((r: any) => ({
        _id: r._id,
        tenantId: r.tenantId,
        subjectType: r.subjectType,
        subjectId: r.subjectId,
        relation: r.relation,
        objectType: r.objectType,
        objectId: r.objectId,
        condition: r.condition,
        conditionContext: r.conditionContext,
        properties: r.properties,
      })),
      cursor: nextCursor,
      isDone: nextCursor === undefined,
    };
  },
});

export const countRelationships = query({
  args: {
    tenantId: v.optional(v.string()),
    filter: v.optional(
      v.object({
        subjectType: v.optional(v.string()),
        objectType: v.optional(v.string()),
        relation: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx: any, args: any) => {
    const { tenantId, filter } = args;

    let results: any[];

    if (filter?.objectType) {
      results = await ctx.db
        .query("relationships")
        .withIndex("by_tenant_object", (q: any) =>
          q.eq("tenantId", tenantId).eq("objectType", filter.objectType),
        )
        .collect();
    } else {
      results = await ctx.db
        .query("relationships")
        .withIndex("by_tenant_object", (q: any) =>
          q.eq("tenantId", tenantId),
        )
        .collect();
    }

    if (filter) {
      results = results.filter((r: any) => {
        if (filter.subjectType && r.subjectType !== filter.subjectType)
          return false;
        if (filter.relation && r.relation !== filter.relation) return false;
        if (filter.objectType && r.objectType !== filter.objectType)
          return false;
        return true;
      });
    }

    return results.length;
  },
});

// ============================================================================
// Step 2: Raw Write Primitives
// ============================================================================

export const insertRelationship = mutation({
  args: {
    tenantId: v.optional(v.string()),
    subjectType: v.string(),
    subjectId: v.string(),
    relation: v.string(),
    objectType: v.string(),
    objectId: v.string(),
    condition: v.optional(v.string()),
    conditionContext: v.optional(v.any()),
    properties: v.optional(v.any()),
  },
  handler: async (ctx: any, args: any) => {
    return await ctx.db.insert("relationships", {
      tenantId: args.tenantId,
      subjectType: args.subjectType,
      subjectId: args.subjectId,
      relation: args.relation,
      objectType: args.objectType,
      objectId: args.objectId,
      condition: args.condition,
      conditionContext: args.conditionContext,
      properties: args.properties,
    });
  },
});

export const patchRelationship = mutation({
  args: {
    relationshipId: v.id("relationships"),
    patch: v.object({
      subjectType: v.optional(v.string()),
      subjectId: v.optional(v.string()),
      relation: v.optional(v.string()),
      objectType: v.optional(v.string()),
      objectId: v.optional(v.string()),
      condition: v.optional(v.union(v.string(), v.null())),
      conditionContext: v.optional(v.any()),
      properties: v.optional(v.union(v.any(), v.null())),
    }),
  },
  handler: async (ctx: any, args: any) => {
    const existing = await ctx.db.get(args.relationshipId);
    if (!existing) {
      throw new Error(
        `Relationship ${args.relationshipId} not found`,
      );
    }

    const patchData: any = {};
    for (const [key, value] of Object.entries(args.patch)) {
      if (value === undefined) continue;
      if (value === null) {
        // null means clear the field
        patchData[key] = undefined;
      } else {
        patchData[key] = value;
      }
    }

    await ctx.db.patch(args.relationshipId, patchData);
  },
});

export const deleteRelationship = mutation({
  args: {
    relationshipId: v.id("relationships"),
  },
  handler: async (ctx: any, args: any) => {
    const existing = await ctx.db.get(args.relationshipId);
    if (!existing) return;
    await ctx.db.delete(args.relationshipId);
  },
});

// ============================================================================
// Step 3: Effective Relationship Control
// ============================================================================

export const clearEffectiveRelationships = mutation({
  args: {
    tenantId: v.optional(v.string()),
    filter: v.optional(
      v.object({
        subjectType: v.optional(v.string()),
        objectType: v.optional(v.string()),
        relation: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx: any, args: any) => {
    return await clearEffectiveRelationshipsInternal(ctx, args);
  },
});

async function clearEffectiveRelationshipsInternal(ctx: any, args: any) {
  const { tenantId, filter } = args;

  // Collect all effective relationships for this tenant
  const allEffective = await ctx.db
    .query("effectiveRelationships")
    .withIndex("by_tenant_subject_relation_object", (q: any) =>
      q.eq("tenantId", tenantId),
    )
    .collect();

  let toDelete = allEffective;

  if (filter) {
    toDelete = allEffective.filter((eff: any) => {
      if (filter.relation && eff.relation !== filter.relation) return false;
      if (filter.subjectType) {
        const [sType] = decodeScopeKey(eff.subjectKey);
        if (sType !== filter.subjectType) return false;
      }
      if (filter.objectType) {
        const [oType] = decodeScopeKey(eff.objectKey);
        if (oType !== filter.objectType) return false;
      }
      return true;
    });
  }

  for (const eff of toDelete) {
    await ctx.db.delete(eff._id);
  }

  return { removed: toDelete.length };
}

export const clearEffectiveRelationshipsChunked = internalMutation({
  args: {
    tenantId: v.optional(v.string()),
    filter: v.optional(
      v.object({
        subjectType: v.optional(v.string()),
        objectType: v.optional(v.string()),
        relation: v.optional(v.string()),
      }),
    ),
    asyncWrites: v.optional(v.boolean()),
  },
  handler: async (ctx: any, args: any) => {
    return await clearEffectiveRelationshipsInternal(ctx, args);
  },
});

/**
 * Rebuild effective relationships by replaying all base relationships through
 * the graph expansion engine. This is an internal mutation that processes in
 * chunks and self-schedules for continuation.
 */
export const rebuildEffectiveChunk = mutation({
  args: {
    tenantId: v.optional(v.string()),
    graphConfig: v.any(),
    cursor: v.optional(v.string()), // last processed relationship _id
    batchSize: v.optional(v.number()),
    stats: v.optional(
      v.object({
        processed: v.number(),
        total: v.number(),
      }),
    ),
    mockWorkpool: v.optional(v.boolean()),
  },
  handler: async (ctx: any, args: any) => {
    const { tenantId, graphConfig, cursor, mockWorkpool } = args;
    const batchSize = args.batchSize ?? 25;
    const stats = args.stats ?? { processed: 0, total: 0 };

    // Fetch a batch of base relationships
    let query = ctx.db
      .query("relationships")
      .withIndex("by_tenant_object", (q: any) =>
        q.eq("tenantId", tenantId),
      );

    const allRels = await query.collect();

    // Find our start position
    let startIdx = 0;
    if (cursor) {
      const cursorIdx = allRels.findIndex((r: any) => r._id === cursor);
      if (cursorIdx >= 0) startIdx = cursorIdx + 1;
    }

    if (stats.total === 0) {
      stats.total = allRels.length;
    }

    const batch = allRels.slice(startIdx, startIdx + batchSize);

    if (batch.length === 0) {
      return { done: true, stats };
    }

    // For each base relationship, create the direct effective relationship
    for (const rel of batch) {
      const sKey = buildScopeKey(rel.subjectType, rel.subjectId);
      const oKey = buildScopeKey(rel.objectType, rel.objectId);

      const pathItem = {
        baseIds: [rel._id],
        conditions: rel.condition
          ? [
              {
                condition: rel.condition,
                conditionContext: rel.conditionContext,
              },
            ]
          : undefined,
      };

      // Check if this effective relationship already exists
      const existing = await ctx.db
        .query("effectiveRelationships")
        .withIndex("by_tenant_subject_relation_object", (q: any) =>
          q
            .eq("tenantId", tenantId)
            .eq("subjectKey", sKey)
            .eq("relation", rel.relation)
            .eq("objectKey", oKey),
        )
        .unique();

      if (!existing) {
        await ctx.db.insert("effectiveRelationships", {
          tenantId,
          subjectKey: sKey,
          relation: rel.relation,
          objectKey: oKey,
          paths: [pathItem],
        });
      } else {
        // Add path if not already present
        const pathKey = JSON.stringify({
          baseIds: [...new Set(pathItem.baseIds)].sort(),
          conditions: pathItem.conditions,
        });
        const existingPathKeys = existing.paths.map((p: any) =>
          JSON.stringify({
            baseIds: [...new Set(p.baseIds)].sort(),
            conditions: p.conditions,
          }),
        );
        if (!existingPathKeys.includes(pathKey)) {
          await ctx.db.patch(existing._id, {
            paths: [...existing.paths, pathItem],
          });
        }
      }

      // Now expand traversal rules for this relationship
      await expandTraversalRules(ctx, {
        tenantId,
        subject: { type: rel.subjectType, id: rel.subjectId },
        relation: rel.relation,
        object: { type: rel.objectType, id: rel.objectId },
        path: pathItem,
        graphConfig,
      });

      stats.processed++;
    }

    const lastId = batch[batch.length - 1]._id;
    const isDone = startIdx + batchSize >= allRels.length;

    if (!isDone) {
      if (mockWorkpool) {
        await ctx.db.insert("mockWorkpool", {
          mutationName: "rebuildEffectiveChunk",
          args: {
            tenantId,
            graphConfig,
            cursor: lastId,
            batchSize,
            stats,
            mockWorkpool,
          },
        });
      } else {
        await expansionPool.enqueueMutation(
          ctx,
          api.unsafe.rebuildEffectiveChunk,
          {
            tenantId,
            graphConfig,
            cursor: lastId,
            batchSize,
            stats,
          },
        );
      }
    }

    return { done: isDone, stats };
  },
});

async function expandTraversalRules(ctx: any, args: any) {
  const { tenantId, subject, relation, object, path, graphConfig } = args;
  const maxWriteDepth = graphConfig.maxWriteDepth ?? 10;

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
      path,
      depth: 1,
      // Rebuild walks every base row independently, so both sides of a
      // reverse-edge declaration are already scheduled. Skip the depth-1
      // reverse push to avoid creating duplicate effective paths for the
      // same underlying base pair.
      skipReverse: true,
    },
  ];

  // We've already written the direct effective rel, so skip depth 1 expansion for the initial entry
  // but do traverse rules
  while (queue.length > 0) {
    const current = queue.shift()!;
    const sKey = buildScopeKey(current.subject.type, current.subject.id);
    const oKey = buildScopeKey(current.object.type, current.object.id);

    // For items beyond depth 1, upsert the effective relationship
    if (current.depth > 1) {
      const canonicalPath = {
        baseIds: [...new Set(current.path.baseIds || [])].sort(),
        conditions: current.path.conditions,
      };

      const existing = await ctx.db
        .query("effectiveRelationships")
        .withIndex("by_tenant_subject_relation_object", (q: any) =>
          q
            .eq("tenantId", tenantId)
            .eq("subjectKey", sKey)
            .eq("relation", current.relation)
            .eq("objectKey", oKey),
        )
        .unique();

      const pathKey = JSON.stringify({
        baseIds: canonicalPath.baseIds,
        conditions: canonicalPath.conditions
          ? canonicalPath.conditions.map((c: any) => JSON.stringify(c)).sort()
          : undefined,
      });

      let isNew = false;
      if (!existing) {
        await ctx.db.insert("effectiveRelationships", {
          tenantId,
          subjectKey: sKey,
          relation: current.relation,
          objectKey: oKey,
          paths: [canonicalPath],
        });
        isNew = true;
      } else {
        const existingKeys = existing.paths.map((p: any) =>
          JSON.stringify({
            baseIds: [...new Set(p.baseIds)].sort(),
            conditions: p.conditions
              ? p.conditions.map((c: any) => JSON.stringify(c)).sort()
              : undefined,
          }),
        );
        if (!existingKeys.includes(pathKey)) {
          await ctx.db.patch(existing._id, {
            paths: [...existing.paths, canonicalPath],
          });
          isNew = true;
        }
      }

      if (!isNew) continue; // Already fully expanded
    }

    // Apply traversal rules
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

          for (const matchPath of match.paths) {
            const hasCycle = current.path.baseIds.some((t: string) =>
              matchPath.baseIds.includes(t),
            );
            if (hasCycle) continue;
            if (current.depth >= maxWriteDepth) continue;

            const schemaCondition = rule.conditions
              ? rule.conditions.map((c: string) => ({ condition: c }))
              : [];

            queue.push({
              subject: { type: matchSubjectType, id: matchSubjectId },
              relation: rule.derivedRelation,
              object: current.object,
              path: {
                baseIds: [
                  ...new Set([
                    ...current.path.baseIds,
                    ...matchPath.baseIds,
                  ]),
                ].sort(),
                conditions:
                  [
                    ...(matchPath.conditions || []),
                    ...(current.path.conditions || []),
                    ...schemaCondition,
                  ].length > 0
                    ? [
                        ...(matchPath.conditions || []),
                        ...(current.path.conditions || []),
                        ...schemaCondition,
                      ]
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
          const [matchObjectType, matchObjectId] = decodeScopeKey(
            match.objectKey,
          );
          if (matchObjectType === rule.sourceObjectType) {
            for (const matchPath of match.paths) {
              const hasCycle = current.path.baseIds.some((t: string) =>
                matchPath.baseIds.includes(t),
              );
              if (hasCycle) continue;
              if (current.depth >= maxWriteDepth) continue;

              const schemaCondition = rule.conditions
                ? rule.conditions.map((c: string) => ({ condition: c }))
                : [];

              queue.push({
                subject: current.subject,
                relation: rule.derivedRelation,
                object: { type: matchObjectType, id: matchObjectId },
                path: {
                  baseIds: [
                    ...new Set([
                      ...current.path.baseIds,
                      ...matchPath.baseIds,
                    ]),
                  ].sort(),
                  conditions:
                    [
                      ...(current.path.conditions || []),
                      ...(matchPath.conditions || []),
                      ...schemaCondition,
                    ].length > 0
                      ? [
                          ...(current.path.conditions || []),
                          ...(matchPath.conditions || []),
                          ...schemaCondition,
                        ]
                      : undefined,
                },
                depth: current.depth + 1,
              });
            }
          }
        }
      }
    }

    // Effective reverse edges — mirror production BFS at
    // src/component/mutations.ts so derived edges with a declared reverse
    // also materialise the reverse side during rebuild.
    if (graphConfig.reverseEdges && !current.skipReverse) {
      const reverseRel =
        graphConfig.reverseEdges?.[current.object.type]?.[current.relation]?.[
          current.subject.type
        ];
      if (reverseRel && current.depth < maxWriteDepth) {
        queue.push({
          subject: current.object,
          relation: reverseRel,
          object: current.subject,
          path: current.path,
          depth: current.depth + 1,
          skipReverse: true,
        });
      }
    }
  }
}

// ============================================================================
// Step 4: Bulk Transform
// ============================================================================

export const transformChunk = mutation({
  args: {
    tenantId: v.optional(v.string()),
    // Array of operations: { id, action: "patch"|"delete"|"skip", patch?, inserts? }
    operations: v.array(
      v.object({
        id: v.id("relationships"),
        action: v.union(
          v.literal("patch"),
          v.literal("delete"),
          v.literal("replace"),
          v.literal("skip"),
        ),
        patch: v.optional(
          v.object({
            subjectType: v.optional(v.string()),
            subjectId: v.optional(v.string()),
            relation: v.optional(v.string()),
            objectType: v.optional(v.string()),
            objectId: v.optional(v.string()),
            condition: v.optional(v.union(v.string(), v.null())),
            conditionContext: v.optional(v.any()),
            properties: v.optional(v.union(v.any(), v.null())),
          }),
        ),
        inserts: v.optional(
          v.array(
            v.object({
              tenantId: v.optional(v.string()),
              subjectType: v.string(),
              subjectId: v.string(),
              relation: v.string(),
              objectType: v.string(),
              objectId: v.string(),
              condition: v.optional(v.string()),
              conditionContext: v.optional(v.any()),
              properties: v.optional(v.any()),
            }),
          ),
        ),
      }),
    ),
  },
  handler: async (ctx: any, args: any) => {
    let patched = 0;
    let inserted = 0;
    let deleted = 0;
    let skipped = 0;

    for (const op of args.operations) {
      if (op.action === "skip") {
        skipped++;
        continue;
      }

      if (op.action === "delete") {
        const existing = await ctx.db.get(op.id);
        if (existing) {
          await ctx.db.delete(op.id);
          deleted++;
        }
        continue;
      }

      if (op.action === "patch") {
        const existing = await ctx.db.get(op.id);
        if (!existing) continue;

        const patchData: any = {};
        for (const [key, value] of Object.entries(op.patch || {})) {
          if (value === undefined) continue;
          if (value === null) {
            patchData[key] = undefined;
          } else {
            patchData[key] = value;
          }
        }

        await ctx.db.patch(op.id, patchData);
        patched++;
        continue;
      }

      if (op.action === "replace") {
        // Delete original, insert replacements
        const existing = await ctx.db.get(op.id);
        if (existing) {
          await ctx.db.delete(op.id);
          deleted++;
        }
        for (const ins of op.inserts || []) {
          await ctx.db.insert("relationships", ins);
          inserted++;
        }
        continue;
      }
    }

    return { patched, inserted, deleted, skipped };
  },
});

// ============================================================================
// Step 5: Convenience Rename Helpers
// ============================================================================

export const renameRelation = mutation({
  args: {
    tenantId: v.optional(v.string()),
    objectType: v.string(),
    oldRelation: v.string(),
    newRelation: v.string(),
  },
  handler: async (ctx: any, args: any) => {
    const { tenantId, objectType, oldRelation, newRelation } = args;

    // Find all relationships where this object type has the old relation
    const matches = await ctx.db
      .query("relationships")
      .withIndex("by_tenant_object", (q: any) =>
        q.eq("tenantId", tenantId).eq("objectType", objectType),
      )
      .collect();

    let updated = 0;
    for (const rel of matches) {
      if (rel.relation === oldRelation) {
        await ctx.db.patch(rel._id, { relation: newRelation });
        updated++;
      }
    }

    return { updated };
  },
});

export const renameEntityType = mutation({
  args: {
    tenantId: v.optional(v.string()),
    oldType: v.string(),
    newType: v.string(),
  },
  handler: async (ctx: any, args: any) => {
    const { tenantId, oldType, newType } = args;

    let updated = 0;

    // Update relationships where entity appears as object
    const objectMatches = await ctx.db
      .query("relationships")
      .withIndex("by_tenant_object", (q: any) =>
        q.eq("tenantId", tenantId).eq("objectType", oldType),
      )
      .collect();

    for (const rel of objectMatches) {
      await ctx.db.patch(rel._id, { objectType: newType });
      updated++;
    }

    // Update relationships where entity appears as subject
    const subjectMatches = await ctx.db
      .query("relationships")
      .withIndex("by_tenant_subject_relation_object", (q: any) =>
        q.eq("tenantId", tenantId).eq("subjectType", oldType),
      )
      .collect();

    for (const rel of subjectMatches) {
      // Don't double-count if same row was already patched as object
      await ctx.db.patch(rel._id, { subjectType: newType });
      // Only count if this wasn't already counted above
      if (rel.objectType !== oldType) {
        updated++;
      }
    }

    return { updated };
  },
});
