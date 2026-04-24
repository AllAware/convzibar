/**
 * Audit-log insertion helper. Three call sites (addRelation, removeRelation,
 * the deleteBaseRelationAndLog path) previously duplicated the exact same
 * `ctx.db.insert("auditLog", …)` body with only `action` differing.
 */

import { buildScopeKey } from "../shared/keys";

export type AuditAction = "relation_added" | "relation_removed";

export async function writeAuditLog(
  ctx: any,
  args: {
    tenantId?: string;
    enableAuditLog?: boolean;
    action: AuditAction;
    subject: { type: string; id: string };
    relation: string;
    object: { type: string; id: string };
    actorId?: string;
  },
): Promise<void> {
  if (args.enableAuditLog === false) return;
  await ctx.db.insert("auditLog", {
    tenantId: args.tenantId,
    timestamp: Date.now(),
    action: args.action,
    userId: args.subject.type === "user" ? args.subject.id : "system",
    actorId: args.actorId,
    details: {
      relation: args.relation,
      subject: buildScopeKey(args.subject.type, args.subject.id),
      object: buildScopeKey(args.object.type, args.object.id),
    },
  });
}
