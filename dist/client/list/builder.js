import { resolvePermissionRelations, resolveRelationInheritance, } from "../zbar/resolvers";
import { collectViaObjects, collectViaSubjects, planRelation, } from "../zbar/traversal";
import { BaseListBuilder } from "./base";
/**
 * Internal implementation of the fluent list query builder.
 * A single class implements all builder interfaces; the TypeScript interfaces
 * (in ./types.ts) restrict which methods are visible at each step.
 */
export class ListQueryBuilder extends BaseListBuilder {
    _via = [];
    _mode;
    /**
     * Overridden to set `_mode` alongside the normal object/type assignment:
     * `object(string)` is the "list objects" flavour, `object({type, id})` is
     * the "list subjects" flavour.
     */
    object(objectOrType) {
        super.object(objectOrType);
        this._mode = typeof objectOrType === "string" ? "listObjects" : "listSubjects";
        return this;
    }
    via(...entities) {
        this._via = entities.filter((e) => e != null && typeof e.type === "string" && typeof e.id === "string");
        return this;
    }
    async collect(ctx, requestContext) {
        const z = this.z;
        const isPermission = this._permission != null;
        const relOrPerm = (this._relation ?? this._permission);
        // 1. Resolve which effective relations to query for
        const targets = isPermission
            ? resolvePermissionRelations(z, this._objectType, relOrPerm)
            : resolveRelationInheritance(z, this._objectType, relOrPerm);
        if (targets.length === 0)
            return this._applyMap([]);
        const acceptableRelations = targets.map((t) => t.relation);
        const hasVia = this._via.length > 0;
        // Single permission-check plan drives every flavour of list — no-via
        // enumerates via expand*, via-slow-path verifies via checkBatch /
        // checkBatchSubjects. Conditions + RT fallback live inside the plan.
        const plan = planRelation(z, this._objectType, targets, relOrPerm, requestContext);
        // Detect whether any conditions exist in the schema.  When there
        // are none we can skip the per-candidate permission verification
        // entirely in the via path because write-time materialisation
        // guarantees transitivity (subject→via + via→object ⇒ subject→object).
        const schemaHasConditions = Object.keys(z.schema.conditions || {}).length > 0;
        if (this._mode === "listObjects") {
            const subject = { type: this._subjectType, id: this._subjectId };
            const objectType = this._objectType;
            const ids = hasVia
                ? await collectViaObjects(z, ctx, plan, subject, this._via, objectType, acceptableRelations, schemaHasConditions, requestContext)
                : await plan.expandObjects(ctx, subject, objectType);
            return this._applyMap([...ids].map((id) => ({ objectId: id })));
        }
        const object = { type: this._objectType, id: this._objectId };
        const subjectType = this._subjectType;
        const ids = hasVia
            ? await collectViaSubjects(z, ctx, plan, object, this._via, subjectType, acceptableRelations, schemaHasConditions, requestContext)
            : await plan.expandSubjects(ctx, object, subjectType);
        return this._applyMap([...ids].map((id) => ({ subjectId: id })));
    }
}
//# sourceMappingURL=builder.js.map