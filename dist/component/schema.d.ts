declare const _default: import("convex/server").SchemaDefinition<{
    relationships: import("convex/server").TableDefinition<import("convex/values").VObject<{
        properties?: any;
        condition?: string | undefined;
        tenantId?: string | undefined;
        conditionContext?: any;
        relation: string;
        objectType: string;
        subjectType: string;
        objectId: string;
        subjectId: string;
    }, {
        tenantId: import("convex/values").VString<string | undefined, "optional">;
        subjectType: import("convex/values").VString<string, "required">;
        subjectId: import("convex/values").VString<string, "required">;
        relation: import("convex/values").VString<string, "required">;
        objectType: import("convex/values").VString<string, "required">;
        objectId: import("convex/values").VString<string, "required">;
        condition: import("convex/values").VString<string | undefined, "optional">;
        conditionContext: import("convex/values").VAny<any, "optional", string>;
        properties: import("convex/values").VAny<any, "optional", string>;
    }, "required", "properties" | "relation" | "condition" | "tenantId" | "objectType" | "subjectType" | "objectId" | "subjectId" | "conditionContext" | `properties.${string}` | `conditionContext.${string}`>, {
        by_tenant_object: ["tenantId", "objectType", "objectId", "_creationTime"];
        by_tenant_subject_relation_object: ["tenantId", "subjectType", "subjectId", "relation", "objectType", "objectId", "_creationTime"];
    }, {}, {}>;
    effectiveRelationships: import("convex/server").TableDefinition<import("convex/values").VObject<{
        tenantId?: string | undefined;
        relation: string;
        objectKey: string;
        subjectKey: string;
        paths: {
            conditions?: {
                conditionContext?: any;
                condition: string;
            }[] | undefined;
            baseIds: string[];
        }[];
    }, {
        tenantId: import("convex/values").VString<string | undefined, "optional">;
        subjectKey: import("convex/values").VString<string, "required">;
        relation: import("convex/values").VString<string, "required">;
        objectKey: import("convex/values").VString<string, "required">;
        paths: import("convex/values").VArray<{
            conditions?: {
                conditionContext?: any;
                condition: string;
            }[] | undefined;
            baseIds: string[];
        }[], import("convex/values").VObject<{
            conditions?: {
                conditionContext?: any;
                condition: string;
            }[] | undefined;
            baseIds: string[];
        }, {
            baseIds: import("convex/values").VArray<string[], import("convex/values").VString<string, "required">, "required">;
            conditions: import("convex/values").VArray<{
                conditionContext?: any;
                condition: string;
            }[] | undefined, import("convex/values").VObject<{
                conditionContext?: any;
                condition: string;
            }, {
                condition: import("convex/values").VString<string, "required">;
                conditionContext: import("convex/values").VAny<any, "optional", string>;
            }, "required", "condition" | "conditionContext" | `conditionContext.${string}`>, "optional">;
        }, "required", "conditions" | "baseIds">, "required">;
    }, "required", "relation" | "tenantId" | "objectKey" | "subjectKey" | "paths">, {
        by_tenant_subject_relation_object: ["tenantId", "subjectKey", "relation", "objectKey", "_creationTime"];
        by_tenant_object_relation_subject: ["tenantId", "objectKey", "relation", "subjectKey", "_creationTime"];
    }, {}, {}>;
    auditLog: import("convex/server").TableDefinition<import("convex/values").VObject<{
        tenantId?: string | undefined;
        actorId?: string | undefined;
        timestamp: number;
        action: "relation_added" | "relation_removed" | "permission_check";
        userId: string;
        details: {
            object?: string | undefined;
            relation?: string | undefined;
            subject?: string | undefined;
            permission?: string | undefined;
            result?: boolean | undefined;
            reason?: string | undefined;
        };
    }, {
        tenantId: import("convex/values").VString<string | undefined, "optional">;
        timestamp: import("convex/values").VFloat64<number, "required">;
        action: import("convex/values").VUnion<"relation_added" | "relation_removed" | "permission_check", [import("convex/values").VLiteral<"permission_check", "required">, import("convex/values").VLiteral<"relation_added", "required">, import("convex/values").VLiteral<"relation_removed", "required">], "required", never>;
        userId: import("convex/values").VString<string, "required">;
        actorId: import("convex/values").VString<string | undefined, "optional">;
        details: import("convex/values").VObject<{
            object?: string | undefined;
            relation?: string | undefined;
            subject?: string | undefined;
            permission?: string | undefined;
            result?: boolean | undefined;
            reason?: string | undefined;
        }, {
            permission: import("convex/values").VString<string | undefined, "optional">;
            result: import("convex/values").VBoolean<boolean | undefined, "optional">;
            relation: import("convex/values").VString<string | undefined, "optional">;
            subject: import("convex/values").VString<string | undefined, "optional">;
            object: import("convex/values").VString<string | undefined, "optional">;
            reason: import("convex/values").VString<string | undefined, "optional">;
        }, "required", "object" | "relation" | "subject" | "permission" | "result" | "reason">;
    }, "required", "tenantId" | "actorId" | "timestamp" | "action" | "userId" | "details" | "details.object" | "details.relation" | "details.subject" | "details.permission" | "details.result" | "details.reason">, {}, {}, {}>;
}, true>;
export default _default;
//# sourceMappingURL=schema.d.ts.map