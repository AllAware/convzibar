import type { ActionCtx, QueryCtx, ZbarInternal } from "../internal";
import { resolveRelationInheritance } from "./resolvers";

/**
 * For listObjects mode: return object IDs reachable from `subject` through
 * any read-time dot-path whose derived relation is in
 * `acceptableRelations`. Skips the materialised graph entirely — callers
 * should union with materialised results and deduplicate.
 *
 * `depth` caps recursive chaining: when a read-time path's first hop
 * ("which sources does subject have targetRelation access to?") would
 * itself resolve through another read-time path, we recurse up to
 * `readTimeChainDepth` levels so list semantics match `can()` semantics.
 */
export async function listReadTimeObjects(
  z: ZbarInternal,
  ctx: QueryCtx | ActionCtx,
  subject: { type: string; id: string },
  objectType: string,
  acceptableRelations: string[],
  depth: number = 0,
): Promise<string[]> {
  const paths = z.graphConfig.readTimePaths;
  if (!paths || paths.length === 0) return [];
  const accepted = new Set(acceptableRelations);
  const relevant = paths.filter(
    (p) => p.objectType === objectType && accepted.has(p.derivedRelation),
  );
  if (relevant.length === 0) return [];

  const found = new Set<string>();
  const canChain = depth + 1 < z.readTimeChainDepth;

  await Promise.all(
    relevant.flatMap((path) =>
      path.sourceTypes.map(async (sourceType) => {
        const targetRelations = resolveRelationInheritance(
          z,
          sourceType,
          path.targetRelation,
        ).map((t) => t.relation);
        if (targetRelations.length === 0) return;

        const [matSources, chainedSourceIds] = await Promise.all([
          ctx.runQuery(z.component.queries.listAccessibleObjectsFast, {
            tenantId: z.tenantId,
            subject,
            relations: targetRelations,
            objectType: sourceType,
          }) as Promise<any[]>,
          canChain
            ? listReadTimeObjects(
                z,
                ctx,
                subject,
                sourceType,
                targetRelations,
                depth + 1,
              )
            : Promise.resolve([] as string[]),
        ]);

        const sourceIds = new Set<string>();
        for (const s of matSources) sourceIds.add(s.objectKey.split(":")[1]);
        for (const id of chainedSourceIds) sourceIds.add(id);
        if (sourceIds.size === 0) return;

        const objectLists = await Promise.all(
          [...sourceIds].map((sourceId) =>
            ctx.runQuery(z.component.queries.listAccessibleObjectsFast, {
              tenantId: z.tenantId,
              subject: { type: sourceType, id: sourceId },
              relations: [path.sourceRelation],
              objectType,
            }) as Promise<any[]>,
          ),
        );
        for (const objects of objectLists) {
          for (const obj of objects) {
            found.add(obj.objectKey.split(":")[1]);
          }
        }
      }),
    ),
  );

  return [...found];
}

/**
 * For listSubjects mode: return subject IDs (of `subjectType`) that reach
 * `object` through any read-time dot-path whose derived relation is in
 * `acceptableRelations`. Callers union with materialised results.
 *
 * `depth` caps recursive chaining: when step 2's materialised lookup on
 * a source doesn't cover a given subject, we recurse through further RT
 * paths on that source so list semantics match `can()` semantics.
 */
export async function listReadTimeSubjects(
  z: ZbarInternal,
  ctx: QueryCtx | ActionCtx,
  object: { type: string; id: string },
  subjectType: string,
  acceptableRelations: string[],
  depth: number = 0,
): Promise<string[]> {
  const paths = z.graphConfig.readTimePaths;
  if (!paths || paths.length === 0) return [];
  const accepted = new Set(acceptableRelations);
  const relevant = paths.filter(
    (p) => p.objectType === object.type && accepted.has(p.derivedRelation),
  );
  if (relevant.length === 0) return [];

  const found = new Set<string>();
  const canChain = depth + 1 < z.readTimeChainDepth;

  await Promise.all(
    relevant.flatMap((path) =>
      path.sourceTypes.map(async (sourceType) => {
        const targetRelations = resolveRelationInheritance(
          z,
          sourceType,
          path.targetRelation,
        ).map((t) => t.relation);
        if (targetRelations.length === 0) return;

        const sources: any[] = await ctx.runQuery(
          z.component.queries.listSubjectsWithAccessFast,
          {
            tenantId: z.tenantId,
            object,
            relations: [path.sourceRelation],
            subjectType: sourceType,
          },
        );
        if (sources.length === 0) return;

        await Promise.all(
          sources.map(async (eff: any) => {
            const sourceObj = {
              type: sourceType,
              id: eff.subjectKey.split(":")[1],
            };
            const [matSubjects, rtSubIds] = await Promise.all([
              ctx.runQuery(
                z.component.queries.listSubjectsWithAccessFast,
                {
                  tenantId: z.tenantId,
                  object: sourceObj,
                  relations: targetRelations,
                  subjectType,
                },
              ) as Promise<any[]>,
              canChain
                ? listReadTimeSubjects(
                    z,
                    ctx,
                    sourceObj,
                    subjectType,
                    targetRelations,
                    depth + 1,
                  )
                : Promise.resolve([] as string[]),
            ]);
            for (const sub of matSubjects) {
              found.add(sub.subjectKey.split(":")[1]);
            }
            for (const id of rtSubIds) found.add(id);
          }),
        );
      }),
    ),
  );

  return [...found];
}

/**
 * Append any `candidateIds` reachable through a read-time path (but not
 * already in `validated`) to `validated`. Shared between listObjects and
 * listSubjects `.via()` slow paths — callers differ only in how the
 * probe's subject/object are built from the candidate id.
 */
export async function appendReadTimeHits(
  z: ZbarInternal,
  ctx: QueryCtx | ActionCtx,
  validated: Array<{ id: string }>,
  candidateIds: Set<string>,
  acceptableRelations: string[],
  buildProbe: (id: string) => {
    subject: { type: string; id: string };
    object: { type: string; id: string };
  },
): Promise<void> {
  if (!z.graphConfig.readTimePaths) return;
  const matIds = new Set(validated.map((r) => r.id));
  const pending = [...candidateIds].filter((id) => !matIds.has(id));
  if (pending.length === 0) return;
  const rtHits = await Promise.all(
    pending.map((id) => {
      const { subject, object } = buildProbe(id);
      return evaluateReadTimePaths(
        z,
        ctx,
        subject,
        object,
        acceptableRelations,
      ).then((hit) => (hit ? id : null));
    }),
  );
  for (const id of rtHits) {
    if (id !== null) validated.push({ id });
  }
}

/**
 * Fast "subject has any of `acceptableRelations` on `object`" check that
 * falls back to read-time-path evaluation when the materialised graph
 * misses. Used by the `.via()` gate / chain / verify steps so those
 * walks compose with `.readTimeRelation()` declarations.
 */
export async function hasAccessOrRT(
  z: ZbarInternal,
  ctx: QueryCtx | ActionCtx,
  subject: { type: string; id: string },
  acceptableRelations: string[],
  object: { type: string; id: string },
): Promise<boolean> {
  const hits: any[] = await ctx.runQuery(
    z.component.queries.checkPermissionFast,
    {
      tenantId: z.tenantId,
      subject,
      relations: acceptableRelations,
      object,
    },
  );
  if (hits.length > 0) return true;
  return evaluateReadTimePaths(z, ctx, subject, object, acceptableRelations);
}

/**
 * Evaluate read-time dot-paths to determine whether `subject` reaches
 * `object` via any declared `.readTimeRelation()` whose derived relation
 * is in `acceptableRelations`.
 *
 * Walks the path as two indexed hops:
 *   1. Find sources S connected via (S, sourceRelation, object).
 *   2. For each S, check whether (subject, targetRelation*, S) exists,
 *      expanding `targetRelation` through local inheritance on S's type.
 *
 * When the step-2 materialised check misses and `depth` is below the
 * configured `readTimeChainDepth`, the evaluator recursively looks for
 * read-time paths on S — enabling RT-over-RT chains such as
 * `notification_rule.viewer` → `contact.viewer` → `system.viewer`.
 *
 * Short-circuits on the first hit. Returns false if no read-time paths
 * are declared, none apply to this object type / relation set, or no
 * path succeeds.
 */
export async function evaluateReadTimePaths(
  z: ZbarInternal,
  ctx: QueryCtx | ActionCtx,
  subject: { type: string; id: string },
  object: { type: string; id: string },
  acceptableRelations: string[],
  depth: number = 0,
): Promise<boolean> {
  const paths = z.graphConfig.readTimePaths;
  if (!paths || paths.length === 0) return false;

  const accepted = new Set(acceptableRelations);
  const relevant = paths.filter(
    (p) => p.objectType === object.type && accepted.has(p.derivedRelation),
  );
  if (relevant.length === 0) return false;

  // Each (path × sourceType) is an independent two-hop probe; fan out in
  // parallel. We don't short-circuit on first hit to avoid leaving
  // in-flight queries orphaned.
  const probes = relevant.flatMap((path) =>
    path.sourceTypes.map(async (sourceType) => {
      const targetRelations = resolveRelationInheritance(
        z,
        sourceType,
        path.targetRelation,
      ).map((t) => t.relation);
      if (targetRelations.length === 0) return false;

      const sourceRels: any[] = await ctx.runQuery(
        z.component.queries.listSubjectsWithAccessFast,
        {
          tenantId: z.tenantId,
          object,
          relations: [path.sourceRelation],
          subjectType: sourceType,
        },
      );
      if (sourceRels.length === 0) return false;

      const canChain = depth + 1 < z.readTimeChainDepth;
      const perSource = await Promise.all(
        sourceRels.map(async (eff: any) => {
          const sourceObj = {
            type: sourceType,
            id: eff.subjectKey.split(":")[1],
          };
          const hits: any[] = await ctx.runQuery(
            z.component.queries.checkPermissionFast,
            {
              tenantId: z.tenantId,
              subject,
              relations: targetRelations,
              object: sourceObj,
            },
          );
          if (hits.length > 0) return true;
          if (!canChain) return false;
          return evaluateReadTimePaths(
            z,
            ctx,
            subject,
            sourceObj,
            targetRelations,
            depth + 1,
          );
        }),
      );
      return perSource.some(Boolean);
    }),
  );

  const results = await Promise.all(probes);
  return results.some(Boolean);
}
