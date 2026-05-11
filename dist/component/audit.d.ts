/**
 * Audit-log insertion helper. Three call sites (addRelation, removeRelation,
 * the deleteBaseRelationAndLog path) previously duplicated the exact same
 * `ctx.db.insert("auditLog", …)` body with only `action` differing.
 */
export type AuditAction = "relation_added" | "relation_removed";
export declare function writeAuditLog(ctx: any, args: {
    tenantId?: string;
    enableAuditLog?: boolean;
    action: AuditAction;
    subject: {
        type: string;
        id: string;
    };
    relation: string;
    object: {
        type: string;
        id: string;
    };
    actorId?: string;
}): Promise<void>;
//# sourceMappingURL=audit.d.ts.map