import type { ActionCtx, QueryCtx } from "../internal";
import type {
  EntityPermissions,
  EntityRelations,
  ZbarSchema,
} from "../types";

/**
 * Entry point returned by `zbar.list()`. Call `.object()` to begin building
 * a list query.
 *
 * - `.object("device")` — list **objects** of that type (subject will need `{type, id}`)
 * - `.object({ type: "device", id })` — list **subjects** that relate to that object (subject will need just a type string)
 */
export interface ListInitial<
  Schema extends ZbarSchema<Data>,
  Data,
> {
  object<OT extends keyof Schema["entities"] & string>(
    objectType: OT,
  ): ListWithObjectType<Schema, Data, OT>;
  object<OT extends keyof Schema["entities"] & string>(
    object: { type: OT; id: string },
  ): ListWithObjectInstance<Schema, Data, OT>;
}

/** After `.object(type)` — listing objects. Pick a relation or permission. */
export interface ListWithObjectType<
  Schema extends ZbarSchema<Data>,
  Data,
  OT extends keyof Schema["entities"] & string,
> {
  relation<R extends EntityRelations<Schema, OT>>(
    relation: R,
  ): ListObjectsNeedSubject<Schema, Data>;
  permission<P extends EntityPermissions<Schema, OT>>(
    permission: P,
  ): ListObjectsNeedSubject<Schema, Data>;
}

/** After `.object({type, id})` — listing subjects. Pick a relation or permission. */
export interface ListWithObjectInstance<
  Schema extends ZbarSchema<Data>,
  Data,
  OT extends keyof Schema["entities"] & string,
> {
  relation<R extends EntityRelations<Schema, OT>>(
    relation: R,
  ): ListSubjectsNeedSubject<Schema, Data>;
  permission<P extends EntityPermissions<Schema, OT>>(
    permission: P,
  ): ListSubjectsNeedSubject<Schema, Data>;
}

/** Listing objects — subject must be a full `{type, id}` pair. */
export interface ListObjectsNeedSubject<
  Schema extends ZbarSchema<Data>,
  Data,
> {
  subject<ST extends keyof Schema["entities"] & string>(
    subject: { type: ST; id: string },
  ): ListCollectable<Schema, Data, { objectId: string }>;
}

/** Listing subjects — subject is just a type string. */
export interface ListSubjectsNeedSubject<
  Schema extends ZbarSchema<Data>,
  Data,
> {
  subject<ST extends keyof Schema["entities"] & string>(
    subjectType: ST,
  ): ListCollectable<Schema, Data, { subjectId: string }>;
}

/** Ready to collect, with optional `.via()` filtering and `.map()`. */
export interface ListCollectable<
  Schema extends ZbarSchema<Data>,
  Data,
  Result,
> {
  via<VT extends keyof Schema["entities"] & string>(
    ...entities: Array<{ type: VT; id: string } | null | undefined>
  ): ListFinal<Data, Result>;
  map<T>(
    fn: (item: Result) => T | Promise<T>,
  ): ListMapped<Data, T>;
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<Result[]>;
}

/** After `.via()` — can `.map()` or `.collect()`. */
export interface ListFinal<Data, Result> {
  map<T>(
    fn: (item: Result) => T | Promise<T>,
  ): ListMapped<Data, T>;
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<Result[]>;
}

/** After `.map()` — terminal, can only `.collect()`. */
export interface ListMapped<Data, T> {
  collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<T[]>;
}
