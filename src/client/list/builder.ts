import type { ActionCtx, QueryCtx, ZbarInternal } from "../internal";
import type { ZbarSchema } from "../types";
import {
  resolvePermissionRelations,
  resolveRelationInheritance,
} from "../zbar/resolvers";
import {
  appendReadTimeHits,
  hasAccessOrRT,
  listReadTimeObjects,
  listReadTimeSubjects,
} from "../zbar/read-time";
import {
  getEntityRelations,
  getReverseStructuralRelations,
  getStructuralRelations,
  getViaRelevantRelations,
} from "../zbar/structural";
import { listWithValidation } from "../zbar/validation";

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

    // Detect whether any conditions exist in the schema.  When there
    // are none we can skip the per-candidate permission verification
    // entirely in the via path because write-time materialisation
    // guarantees transitivity (subject→via + via→object ⇒ subject→object).
    const schemaHasConditions =
      Object.keys(z.schema.conditions || {}).length > 0;

    if (this._mode === "listObjects") {
      const subject = { type: this._subjectType!, id: this._subjectId! };
      const objectType = this._objectType;

      if (hasVia) {
        // ── Chained gate-check + expand ───────────────────────────
        // Chain: subject → via[0] → via[1] → … → via[N-1] → objects
        //
        // 1. Gate: subject → via[0] using permission-relevant
        //    relations (derived from userset rewrites).
        // 2. Chain links: via[i] → via[i+1] connectivity checks.
        // 3. Expand: via[N-1] → objects (the only range scan).
        //
        // All queries fire in parallel; any failure → return [].

        const viaChain = this._via;
        const firstVia = viaChain[0];
        const lastVia = viaChain[viaChain.length - 1];

        // Tight gate relations: only the relations on firstVia's type
        // that are referenced by userset rewrites in the acceptable
        // relations (e.g. device.admin ← system#admin → "admin" on system).
        const tightGateRelations = getViaRelevantRelations(
          z,
          objectType,
          acceptableRelations,
          firstVia.type,
        );
        const gateRelations =
          tightGateRelations.length > 0
            ? tightGateRelations
            : getEntityRelations(z, firstVia.type);
        const isTightGate = tightGateRelations.length > 0;

        // — Fire gate + chain + expand in parallel —
        // Gate and chain go through `hasAccessOrRT` so they compose with
        // `.readTimeRelation()` declarations on the via entities. Expand
        // stays materialised-only: it reads structural schema relations
        // (e.g. contact.owner, system#contact_member) which are not RT-able.

        const gatePromise: Promise<boolean> = hasAccessOrRT(
          z,
          ctx,
          subject,
          gateRelations,
          firstVia,
        );

        const chainPromises: Array<Promise<boolean>> = [];
        for (let i = 0; i < viaChain.length - 1; i++) {
          const next = viaChain[i + 1];
          chainPromises.push(
            hasAccessOrRT(
              z,
              ctx,
              viaChain[i],
              getEntityRelations(z, next.type),
              next,
            ),
          );
        }

        // Expand: via[N-1] → objects.
        // Use structural relations (e.g. device.owner → system) when the
        // via entity connects to the object type via a typed relation,
        // otherwise fall back to acceptable (permission-derived) relations.
        //
        // Two directions must be checked:
        //   Forward: via entity is the subject (e.g. device#owner@system)
        //   Reverse: via entity is the object (e.g. system#device_member has
        //            device as subject — used for transitive membership like
        //            system.device_member = has_group.device_member)
        const structuralExpandRels = getStructuralRelations(
          z,
          objectType,
          lastVia.type,
        );
        const reverseStructuralRels = getReverseStructuralRelations(
          z,
          objectType,
          lastVia.type,
        );
        const hasStructural =
          structuralExpandRels.length > 0 || reverseStructuralRels.length > 0;

        const expandPromises: Array<Promise<any>> = [];
        if (hasStructural) {
          if (structuralExpandRels.length > 0) {
            expandPromises.push(
              ctx.runQuery(z.component.queries.listAccessibleObjectsFast, {
                tenantId: z.tenantId,
                subject: lastVia,
                relations: structuralExpandRels,
                objectType,
              }),
            );
          }
          if (reverseStructuralRels.length > 0) {
            expandPromises.push(
              ctx.runQuery(z.component.queries.listSubjectsWithAccessFast, {
                tenantId: z.tenantId,
                object: lastVia,
                relations: reverseStructuralRels,
                subjectType: objectType,
              }),
            );
          }
        } else {
          expandPromises.push(
            ctx.runQuery(z.component.queries.listAccessibleObjectsFast, {
              tenantId: z.tenantId,
              subject: lastVia,
              relations: acceptableRelations,
              objectType,
            }),
          );
        }

        const [gatePassed, chainPassed, expandResults] = await Promise.all([
          gatePromise,
          Promise.all(chainPromises),
          Promise.all(expandPromises),
        ]);

        if (!gatePassed) return [];
        for (const hit of chainPassed) {
          if (!hit) return [];
        }

        // Collect expand results — may come from multiple expand queries
        // (forward structural + reverse structural)
        const candidateIds = new Set<string>();
        let expandIdx = 0;

        if (hasStructural) {
          if (structuralExpandRels.length > 0) {
            // Forward: via is subject, objects are the candidates
            const fwdRows = expandResults[expandIdx] as any[];
            for (const eff of fwdRows) {
              candidateIds.add(eff.objectKey.split(":")[1]);
            }
            expandIdx++;
          }
          if (reverseStructuralRels.length > 0) {
            // Reverse: objects are subjects, via is the object
            const revRows = expandResults[expandIdx] as any[];
            for (const eff of revRows) {
              candidateIds.add(eff.subjectKey.split(":")[1]);
            }
            expandIdx++;
          }
        } else {
          const fallbackRows = expandResults[expandIdx] as any[];
          for (const eff of fallbackRows) {
            candidateIds.add(eff.objectKey.split(":")[1]);
          }
        }
        if (candidateIds.size === 0) return [];

        // Fast path: tight gate + no conditions → materialisation
        // guarantees subject→object, return IDs directly.
        if (!schemaHasConditions && isTightGate) {
          return this._finalize(
            [...candidateIds].map((id) => ({ objectId: id })),
          );
        }

        // Slow path: batch-verify + validate conditions
        const effectiveRels = await ctx.runQuery(
          z.component.queries.checkPermissionBatchObjects,
          {
            tenantId: z.tenantId,
            subject,
            relations: acceptableRelations,
            objectType,
            candidateObjectIds: [...candidateIds],
          },
        );

        const validated = await listWithValidation(
          z,
          ctx,
          effectiveRels,
          targets,
          (eff: any) => eff.objectKey.split(":")[1],
          () => subject,
          (_: any, id: string) => ({ type: objectType, id }),
          relOrPerm,
          requestContext,
        );

        // Candidates were already scoped by `.via()`; those the
        // materialised check missed get a read-time probe.
        await appendReadTimeHits(
          z,
          ctx,
          validated,
          candidateIds,
          acceptableRelations,
          (id: string) => ({
            subject,
            object: { type: objectType, id },
          }),
        );

        return this._finalize(
          validated.map((r: any) => ({ objectId: r.id })),
        );
      }

      // ── No via: standard full-scan path ───────────────────────────
      const effectiveRels = await ctx.runQuery(
        z.component.queries.listAccessibleObjectsFast,
        {
          tenantId: z.tenantId,
          subject,
          relations: acceptableRelations,
          objectType,
        },
      );

      const validated = await listWithValidation(
        z,
        ctx,
        effectiveRels,
        targets,
        (eff: any) => eff.objectKey.split(":")[1],
        () => subject,
        (_: any, id: string) => ({ type: objectType, id }),
        relOrPerm,
        requestContext,
      );

      // Union read-time path matches — these are not in the materialised
      // graph by design. Deduplicate against validated IDs.
      const readTimeIds = await listReadTimeObjects(
        z,
        ctx,
        subject,
        objectType,
        acceptableRelations,
      );
      if (readTimeIds.length > 0) {
        const seen = new Set(validated.map((r: any) => r.id));
        for (const id of readTimeIds) {
          if (!seen.has(id)) {
            seen.add(id);
            validated.push({ id });
          }
        }
      }

      return this._finalize(
        validated.map((r: any) => ({ objectId: r.id })),
      );
    } else {
      // listSubjects mode
      const object = { type: this._objectType, id: this._objectId! };
      const subjectType = this._subjectType!;

      if (hasVia) {
        // ── Chained gate-check + expand (subjects) ───────────────
        // Chain: subjects → via[0] → … → via[N-1] → object
        //
        // 1. Gate: via[N-1] → object using acceptable relations.
        // 2. Chain links: via[i] → via[i+1] connectivity checks.
        // 3. Expand: via[0] ← subjects (range scan for subject type).

        const viaChain = this._via;
        const firstVia = viaChain[0];
        const lastVia = viaChain[viaChain.length - 1];

        // Tight expand: only relations on firstVia's type that are
        // referenced by the object type's userset rewrites.
        const tightExpandRelations = getViaRelevantRelations(
          z,
          this._objectType,
          acceptableRelations,
          firstVia.type,
        );
        const expandRelations =
          tightExpandRelations.length > 0
            ? tightExpandRelations
            : getEntityRelations(z, firstVia.type);
        const isTightExpand = tightExpandRelations.length > 0;

        // Gate: via[N-1] → object.
        // Check connectivity between the via entity and the object.
        // Must check both directions:
        //   Forward: via is subject of a relation on objectType
        //   Reverse: objectType is subject of a relation on viaType
        // Structural gates are always materialised (they read schema-declared
        // typed relations); the fallback branch uses permission relations
        // and so gets RT fallback via `hasAccessOrRT`.
        const structuralGateRels = getStructuralRelations(
          z,
          this._objectType,
          lastVia.type,
        );
        const reverseGateRels = getReverseStructuralRelations(
          z,
          this._objectType,
          lastVia.type,
        );
        const hasStructuralGate =
          structuralGateRels.length > 0 || reverseGateRels.length > 0;

        const gatePromise: Promise<boolean> = (async () => {
          if (hasStructuralGate) {
            const gatePromises: Array<Promise<any[]>> = [];
            if (structuralGateRels.length > 0) {
              gatePromises.push(
                ctx.runQuery(z.component.queries.checkPermissionFast, {
                  tenantId: z.tenantId,
                  subject: lastVia,
                  relations: structuralGateRels,
                  object,
                }),
              );
            }
            if (reverseGateRels.length > 0) {
              gatePromises.push(
                ctx.runQuery(z.component.queries.checkPermissionFast, {
                  tenantId: z.tenantId,
                  subject: object,
                  relations: reverseGateRels,
                  object: lastVia,
                }),
              );
            }
            const gateResults = await Promise.all(gatePromises);
            return gateResults.some((rs) => rs.length > 0);
          }
          return hasAccessOrRT(z, ctx, lastVia, acceptableRelations, object);
        })();

        // Chain links: via[i] → via[i+1]. Permission-like — gets RT fallback.
        const chainPromises: Array<Promise<boolean>> = [];
        for (let i = 0; i < viaChain.length - 1; i++) {
          const next = viaChain[i + 1];
          chainPromises.push(
            hasAccessOrRT(
              z,
              ctx,
              viaChain[i],
              getEntityRelations(z, next.type),
              next,
            ),
          );
        }

        // Expand: via[0] ← subjects (using tight relations). Materialised.
        const expandPromise: Promise<any[]> = ctx.runQuery(
          z.component.queries.listSubjectsWithAccessFast,
          {
            tenantId: z.tenantId,
            object: firstVia,
            relations: expandRelations,
            subjectType,
          },
        );

        const [gatePassed, chainPassed, expandRows] = await Promise.all([
          gatePromise,
          Promise.all(chainPromises),
          expandPromise,
        ]);

        if (!gatePassed) return [];
        for (const hit of chainPassed) {
          if (!hit) return [];
        }

        const candidateIds = new Set<string>();
        for (const eff of expandRows) {
          candidateIds.add(eff.subjectKey.split(":")[1]);
        }
        if (candidateIds.size === 0) return [];

        // Fast path: tight expand + no conditions
        if (!schemaHasConditions && isTightExpand) {
          return this._finalize(
            [...candidateIds].map((id) => ({ subjectId: id })),
          );
        }

        // Slow path
        const effectiveRels = await ctx.runQuery(
          z.component.queries.checkPermissionBatchSubjects,
          {
            tenantId: z.tenantId,
            object,
            relations: acceptableRelations,
            subjectType,
            candidateSubjectIds: [...candidateIds],
          },
        );

        const validated = await listWithValidation(
          z,
          ctx,
          effectiveRels,
          targets,
          (eff: any) => eff.subjectKey.split(":")[1],
          (eff: any, id: string) => ({
            type: eff.subjectKey.split(":")[0],
            id,
          }),
          () => object,
          relOrPerm,
          requestContext,
        );

        await appendReadTimeHits(
          z,
          ctx,
          validated,
          candidateIds,
          acceptableRelations,
          (id: string) => ({
            subject: { type: subjectType, id },
            object,
          }),
        );

        return this._finalize(
          validated.map((r: any) => ({ subjectId: r.id })),
        );
      }

      // ── No via: standard full-scan path ───────────────────────────
      const effectiveRels = await ctx.runQuery(
        z.component.queries.listSubjectsWithAccessFast,
        {
          tenantId: z.tenantId,
          object,
          relations: acceptableRelations,
          subjectType,
        },
      );

      const validated = await listWithValidation(
        z,
        ctx,
        effectiveRels,
        targets,
        (eff: any) => eff.subjectKey.split(":")[1],
        (eff: any, id: string) => ({ type: eff.subjectKey.split(":")[0], id }),
        () => object,
        relOrPerm,
        requestContext,
      );

      const readTimeIds = await listReadTimeSubjects(
        z,
        ctx,
        object,
        subjectType,
        acceptableRelations,
      );
      if (readTimeIds.length > 0) {
        const seen = new Set(validated.map((r: any) => r.id));
        for (const id of readTimeIds) {
          if (!seen.has(id)) {
            seen.add(id);
            validated.push({ id });
          }
        }
      }

      return this._finalize(
        validated.map((r: any) => ({ subjectId: r.id })),
      );
    }
  }
}
