/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { PropertyValidators } from "convex/values";

// Distributive helper: resolves relation keys for a target type, handling
// self-referential entities (where Target = EntName) by looking up the
// in-progress Relations instead of the not-yet-complete Entities record.
export type TargetRelationKeys<
  Target,
  EntName extends string,
  Relations,
  Entities extends Record<string, { relations: Record<string, string>; permissions: string; properties: Record<string, PropertyValidators> }>,
> = Target extends EntName
  ? keyof Relations & string
  : Target extends keyof Entities
    ? keyof Entities[Target]["relations"] & string
    : never;

// Resolves valid relation names on a target entity for reverse edge typing.
// When Target is the entity currently being defined (EntName), uses Relations.
// Otherwise, looks up the target's relations from the already-defined Entities.
export type ReverseTargetRelations<
  Target extends string,
  EntName extends string,
  Relations,
  Entities extends Record<string, { relations: Record<string, string>; permissions: string; properties: Record<string, PropertyValidators> }>,
> = Target extends EntName
  ? keyof Relations & string
  : Target extends keyof Entities
    ? keyof Entities[Target]["relations"] & string
    : never;

// Userset path: "entityType#relationName" (e.g. "group#admin").
// Uses # to distinguish from traversal dot-paths ("relation.targetRelation").
// For self-referential entities, we include RelName (the relation currently
// being defined) alongside the already-defined Relations.
export type EntityUsersetPath<
  EntName extends string,
  RelName extends string,
  Relations,
  Entities extends Record<string, { relations: Record<string, string>; permissions: string; properties: Record<string, PropertyValidators> }>,
> = {
  [E in (keyof Entities | EntName) & string]: E extends EntName
    ? `${E}#${(keyof Relations | RelName) & string}`
    : `${E}#${keyof Entities[E]["relations"] & string}`;
}[(keyof Entities | EntName) & string];
