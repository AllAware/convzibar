export declare const subjectValidator: import("convex/values").VObject<{
    type: string;
    id: string;
}, {
    type: import("convex/values").VString<string, "required">;
    id: import("convex/values").VString<string, "required">;
}, "required", "type" | "id">;
export declare const objectValidator: import("convex/values").VObject<{
    type: string;
    id: string;
}, {
    type: import("convex/values").VString<string, "required">;
    id: import("convex/values").VString<string, "required">;
}, "required", "type" | "id">;
export declare const conditionValidator: import("convex/values").VObject<{
    conditionContext?: any;
    condition: string;
} | undefined, {
    condition: import("convex/values").VString<string, "required">;
    conditionContext: import("convex/values").VAny<any, "optional", string>;
}, "optional", "condition" | "conditionContext" | `conditionContext.${string}`>;
export declare const propertiesValidator: import("convex/values").VAny<any, "optional", string>;
//# sourceMappingURL=validators.d.ts.map