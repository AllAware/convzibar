/**
 * Shared base for the two list-style fluent builders. Holds the fields and
 * setters both builders need (`.object()`, `.subject()`, `.relation()`,
 * `.permission()`, `.map()`) so only the terminal `.collect()` logic
 * differs between them.
 *
 * Kept deliberately minimal — the concrete subclasses add their own state
 * (e.g. `_via`, `_mode`) as needed, and may override `object()` to react
 * to the kind of argument passed in.
 */
import type { ZbarInternal } from "../internal";

export abstract class BaseListBuilder<Item> {
  protected _objectType?: string;
  protected _objectId?: string;
  protected _subjectType?: string;
  protected _subjectId?: string;
  protected _relation?: string;
  protected _permission?: string;
  protected _mapFn?: (item: Item) => unknown;

  constructor(protected readonly z: ZbarInternal) {}

  object(objectOrType: string | { type: string; id: string }): this {
    if (typeof objectOrType === "string") {
      this._objectType = objectOrType;
      this._objectId = undefined;
    } else {
      this._objectType = objectOrType.type;
      this._objectId = objectOrType.id;
    }
    return this;
  }

  subject(subjectOrType: string | { type: string; id: string }): this {
    if (typeof subjectOrType === "string") {
      this._subjectType = subjectOrType;
      this._subjectId = undefined;
    } else {
      this._subjectType = subjectOrType.type;
      this._subjectId = subjectOrType.id;
    }
    return this;
  }

  relation(relation: string): this {
    this._relation = relation;
    return this;
  }

  permission(permission: string): this {
    this._permission = permission;
    return this;
  }

  map(fn: (item: Item) => unknown): this {
    this._mapFn = fn;
    return this;
  }

  protected async _applyMap<T>(items: Item[]): Promise<T[]> {
    if (!this._mapFn) return items as unknown as T[];
    return Promise.all(items.map(this._mapFn as (item: Item) => T));
  }
}
