import type { ActionCtx, QueryCtx, ZbarInternal } from "../internal";
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

/**
 * Internal implementation of the fluent list query builder.
 * A single class implements all builder interfaces; the TypeScript interfaces
 * (in ./types.ts) restrict which methods are visible at each step.
 */
export class ListQueryBuilder<Schema extends ZbarSchema<Data>, Data> {
  private _objectType!: string;
  private _objectId?: string;
  private _subjectType?: string;
  private _subjectId?: string;
  private _relation?: string;
  private _permission?: string;
  private _via: Array<{ type: string; id: string }> = [];
  private _mode!: "listObjects" | "listSubjects";
  private _mapFn?: (item: any) => any;

  constructor(private z: ZbarInternal) {}

  object(objectOrType: string | { type: string; id: string }): this {
    if (typeof objectOrType === "string") {
      this._objectType = objectOrType;
      this._mode = "listObjects";
    } else {
      this._objectType = objectOrType.type;
      this._objectId = objectOrType.id;
      this._mode = "listSubjects";
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

  subject(subjectOrType: string | { type: string; id: string }): this {
    if (typeof subjectOrType === "string") {
      this._subjectType = subjectOrType;
    } else {
      this._subjectType = subjectOrType.type;
      this._subjectId = subjectOrType.id;
    }
    return this;
  }

  via(...entities: Array<{ type: string; id: string } | null | undefined>): this {
    this._via = entities.filter(
      (e): e is { type: string; id: string } =>
        e != null && typeof e.type === "string" && typeof e.id === "string",
    );
    return this;
  }

  map(fn: (item: any) => any): this {
    this._mapFn = fn;
    return this;
  }

  private _finalize(results: any[]): Promise<any[]> {
    if (this._mapFn) {
      return Promise.all(results.map(this._mapFn));
    }
    return Promise.resolve(results);
  }

  async collect(
    ctx: QueryCtx | ActionCtx,
    requestContext?: Data,
  ): Promise<Array<{ objectId: string } | { subjectId: string }>> {
    const z = this.z;
    const isPermission = this._permission != null;
    const relOrPerm = (this._relation ?? this._permission)!;

    // 1. Resolve which effective relations to query for
    const targets: Array<{ relation: string; condition?: string }> = isPermission
      ? resolvePermissionRelations(z, this._objectType, relOrPerm)
      : resolveRelationInheritance(z, this._objectType, relOrPerm);

    if (targets.length === 0) return [];
    const acceptableRelations = targets.map((t) => t.relation);
    const hasVia = this._via.length > 0;

    // Single permission-check plan drives every flavour of list — no-via
    // enumerates via expand*, via-slow-path verifies via checkBatch /
    // checkBatchSubjects. Conditions + RT fallback live inside the plan.
    const plan = planRelation(
      z,
      this._objectType,
      targets,
      relOrPerm,
      requestContext,
    );

    // Detect whether any conditions exist in the schema.  When there
    // are none we can skip the per-candidate permission verification
    // entirely in the via path because write-time materialisation
    // guarantees transitivity (subject→via + via→object ⇒ subject→object).
    const schemaHasConditions =
      Object.keys(z.schema.conditions || {}).length > 0;

    if (this._mode === "listObjects") {
      const subject = { type: this._subjectType!, id: this._subjectId! };
      const objectType = this._objectType;
      const ids = hasVia
        ? await collectViaObjects(
            z,
            ctx,
            plan,
            subject,
            this._via,
            objectType,
            acceptableRelations,
            schemaHasConditions,
            requestContext,
          )
        : await plan.expandObjects(ctx, subject, objectType);
      return this._finalize([...ids].map((id) => ({ objectId: id })));
    }

    const object = { type: this._objectType, id: this._objectId! };
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
          schemaHasConditions,
          requestContext,
        )
      : await plan.expandSubjects(ctx, object, subjectType);
    return this._finalize([...ids].map((id) => ({ subjectId: id })));
  }
}
