import { mutation } from "./_generated/server";
import { v } from "convex/values";
import {
  conditionValidator,
  objectValidator,
  subjectValidator,
} from "./validators";
import type { GraphConfig } from "./types";

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
    createdBy: v.optional(v.string()),
    graphConfig: v.any(), // GraphConfig
    enableAuditLog: v.optional(v.boolean()),
  },
  handler: async (ctx: any, args: any) => {
    const {
      tenantId,
      subject,
      relation,
      object,
      condition,
      createdBy,
      enableAuditLog,
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
      createdBy,
      createdAt: Date.now(),
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
      isDirect: true,
      tokens: [relId],
      conditions: condition ? [condition] : undefined,
    };

    const queue: Array<{
      subject: { type: string; id: string };
      relation: string;
      object: { type: string; id: string };
      path: any;
    }> = [
      {
        subject,
        relation,
        object,
        path: pathItem,
      },
    ];

    const reverseRel = graphConfig.reverseEdges?.[object.type]?.[relation];
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
        // Insert reverse relationship into relationships table too
        const revId = await ctx.db.insert("relationships", {
          tenantId,
          subjectType: object.type,
          subjectId: object.id,
          relation: reverseRel,
          objectType: subject.type,
          objectId: subject.id,
          createdBy,
          createdAt: Date.now(),
        });

        // Queue it for effectiveRelationships and traversals
        queue.push({
          subject: object,
          relation: reverseRel,
          object: subject,
          path: {
            isDirect: true,
            tokens: [revId],
          },
        });
      }
    }

    while (queue.length > 0) {
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

      if (!eff) {
        eff = {
          _id: await ctx.db.insert("effectiveRelationships", {
            tenantId,
            subjectKey: sKey,
            subjectType: current.subject.type,
            subjectId: current.subject.id,
            relation: current.relation,
            objectKey: oKey,
            objectType: current.object.type,
            objectId: current.object.id,
            paths: [current.path],
            createdBy,
            createdAt: Date.now(),
          }),
        };
        isNewOrUpdated = true;
      } else {
        const pathExists = eff.paths.some(
          (p: any) =>
            p.tokens &&
            current.path.tokens &&
            p.tokens.length === current.path.tokens.length &&
            p.tokens.every(
              (t: string, i: number) => t === current.path.tokens[i],
            ),
        );

        if (!pathExists) {
          const newPaths = [...eff.paths, current.path];
          await ctx.db.patch(eff._id, { paths: newPaths });
          isNewOrUpdated = true;
        }
      }

      if (isNewOrUpdated) {
        for (const rule of graphConfig.traversalRules) {
          if (
            current.subject.type === rule.sourceObjectType &&
            current.relation === rule.sourceRelation
          ) {
            const matches = await ctx.db
              .query("effectiveRelationships")
              .withIndex("by_tenant_object_relation", (q: any) =>
                q
                  .eq("tenantId", tenantId)
                  .eq("objectKey", oKey)
                  .eq("relation", rule.targetRelation),
              )
              .collect();

            for (const match of matches) {
              const derivedSubject = {
                type: match.subjectType,
                id: match.subjectId,
              };
              const derivedObject = current.subject;

              for (const matchPath of match.paths) {
                const schemaCondition = rule.condition
                  ? [{ condition: rule.condition }]
                  : [];
                const combinedConditions = [
                  ...(matchPath.conditions || []),
                  ...(current.path.conditions || []),
                  ...schemaCondition,
                ];

                queue.push({
                  subject: derivedSubject,
                  relation: rule.derivedRelation,
                  object: derivedObject,
                  path: {
                    isDirect: false,
                    tokens: [
                      ...current.path.tokens,
                      ...matchPath.tokens,
                      match._id,
                      eff._id,
                    ],
                    conditions:
                      combinedConditions.length > 0
                        ? combinedConditions
                        : undefined,
                  },
                });
              }
            }
          }

          if (current.relation === rule.targetRelation) {
            const matches = await ctx.db
              .query("effectiveRelationships")
              .withIndex("by_tenant_object_relation", (q: any) =>
                q
                  .eq("tenantId", tenantId)
                  .eq("objectKey", oKey)
                  .eq("relation", rule.sourceRelation),
              )
              .collect();

            for (const match of matches) {
              if (match.subjectType === rule.sourceObjectType) {
                const derivedSubject = current.subject;
                const derivedObject = {
                  type: match.subjectType,
                  id: match.subjectId,
                };

                for (const matchPath of match.paths) {
                  const schemaCondition = rule.condition
                    ? [{ condition: rule.condition }]
                    : [];
                  const combinedConditions = [
                    ...(current.path.conditions || []),
                    ...(matchPath.conditions || []),
                    ...schemaCondition,
                  ];

                  queue.push({
                    subject: derivedSubject,
                    relation: rule.derivedRelation,
                    object: derivedObject,
                    path: {
                      isDirect: false,
                      tokens: [
                        ...current.path.tokens,
                        ...matchPath.tokens,
                        match._id,
                        eff._id,
                      ],
                      conditions:
                        combinedConditions.length > 0
                          ? combinedConditions
                          : undefined,
                    },
                  });
                }
              }
            }
          }
        }
      }
    }

    return relId;
  },
});

async function removeRelationInternal(ctx: any, args: any) {
  const { tenantId, subject, relation, object, actorId, enableAuditLog } = args;
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

  if (!existingRel) return false;

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

  let effectiveRelationshipsRemoved = 0;

  while (queue.length > 0) {
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
        (p: any) => !p.tokens || !p.tokens.includes(current.removedRelationId),
      );

      if (remainingPaths.length === 0) {
        await ctx.db.delete(eff._id);
        effectiveRelationshipsRemoved++;

        // If this effective relationship is fully deleted, cascade the deletion
        for (const rule of graphConfig.traversalRules) {
          if (
            current.subject.type === rule.sourceObjectType &&
            current.relation === rule.sourceRelation
          ) {
            const matches = await ctx.db
              .query("effectiveRelationships")
              .withIndex("by_tenant_object_relation", (q: any) =>
                q
                  .eq("tenantId", tenantId)
                  .eq("objectKey", oKey)
                  .eq("relation", rule.targetRelation),
              )
              .collect();

            for (const match of matches) {
              queue.push({
                subject: { type: match.subjectType, id: match.subjectId },
                relation: rule.derivedRelation,
                object: current.subject,
                removedRelationId: eff._id,
              });
            }
          }

          if (current.relation === rule.targetRelation) {
            const matches = await ctx.db
              .query("effectiveRelationships")
              .withIndex("by_tenant_object_relation", (q: any) =>
                q
                  .eq("tenantId", tenantId)
                  .eq("objectKey", oKey)
                  .eq("relation", rule.sourceRelation),
              )
              .collect();

            for (const match of matches) {
              if (match.subjectType === rule.sourceObjectType) {
                queue.push({
                  subject: current.subject,
                  relation: rule.derivedRelation,
                  object: { type: match.subjectType, id: match.subjectId },
                  removedRelationId: eff._id,
                });
              }
            }
          }
        }
      } else if (remainingPaths.length !== eff.paths.length) {
        await ctx.db.patch(eff._id, { paths: remainingPaths });
      }
    }
  }

  return { removed: true, effectiveRelationshipsRemoved };
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
  },
  handler: async (ctx: any, args: any) => {
    const res = await removeRelationInternal(ctx, args);
    return res ? res.removed : false;
  },
});

export const deleteEntity = mutation({
  args: {
    tenantId: v.optional(v.string()),
    entity: subjectValidator, // { type, id }
    actorId: v.optional(v.string()),
    graphConfig: v.any(),
    enableAuditLog: v.optional(v.boolean()),
  },
  handler: async (ctx: any, args: any) => {
    const { tenantId, entity, actorId, graphConfig, enableAuditLog } = args;

    let relationshipsRemoved = 0;
    let effectiveRelationshipsRemoved = 0;

    // 1. Where entity is subject
    const subjectMatches = await ctx.db
      .query("relationships")
      .withIndex("by_tenant_subject", (q: any) =>
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
