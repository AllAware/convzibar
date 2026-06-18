import type { ActionCtx, QueryCtx } from "../internal";
import type { ZbarSchema } from "../types";
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
 * Internal implementation of the fluent list query builder.
 * A single class implements all builder interfaces; the TypeScript interfaces
 * (in ./types.ts) restrict which methods are visible at each step.
 */
export class ListQueryBuilder<
  Schema extends ZbarSchema<Data>,
  Data,
> extends BaseListBuilder<ListResult> {
  private _via: Array<{ type: string; id: string }> = [];
  private _mode!: "listObjects" | "listSubjects";

  /**
   * Overridden to set `_mode` alongside the normal object/type assignment:
   * `object(string)` is the "list objects" flavour, `object({type, id})` is
   * the "list subjects" flavour.
   */
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

  async collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<ListResult[]> {
    const z = this.z;
    const isPermission = this._permission != null;
    const relOrPerm = (this._relation ?? this._permission)!;

    // 1. Resolve which effective relations to query for
    const targets: Array<{ relation: string; condition?: string }> = isPermission
      ? resolvePermissionRelations(z, this._objectType!, relOrPerm)
      : resolveRelationInheritance(z, this._objectType!, relOrPerm);

    if (targets.length === 0) return this._applyMap([]);
    const acceptableRelations = targets.map((t) => t.relation);
    const hasVia = this._via.length > 0;

    // Single permission-check plan drives every flavour of list — no-via
    // enumerates via expand*, via-slow-path verifies via checkBatch /
    // checkBatchSubjects. Conditions + RT fallback live inside the plan.
    const plan = planRelation(
      z,
      this._objectType!,
      targets,
      relOrPerm,
      requestContext,
    );

    if (this._mode === "listObjects") {
      const subject = { type: this._subjectType!, id: this._subjectId! };
      const objectType = this._objectType!;
      const ids = hasVia
        ? await collectViaObjects(
            z,
            ctx,
            plan,
            subject,
            this._via,
            objectType,
            acceptableRelations,
            requestContext,
          )
        : await plan.expandObjects(ctx, subject, objectType);
      return this._applyMap([...ids].map((id) => ({ objectId: id })));
    }

    const object = { type: this._objectType!, id: this._objectId! };
    const subjectType = this._subjectType!;
    const ids = hasVia
      ? await collectViaSubjects(
          z,
          ctx,
          plan,
          object,
          this._via,
          subjectType,
          acceptableRelations,
          requestContext,
        )
      : await plan.expandSubjects(ctx, object, subjectType);
    return this._applyMap([...ids].map((id) => ({ subjectId: id })));
  }
}
