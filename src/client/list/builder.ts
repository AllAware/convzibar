import type { ActionCtx, QueryCtx } from "../internal";
import {
  resolvePermissionRelations,
  resolveRelationInheritance,
} from "../zbar/resolvers";
import {
  collectViaObjects,
  collectViaSubjects,
  planRelation,
} from "../zbar/traversal";
import { BaseListBuilder } from "./base";

type ListResult = { objectId: string } | { subjectId: string };

/**
 * Internal implementation of the fluent list query builder. A single class
 * implements all builder interfaces; the TypeScript interfaces (in ./types.ts)
 * restrict which methods are visible at each step.
 */
export class ListQueryBuilder extends BaseListBuilder<ListResult> {
  private _via: Array<{ type: string; id: string }> = [];
  private _mode!: "listObjects" | "listSubjects";

  override object(objectOrType: string | { type: string; id: string }): this {
    super.object(objectOrType);
    this._mode = typeof objectOrType === "string" ? "listObjects" : "listSubjects";
    return this;
  }

  via(...entities: Array<{ type: string; id: string } | null | undefined>): this {
    this._via = entities.filter(
      (e): e is { type: string; id: string } =>
        e != null && typeof e.type === "string" && typeof e.id === "string",
    );
    return this;
  }

  async collect(ctx: QueryCtx | ActionCtx): Promise<ListResult[]> {
    const z = this.z;
    const isPermission = this._permission != null;
    const relOrPerm = (this._relation ?? this._permission)!;

    const targets: string[] = isPermission
      ? resolvePermissionRelations(z, this._objectType!, relOrPerm)
      : resolveRelationInheritance(z, this._objectType!, relOrPerm);

    if (targets.length === 0) return this._applyMap([]);
    const acceptableRelations = targets;
    const hasVia = this._via.length > 0;

    const plan = planRelation(z, this._objectType!, targets);

    if (this._mode === "listObjects") {
      const subject = { type: this._subjectType!, id: this._subjectId! };
      const objectType = this._objectType!;
      const ids = hasVia
        ? await collectViaObjects(z, ctx, plan, subject, this._via, objectType, acceptableRelations)
        : await plan.expandObjects(ctx, subject, objectType);
      return this._applyMap([...ids].map((id) => ({ objectId: id })));
    }

    const object = { type: this._objectType!, id: this._objectId! };
    const subjectType = this._subjectType!;
    const ids = hasVia
      ? await collectViaSubjects(z, ctx, plan, object, this._via, subjectType, acceptableRelations)
      : await plan.expandSubjects(ctx, object, subjectType);
    return this._applyMap([...ids].map((id) => ({ subjectId: id })));
  }
}
