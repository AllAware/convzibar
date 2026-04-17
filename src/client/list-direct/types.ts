import type { ActionCtx, QueryCtx } from "../internal";
import type {
  EntityPermissions,
  EntityRelations,
  ZbarSchema,
} from "../types";

/** Result row from a direct relationship query. */
export interface DirectRelationship {
  subject: { type: string; id: string };
  relation: string;
  object: { type: string; id: string };
  properties?: unknown;
}

/**
 * Entry point returned by `zbar.listDirect()`. Provide `.object()`,
 * `.subject()`, or both to scope the query.
 *
 * - `.object("device")` — all direct relationships where the object type is "device"
 * - `.object({ type: "device", id })` — all direct relationships for that specific object
 * - `.subject("user")` — all direct relationships where the subject type is "user"
 * - `.subject({ type: "user", id })` — all direct relationships for that specific subject
 *
 * At least one of `.object()` or `.subject()` must be called before `.collect()`.
 */
export interface ListDirectInitial<
  Schema extends ZbarSchema<Data>,
  Data,
> {
  object<OT extends keyof Schema["entities"] & string>(
    objectType: OT,
  ): ListDirectWithObjectType<Schema, Data, OT>;
  object<OT extends keyof Schema["entities"] & string>(
    object: { type: OT; id: string },
  ): ListDirectWithObjectInstance<Schema, Data, OT>;
  subject<ST extends keyof Schema["entities"] & string>(
    subjectType: ST,
  ): ListDirectSubjectOnly<Schema, Data>;
  subject<ST extends keyof Schema["entities"] & string>(
    subject: { type: ST; id: string },
  ): ListDirectSubjectOnly<Schema, Data>;
}

/** After `.object(type)` — can add `.subject()`, `.relation()`, `.permission()`, `.map()`, or `.collect()`. */
export interface ListDirectWithObjectType<
  Schema extends ZbarSchema<Data>,
  Data,
  OT extends keyof Schema["entities"] & string,
> {
  subject<ST extends keyof Schema["entities"] & string>(
    subjectType: ST,
  ): ListDirectCollectable<Schema, Data, OT>;
  subject<ST extends keyof Schema["entities"] & string>(
    subject: { type: ST; id: string },
  ): ListDirectCollectable<Schema, Data, OT>;
  relation<R extends EntityRelations<Schema, OT>>(
    relation: R,
  ): ListDirectObjectFiltered<Schema, Data, OT>;
  permission<P extends EntityPermissions<Schema, OT>>(
    permission: P,
  ): ListDirectObjectFiltered<Schema, Data, OT>;
  map<T>(
    fn: (item: DirectRelationship) => T | Promise<T>,
  ): ListDirectMapped<Data, T>;
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<DirectRelationship[]>;
}

/** After `.object({type, id})` — can add `.subject()`, `.relation()`, `.permission()`, `.map()`, or `.collect()`. */
export interface ListDirectWithObjectInstance<
  Schema extends ZbarSchema<Data>,
  Data,
  OT extends keyof Schema["entities"] & string,
> {
  subject<ST extends keyof Schema["entities"] & string>(
    subjectType: ST,
  ): ListDirectCollectable<Schema, Data, OT>;
  subject<ST extends keyof Schema["entities"] & string>(
    subject: { type: ST; id: string },
  ): ListDirectCollectable<Schema, Data, OT>;
  relation<R extends EntityRelations<Schema, OT>>(
    relation: R,
  ): ListDirectObjectFiltered<Schema, Data, OT>;
  permission<P extends EntityPermissions<Schema, OT>>(
    permission: P,
  ): ListDirectObjectFiltered<Schema, Data, OT>;
  map<T>(
    fn: (item: DirectRelationship) => T | Promise<T>,
  ): ListDirectMapped<Data, T>;
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<DirectRelationship[]>;
}

/** After `.object()` + `.relation()`/`.permission()` — can add `.subject()`, `.map()`, or `.collect()`. */
export interface ListDirectObjectFiltered<
  Schema extends ZbarSchema<Data>,
  Data,
  OT extends keyof Schema["entities"] & string,
> {
  subject<ST extends keyof Schema["entities"] & string>(
    subjectType: ST,
  ): ListDirectCollectable<Schema, Data, OT>;
  subject<ST extends keyof Schema["entities"] & string>(
    subject: { type: ST; id: string },
  ): ListDirectCollectable<Schema, Data, OT>;
  map<T>(
    fn: (item: DirectRelationship) => T | Promise<T>,
  ): ListDirectMapped<Data, T>;
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<DirectRelationship[]>;
}

/** After `.subject()` only (no object yet) — can add `.object()`, `.map()`, or `.collect()`. */
export interface ListDirectSubjectOnly<
  Schema extends ZbarSchema<Data>,
  Data,
> {
  object<OT extends keyof Schema["entities"] & string>(
    objectType: OT,
  ): ListDirectCollectable<Schema, Data, OT>;
  object<OT extends keyof Schema["entities"] & string>(
    object: { type: OT; id: string },
  ): ListDirectCollectable<Schema, Data, OT>;
  map<T>(
    fn: (item: DirectRelationship) => T | Promise<T>,
  ): ListDirectMapped<Data, T>;
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<DirectRelationship[]>;
}

/** Can add `.relation()`/`.permission()`, `.map()`, or `.collect()`. */
export interface ListDirectCollectable<
  Schema extends ZbarSchema<Data>,
  Data,
  OT extends keyof Schema["entities"] & string,
> {
  relation<R extends EntityRelations<Schema, OT>>(
    relation: R,
  ): ListDirectFinal<Data>;
  permission<P extends EntityPermissions<Schema, OT>>(
    permission: P,
  ): ListDirectFinal<Data>;
  map<T>(
    fn: (item: DirectRelationship) => T | Promise<T>,
  ): ListDirectMapped<Data, T>;
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<DirectRelationship[]>;
}

/** After `.relation()`/`.permission()` — can `.map()` or `.collect()`. */
export interface ListDirectFinal<Data> {
  map<T>(
    fn: (item: DirectRelationship) => T | Promise<T>,
  ): ListDirectMapped<Data, T>;
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<DirectRelationship[]>;
}

/** After `.map()` — terminal, can only `.collect()`. */
export interface ListDirectMapped<Data, T> {
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<T[]>;
}
