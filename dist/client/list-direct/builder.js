import { BaseListBuilder } from "../list/base";
import { resolvePermissionRelations, resolveRelationInheritance, } from "../zbar/resolvers";
/**
 * Internal implementation of the fluent direct-relationship query builder.
 */
export class ListDirectQueryBuilder extends BaseListBuilder {
    async collect(ctx) {
        const z = this.z;
        const objectType = this._objectType;
        // 1. Determine which relations to filter for.
        let filterRelations;
        if (this._permission && objectType) {
            // Permission → expand to all relations that satisfy it (including inherited).
            filterRelations = resolvePermissionRelations(z, objectType, this._permission);
        }
        else if (this._relation && objectType) {
            // Relation → expand with inheritance.
            filterRelations = resolveRelationInheritance(z, objectType, this._relation);
        }
        // 2. Build the query args.
        const subjectArg = this._subjectType && this._subjectId
            ? { type: this._subjectType, id: this._subjectId }
            : undefined;
        const objectArg = this._objectType && this._objectId
            ? { type: this._objectType, id: this._objectId }
            : undefined;
        // 3. Query base relationships from the component.
        // Pass type-only filters server-side to minimise data transfer
        // and leverage deeper index prefixes where possible.
        const rows = await ctx.runQuery(z.component.queries.listDirectRelationships, {
            subject: subjectArg,
            object: objectArg,
            relations: filterRelations,
            filterSubjectType: this._subjectType && !this._subjectId
                ? this._subjectType
                : undefined,
            filterObjectType: this._objectType && !this._objectId
                ? this._objectType
                : undefined,
        });
        // 4. Map to result shape.
        const results = rows.map((r) => ({
            subject: { type: r.subjectType, id: r.subjectId },
            relation: r.relation,
            object: { type: r.objectType, id: r.objectId },
            properties: r.properties,
        }));
        // 5. Apply user-provided mapper in parallel if present.
        return this._applyMap(results);
    }
}
//# sourceMappingURL=builder.js.map