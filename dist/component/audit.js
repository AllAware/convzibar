/**
 * Audit-log insertion helper. Three call sites (addRelation, removeRelation,
 * the deleteBaseRelationAndLog path) previously duplicated the exact same
 * `ctx.db.insert("auditLog", …)` body with only `action` differing.
 */
import { buildScopeKey } from "../shared/keys";
export async function writeAuditLog(ctx, args) {
    if (args.enableAuditLog === false)
        return;
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
//# sourceMappingURL=audit.js.map