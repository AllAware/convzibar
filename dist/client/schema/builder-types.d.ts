import type { PropertyValidators } from "convex/values";
export type TargetRelationKeys<Target, EntName extends string, Relations, Entities extends Record<string, {
    relations: Record<string, string>;
    permissions: string;
    properties: Record<string, PropertyValidators>;
}>> = Target extends EntName ? keyof Relations & string : Target extends keyof Entities ? keyof Entities[Target]["relations"] & string : never;
export type ReverseTargetRelations<Target extends string, EntName extends string, Relations, Entities extends Record<string, {
    relations: Record<string, string>;
    permissions: string;
    properties: Record<string, PropertyValidators>;
}>> = Target extends EntName ? keyof Relations & string : Target extends keyof Entities ? keyof Entities[Target]["relations"] & string : never;
export type EntityUsersetPath<EntName extends string, RelName extends string, Relations, Entities extends Record<string, {
    relations: Record<string, string>;
    permissions: string;
    properties: Record<string, PropertyValidators>;
}>> = {
    [E in (keyof Entities | EntName) & string]: E extends EntName ? `${E}#${(keyof Relations | RelName) & string}` : `${E}#${keyof Entities[E]["relations"] & string}`;
}[(keyof Entities | EntName) & string];
//# sourceMappingURL=builder-types.d.ts.map