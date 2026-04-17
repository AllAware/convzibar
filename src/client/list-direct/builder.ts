import type { ActionCtx, QueryCtx, ZbarInternal } from "../internal";
import {
  resolvePermissionRelations,
  resolveRelationInheritance,
} from "../zbar/resolvers";
import type { DirectRelationship } from "./types";

/**
 * Internal implementation of the fluent direct-relationship query builder.
 */
export class ListDirectQueryBuilder {
  private _objectType?: string;
  private _objectId?: string;
  private _subjectType?: string;
  private _subjectId?: string;
  private _relation?: string;
  private _permission?: string;
  private _mapFn?: (item: any) => any;

  constructor(private z: ZbarInternal) {}

  object(objectOrType: string | { type: string; id: string }): this {
    if (typeof objectOrType === "string") {
      this._objectType = objectOrType;
    } else {
      this._objectType = objectOrType.type;
      this._objectId = objectOrType.id;
    }
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

  relation(relation: string): this {
    this._relation = relation;
    return this;
  }

  permission(permission: string): this {
    this._permission = permission;
    return this;
  }

  map(fn: (item: any) => any): this {
    this._mapFn = fn;
    return this;
  }

  async collect(
    ctx: QueryCtx | ActionCtx,
  ): Promise<DirectRelationship[]> {
    const z = this.z;
    const objectType = this._objectType;

    // 1. Determine which relations to filter for.
    let filterRelations: string[] | undefined;

    if (this._permission && objectType) {
      // Permission → expand to all relations that satisfy it (including inherited).
      const targets = resolvePermissionRelations(z, objectType, this._permission);
      filterRelations = targets.map((t) => t.relation);
    } else if (this._relation && objectType) {
      // Relation → expand with inheritance.
      const targets = resolveRelationInheritance(z, objectType, this._relation);
      filterRelations = targets.map((t) => t.relation);
    }

    // 2. Build the query args.
    const subjectArg =
      this._subjectType && this._subjectId
        ? { type: this._subjectType, id: this._subjectId }
        : undefined;
    const objectArg =
      this._objectType && this._objectId
        ? { type: this._objectType, id: this._objectId }
        : undefined;

    // 3. Query base relationships from the component.
    // Pass type-only filters server-side to minimise data transfer
    // and leverage deeper index prefixes where possible.
    const rows: any[] = await ctx.runQuery(
      z.component.queries.listDirectRelationships,
      {
        tenantId: z.tenantId,
        subject: subjectArg,
        object: objectArg,
        relations: filterRelations,
        filterSubjectType:
          this._subjectType && !this._subjectId
            ? this._subjectType
            : undefined,
        filterObjectType:
          this._objectType && !this._objectId
            ? this._objectType
            : undefined,
      },
    );

    // 4. Map to result shape.
    const results = rows.map((r: any) => ({
      subject: { type: r.subjectType, id: r.subjectId },
      relation: r.relation,
      object: { type: r.objectType, id: r.objectId },
      properties: r.properties,
    }));

    // 5. Apply user-provided mapper in parallel if present.
    if (this._mapFn) {
      return Promise.all(results.map(this._mapFn));
    }

    return results;
  }
}
