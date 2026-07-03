declare const _default: import("convex/server").SchemaDefinition<{
    relationships: import("convex/server").TableDefinition<import("convex/values").VObject<{
        properties?: any;
        tenantId?: string | undefined;
        condition?: string | undefined;
        conditionContext?: any;
        relation: string;
        objectId: string;
        subjectId: string;
        subjectType: string;
        objectType: string;
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
    }, "required", "properties" | "relation" | "objectId" | "subjectId" | "subjectType" | "objectType" | "tenantId" | "condition" | "conditionContext" | `properties.${string}` | `conditionContext.${string}`>, {
        by_object: ["objectType", "objectId", "_creationTime"];
        by_subject_relation_object: ["subjectType", "subjectId", "relation", "objectType", "objectId", "_creationTime"];
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
        }, "required", "baseIds" | "conditions">, "required">;
    }, "required", "relation" | "objectKey" | "subjectKey" | "tenantId" | "paths">, {
        by_subject_relation_object: ["subjectKey", "relation", "objectKey", "_creationTime"];
        by_object_relation_subject: ["objectKey", "relation", "subjectKey", "_creationTime"];
    }, {}, {}>;
    auditLog: import("convex/server").TableDefinition<import("convex/values").VObject<{
        tenantId?: string | undefined;
        actorId?: string | undefined;
        timestamp: number;
        action: "permission_check" | "relation_added" | "relation_removed";
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
        action: import("convex/values").VUnion<"permission_check" | "relation_added" | "relation_removed", [import("convex/values").VLiteral<"permission_check", "required">, import("convex/values").VLiteral<"relation_added", "required">, import("convex/values").VLiteral<"relation_removed", "required">], "required", never>;
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
    }, "required", "tenantId" | "timestamp" | "action" | "userId" | "actorId" | "details" | "details.object" | "details.relation" | "details.subject" | "details.permission" | "details.result" | "details.reason">, {}, {}, {}>;
    configs: import("convex/server").TableDefinition<import("convex/values").VObject<{
        hash: string;
        config: any;
    }, {
        hash: import("convex/values").VString<string, "required">;
        config: import("convex/values").VAny<any, "required", string>;
    }, "required", "hash" | "config" | `config.${string}`>, {
        by_hash: ["hash", "_creationTime"];
    }, {}, {}>;
}, true>;
export default _default;
//# sourceMappingURL=schema.d.ts.map