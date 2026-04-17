import type { ActionCtx, QueryCtx, ZbarInternal } from "../internal";
import { resolveRelationInheritance } from "./resolvers";
import { listWithValidation, validatePath } from "./validation";

// ============================================================================
// Traversal algebra
//
// A "traversal" is a computable path in the relationship graph we can ask
// both existence and enumeration questions about. The engine used to
// bifurcate into materialised-edge queries and read-time dot-path evaluation
// with no shared code; this module unifies them as instances of a single
// operator algebra.
//
// Operators:
//   • Materialised         — leaf over the effective graph, no conditions.
//   • ValidatedMaterialised — leaf that additionally runs condition /
//                              path validation (the permission-check shape).
//   • EdgeExpand           — primitive source-side enumeration for Compose.
//   • Union                — OR.
//   • Compose              — two-hop join through an intermediate.
//
// Contract:
//   • `check(s, o)`               — single-pair existence.
//   • `checkBatch(s, ot, cs)`     — fixed subject, many candidate objects.
//   • `checkBatchSubjects(o, st, cs)` — fixed object, many candidate subjects.
//   • `expandObjects(s, ot)`      — every object of `ot` reachable from `s`.
//   • `expandSubjects(o, st)`     — every subject of `st` reaching `o`.
//
// Compose collapses fan-outs at the primitive level: forward scans use
// `listAccessibleObjectsBatch`, reverse scans use `listSubjectsWithAccessBatch`.
// A single Convex round-trip replaces the per-intermediate fan-outs that used
// to live in the hand-rolled RT evaluators.
// ============================================================================

export interface Entity {
  type: string;
  id: string;
}

export interface Traversal {
  check(
    ctx: QueryCtx | ActionCtx,
    subject: Entity,
    object: Entity,
  ): Promise<boolean>;

  /** Of the given candidate object IDs, which does `subject` reach? */
  checkBatch(
    ctx: QueryCtx | ActionCtx,
    subject: Entity,
    objectType: string,
    candidateIds: readonly string[],
  ): Promise<Set<string>>;

  /** Reverse direction: of the candidate subject IDs, which reach `object`? */
  checkBatchSubjects(
    ctx: QueryCtx | ActionCtx,
    object: Entity,
    subjectType: string,
    candidateIds: readonly string[],
  ): Promise<Set<string>>;

  /** All `objectType` IDs reachable from `subject`. */
  expandObjects(
    ctx: QueryCtx | ActionCtx,
    subject: Entity,
    objectType: string,
  ): Promise<Set<string>>;

  /** All `subjectType` IDs reaching `object`. */
  expandSubjects(
    ctx: QueryCtx | ActionCtx,
    object: Entity,
    subjectType: string,
  ): Promise<Set<string>>;
}

// ---------------------------------------------------------------------------
// Materialised — leaf reading `effectiveRelationships`.
// ---------------------------------------------------------------------------

/**
 * Existence and enumeration against the materialised graph. `relations` is
 * a union — operations succeed if any of them apply.
 */
export class Materialised implements Traversal {
  constructor(
    private readonly z: ZbarInternal,
    public readonly relations: readonly string[],
  ) {}

  async check(
    ctx: QueryCtx | ActionCtx,
    subject: Entity,
    object: Entity,
  ): Promise<boolean> {
    if (this.relations.length === 0) return false;
    const hits: any[] = await ctx.runQuery(
      this.z.component.queries.checkPermissionFast,
      {
        tenantId: this.z.tenantId,
        subject,
        relations: [...this.relations],
        object,
      },
    );
    return hits.length > 0;
  }

  async checkBatch(
    ctx: QueryCtx | ActionCtx,
    subject: Entity,
    objectType: string,
    candidateIds: readonly string[],
  ): Promise<Set<string>> {
    if (this.relations.length === 0 || candidateIds.length === 0) {
      return new Set();
    }
    const rows: any[] = await ctx.runQuery(
      this.z.component.queries.checkPermissionBatchObjects,
      {
        tenantId: this.z.tenantId,
        subject,
        relations: [...this.relations],
        objectType,
        candidateObjectIds: [...candidateIds],
      },
    );
    const hits = new Set<string>();
    for (const r of rows) hits.add((r.objectKey as string).split(":")[1]);
    return hits;
  }

  async checkBatchSubjects(
    ctx: QueryCtx | ActionCtx,
    object: Entity,
    subjectType: string,
    candidateIds: readonly string[],
  ): Promise<Set<string>> {
    if (this.relations.length === 0 || candidateIds.length === 0) {
      return new Set();
    }
    const rows: any[] = await ctx.runQuery(
      this.z.component.queries.checkPermissionBatchSubjects,
      {
        tenantId: this.z.tenantId,
        object,
        relations: [...this.relations],
        subjectType,
        candidateSubjectIds: [...candidateIds],
      },
    );
    const hits = new Set<string>();
    for (const r of rows) hits.add((r.subjectKey as string).split(":")[1]);
    return hits;
  }

  async expandObjects(
    ctx: QueryCtx | ActionCtx,
    subject: Entity,
    objectType: string,
  ): Promise<Set<string>> {
    if (this.relations.length === 0) return new Set();
    const rows: any[] = await ctx.runQuery(
      this.z.component.queries.listAccessibleObjectsFast,
      {
        tenantId: this.z.tenantId,
        subject,
        relations: [...this.relations],
        objectType,
      },
    );
    const ids = new Set<string>();
    for (const r of rows) ids.add((r.objectKey as string).split(":")[1]);
    return ids;
  }

  async expandSubjects(
    ctx: QueryCtx | ActionCtx,
    object: Entity,
    subjectType: string,
  ): Promise<Set<string>> {
    if (this.relations.length === 0) return new Set();
    const rows: any[] = await ctx.runQuery(
      this.z.component.queries.listSubjectsWithAccessFast,
      {
        tenantId: this.z.tenantId,
        object,
        relations: [...this.relations],
        subjectType,
      },
    );
    const ids = new Set<string>();
    for (const r of rows) ids.add((r.subjectKey as string).split(":")[1]);
    return ids;
  }

  /**
   * Batched forward expansion: union of objects of `objectType` reachable
   * from any of `subjects`. One round-trip instead of N.
   */
  async expandObjectsFromMany(
    ctx: QueryCtx | ActionCtx,
    subjects: readonly Entity[],
    objectType: string,
  ): Promise<Set<string>> {
    if (this.relations.length === 0 || subjects.length === 0) return new Set();
    const rows: any[] = await ctx.runQuery(
      this.z.component.queries.listAccessibleObjectsBatch,
      {
        tenantId: this.z.tenantId,
        subjects: [...subjects],
        relations: [...this.relations],
        objectType,
      },
    );
    const ids = new Set<string>();
    for (const r of rows) ids.add((r.objectKey as string).split(":")[1]);
    return ids;
  }

  /**
   * Batched reverse expansion: union of subjects of `subjectType` reaching
   * any of `objects`. One round-trip instead of N.
   */
  async expandSubjectsFromMany(
    ctx: QueryCtx | ActionCtx,
    objects: readonly Entity[],
    subjectType: string,
  ): Promise<Set<string>> {
    if (this.relations.length === 0 || objects.length === 0) return new Set();
    const rows: any[] = await ctx.runQuery(
      this.z.component.queries.listSubjectsWithAccessBatch,
      {
        tenantId: this.z.tenantId,
        objects: [...objects],
        relations: [...this.relations],
        subjectType,
      },
    );
    const ids = new Set<string>();
    for (const r of rows) ids.add((r.subjectKey as string).split(":")[1]);
    return ids;
  }
}

// ---------------------------------------------------------------------------
// EdgeExpand — primitive source side of Compose.
// ---------------------------------------------------------------------------

/**
 * Source-side primitive for Compose. Wraps a typed relation lookup and
 * exposes three directions — per-object, per-subject (forward, for
 * expandObjects fan-out), and batched forward (for Compose.expandObjects).
 */
export class EdgeExpand {
  /** Underlying Materialised — shared backend for all four access methods. */
  private readonly mat: Materialised;

  constructor(
    private readonly z: ZbarInternal,
    public readonly subjectType: string,
    public readonly relations: readonly string[],
  ) {
    this.mat = new Materialised(z, relations);
  }

  async list(
    ctx: QueryCtx | ActionCtx,
    object: Entity,
  ): Promise<Entity[]> {
    const ids = await this.mat.expandSubjects(ctx, object, this.subjectType);
    return [...ids].map((id) => ({ type: this.subjectType, id }));
  }

  /** Forward fan-out across many intermediates — the step-B batch fix. */
  async listObjectsBatch(
    ctx: QueryCtx | ActionCtx,
    subjects: readonly Entity[],
    objectType: string,
  ): Promise<Set<string>> {
    return this.mat.expandObjectsFromMany(ctx, subjects, objectType);
  }
}

// ---------------------------------------------------------------------------
// Compose — two-hop join through an intermediate.
// ---------------------------------------------------------------------------

/**
 * Join at an intermediate of type `sourceSide.subjectType`.
 *
 *   subject --subjectSide--> M --sourceSide--> object
 *
 * `check`: enumerate M candidates via sourceSide, batch-check from subject
 * via subjectSide.
 *
 * `checkBatch` (and `checkBatchSubjects`): compute the full reachable set
 * once via `expand*`, then intersect with candidates — a single global
 * enumeration instead of per-candidate RT probes.
 *
 * `expandObjects`: fan out from subject to M via subjectSide, then use
 * `sourceSide.listObjectsBatch` (one Convex query) to collapse the forward
 * scan across all M at once.
 *
 * `expandSubjects`: fan out from object to M via sourceSide, then fan-in
 * via `subjectSide.expandSubjects` per M. The inner fan-in is parallel
 * (Promise.all). A deeper operator batching pass would squash this too;
 * step 2 takes the cheaper fixes.
 */
export class Compose implements Traversal {
  constructor(
    public readonly sourceSide: EdgeExpand,
    public readonly subjectSide: Traversal,
  ) {}

  async check(
    ctx: QueryCtx | ActionCtx,
    subject: Entity,
    object: Entity,
  ): Promise<boolean> {
    const intermediates = await this.sourceSide.list(ctx, object);
    if (intermediates.length === 0) return false;
    const midIds = intermediates.map((m) => m.id);
    const hits = await this.subjectSide.checkBatch(
      ctx,
      subject,
      this.sourceSide.subjectType,
      midIds,
    );
    return hits.size > 0;
  }

  async checkBatch(
    ctx: QueryCtx | ActionCtx,
    subject: Entity,
    objectType: string,
    candidateIds: readonly string[],
  ): Promise<Set<string>> {
    if (candidateIds.length === 0) return new Set();
    const reachable = await this.expandObjects(ctx, subject, objectType);
    const hits = new Set<string>();
    for (const id of candidateIds) if (reachable.has(id)) hits.add(id);
    return hits;
  }

  async checkBatchSubjects(
    ctx: QueryCtx | ActionCtx,
    object: Entity,
    subjectType: string,
    candidateIds: readonly string[],
  ): Promise<Set<string>> {
    if (candidateIds.length === 0) return new Set();
    const reachable = await this.expandSubjects(ctx, object, subjectType);
    const hits = new Set<string>();
    for (const id of candidateIds) if (reachable.has(id)) hits.add(id);
    return hits;
  }

  async expandObjects(
    ctx: QueryCtx | ActionCtx,
    subject: Entity,
    objectType: string,
  ): Promise<Set<string>> {
    const midIds = await this.subjectSide.expandObjects(
      ctx,
      subject,
      this.sourceSide.subjectType,
    );
    if (midIds.size === 0) return new Set();
    const midRefs: Entity[] = [...midIds].map((id) => ({
      type: this.sourceSide.subjectType,
      id,
    }));
    return this.sourceSide.listObjectsBatch(ctx, midRefs, objectType);
  }

  async expandSubjects(
    ctx: QueryCtx | ActionCtx,
    object: Entity,
    subjectType: string,
  ): Promise<Set<string>> {
    const mids = await this.sourceSide.list(ctx, object);
    if (mids.length === 0) return new Set();
    const perMid = await Promise.all(
      mids.map((m) => this.subjectSide.expandSubjects(ctx, m, subjectType)),
    );
    const out = new Set<string>();
    for (const s of perMid) for (const id of s) out.add(id);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Union — OR across children, with narrowing between tiers.
// ---------------------------------------------------------------------------

/**
 * Disjunction. `check` parallelises across children — we can't meaningfully
 * cancel Convex queries inside a transaction. `checkBatch` / `checkBatchSubjects`
 * narrow sequentially: the first child (conventionally the cheapest
 * Materialised leaf) sees the full candidate set; later children only see
 * what wasn't already covered. `expand*` union the children's full results.
 */
export class Union implements Traversal {
  constructor(public readonly children: readonly Traversal[]) {}

  async check(
    ctx: QueryCtx | ActionCtx,
    subject: Entity,
    object: Entity,
  ): Promise<boolean> {
    if (this.children.length === 0) return false;
    const results = await Promise.all(
      this.children.map((c) => c.check(ctx, subject, object)),
    );
    return results.some(Boolean);
  }

  async checkBatch(
    ctx: QueryCtx | ActionCtx,
    subject: Entity,
    objectType: string,
    candidateIds: readonly string[],
  ): Promise<Set<string>> {
    return this._narrow(candidateIds, (child, remaining) =>
      child.checkBatch(ctx, subject, objectType, remaining),
    );
  }

  async checkBatchSubjects(
    ctx: QueryCtx | ActionCtx,
    object: Entity,
    subjectType: string,
    candidateIds: readonly string[],
  ): Promise<Set<string>> {
    return this._narrow(candidateIds, (child, remaining) =>
      child.checkBatchSubjects(ctx, object, subjectType, remaining),
    );
  }

  async expandObjects(
    ctx: QueryCtx | ActionCtx,
    subject: Entity,
    objectType: string,
  ): Promise<Set<string>> {
    if (this.children.length === 0) return new Set();
    const perChild = await Promise.all(
      this.children.map((c) => c.expandObjects(ctx, subject, objectType)),
    );
    const out = new Set<string>();
    for (const s of perChild) for (const id of s) out.add(id);
    return out;
  }

  async expandSubjects(
    ctx: QueryCtx | ActionCtx,
    object: Entity,
    subjectType: string,
  ): Promise<Set<string>> {
    if (this.children.length === 0) return new Set();
    const perChild = await Promise.all(
      this.children.map((c) => c.expandSubjects(ctx, object, subjectType)),
    );
    const out = new Set<string>();
    for (const s of perChild) for (const id of s) out.add(id);
    return out;
  }

  /**
   * Narrowing loop shared by checkBatch / checkBatchSubjects. Each child
   * only sees candidates the earlier children didn't cover, so the tail
   * children (typically RT) probe a strictly smaller set.
   */
  private async _narrow(
    candidateIds: readonly string[],
    runChild: (
      child: Traversal,
      remaining: readonly string[],
    ) => Promise<Set<string>>,
  ): Promise<Set<string>> {
    if (this.children.length === 0 || candidateIds.length === 0) {
      return new Set();
    }
    const hits = new Set<string>();
    let remaining: readonly string[] = candidateIds;
    for (const child of this.children) {
      if (remaining.length === 0) break;
      const got = await runChild(child, remaining);
      if (got.size === 0) continue;
      for (const id of got) hits.add(id);
      remaining = remaining.filter((id) => !hits.has(id));
    }
    return hits;
  }
}

// ---------------------------------------------------------------------------
// EMPTY — constant-false singleton.
// ---------------------------------------------------------------------------

export const EMPTY: Traversal = {
  async check() {
    return false;
  },
  async checkBatch() {
    return new Set<string>();
  },
  async checkBatchSubjects() {
    return new Set<string>();
  },
  async expandObjects() {
    return new Set<string>();
  },
  async expandSubjects() {
    return new Set<string>();
  },
};

// ---------------------------------------------------------------------------
// ValidatedMaterialised — materialised leaf + condition / path validation.
// ---------------------------------------------------------------------------

/**
 * The permission-check shape of the materialised leaf: runs the same
 * `effectiveRelationships` query as `Materialised`, then feeds every
 * matching row through `validatePath` (condition chain + target condition).
 *
 * Takes `targets` (`Array<{relation, condition?}>`) rather than a bare
 * relation list because the condition name lives on the target entry, not
 * on the row. `permission` is the identifier exposed to condition functions
 * so they can branch on "what was asked" if they need to; `requestContext`
 * is the caller-supplied data bag threaded through the condition chain.
 *
 * This is the operator that makes the top-level `can` / `hasRelationship`
 * / `list` / `getPermissions` plan genuinely unified — the materialised
 * branch no longer has to live as hand-rolled code outside the algebra.
 */
export class ValidatedMaterialised<Data = unknown> implements Traversal {
  public readonly relations: string[];

  constructor(
    private readonly z: ZbarInternal,
    public readonly targets: ReadonlyArray<{
      relation: string;
      condition?: string;
    }>,
    private readonly permission: string,
    private readonly requestContext: Data | undefined,
  ) {
    this.relations = targets.map((t) => t.relation);
  }

  async check(
    ctx: QueryCtx | ActionCtx,
    subject: Entity,
    object: Entity,
  ): Promise<boolean> {
    if (this.relations.length === 0) return false;
    const rows: any[] = await ctx.runQuery(
      this.z.component.queries.checkPermissionFast,
      {
        tenantId: this.z.tenantId,
        subject,
        relations: this.relations,
        object,
      },
    );
    for (const eff of rows) {
      const targetDef = this._targetFor(eff.relation);
      for (const path of eff.paths) {
        if (
          await validatePath(
            this.z,
            path,
            targetDef,
            ctx,
            subject,
            object,
            this.permission,
            this.requestContext,
          )
        ) {
          return true;
        }
      }
    }
    return false;
  }

  async checkBatch(
    ctx: QueryCtx | ActionCtx,
    subject: Entity,
    objectType: string,
    candidateIds: readonly string[],
  ): Promise<Set<string>> {
    if (this.relations.length === 0 || candidateIds.length === 0) {
      return new Set();
    }
    const rows: any[] = await ctx.runQuery(
      this.z.component.queries.checkPermissionBatchObjects,
      {
        tenantId: this.z.tenantId,
        subject,
        relations: this.relations,
        objectType,
        candidateObjectIds: [...candidateIds],
      },
    );
    return this._validateRows(
      ctx,
      rows,
      (eff) => eff.objectKey.split(":")[1],
      () => subject,
      (_eff, id) => ({ type: objectType, id }),
    );
  }

  async checkBatchSubjects(
    ctx: QueryCtx | ActionCtx,
    object: Entity,
    subjectType: string,
    candidateIds: readonly string[],
  ): Promise<Set<string>> {
    if (this.relations.length === 0 || candidateIds.length === 0) {
      return new Set();
    }
    const rows: any[] = await ctx.runQuery(
      this.z.component.queries.checkPermissionBatchSubjects,
      {
        tenantId: this.z.tenantId,
        object,
        relations: this.relations,
        subjectType,
        candidateSubjectIds: [...candidateIds],
      },
    );
    return this._validateRows(
      ctx,
      rows,
      (eff) => eff.subjectKey.split(":")[1],
      (_eff, id) => ({ type: subjectType, id }),
      () => object,
    );
  }

  async expandObjects(
    ctx: QueryCtx | ActionCtx,
    subject: Entity,
    objectType: string,
  ): Promise<Set<string>> {
    if (this.relations.length === 0) return new Set();
    const rows: any[] = await ctx.runQuery(
      this.z.component.queries.listAccessibleObjectsFast,
      {
        tenantId: this.z.tenantId,
        subject,
        relations: this.relations,
        objectType,
      },
    );
    return this._validateRows(
      ctx,
      rows,
      (eff) => eff.objectKey.split(":")[1],
      () => subject,
      (_eff, id) => ({ type: objectType, id }),
    );
  }

  async expandSubjects(
    ctx: QueryCtx | ActionCtx,
    object: Entity,
    subjectType: string,
  ): Promise<Set<string>> {
    if (this.relations.length === 0) return new Set();
    const rows: any[] = await ctx.runQuery(
      this.z.component.queries.listSubjectsWithAccessFast,
      {
        tenantId: this.z.tenantId,
        object,
        relations: this.relations,
        subjectType,
      },
    );
    return this._validateRows(
      ctx,
      rows,
      (eff) => eff.subjectKey.split(":")[1],
      (_eff, id) => ({ type: subjectType, id }),
      () => object,
    );
  }

  private _targetFor(relation: string) {
    return this.targets.find((t) => t.relation === relation);
  }

  private async _validateRows(
    ctx: QueryCtx | ActionCtx,
    rows: any[],
    getId: (eff: any) => string,
    subjectResolver: (eff: any, id: string) => Entity,
    objectResolver: (eff: any, id: string) => Entity,
  ): Promise<Set<string>> {
    const validated = await listWithValidation(
      this.z,
      ctx,
      rows,
      [...this.targets],
      getId,
      subjectResolver,
      objectResolver,
      this.permission,
      this.requestContext,
    );
    return new Set(validated.map((v) => v.id));
  }
}

// ============================================================================
// Unified planner.
//
// One entry point (`planRelation`) that compiles every schema-declared path
// from a subject to `(relation, object)` into a Traversal tree. Each edge
// of that tree is one materialised-table query at runtime:
//
//   • A directly-declared or inherited relation → a single leaf (one query).
//   • A read-time dot-path `source.target`       → a two-leaf Compose (two
//                                                  queries).
//   • A chain of dot-paths                       → nested Composes (N+1
//                                                  queries for N dots).
//
// The planner does not distinguish "materialised" from "read-time"; both
// are just encodings of the same schema declaration, one eagerly flattened
// at write time and the other joined at read time. The compiled tree walks
// the schema the same way in either case.
//
// `rtBranches` is the internal helper that enumerates the Compose branches
// contributed by read-time declarations. It calls back into `planRelation`
// for each nested hop, so RT-over-RT chains unfold as tree depth rather
// than as recursive call depth in a hand-rolled evaluator.
// ============================================================================

/**
 * Build the read-time-path contribution for `(objectType, acceptable)` —
 * one `Compose(EdgeExpand, planRelation(...))` per declared dot-path.
 *
 * Recursion is bounded by `z.readTimeChainDepth`. When the cap is reached
 * the inner hop collapses to a bare `Materialised` (no further chaining);
 * otherwise it's a recursive `planRelation` call on the source type, which
 * itself may produce further Compose branches.
 *
 * Inner hops always recurse with an undefined permission — RT paths are
 * schema-structural and don't carry condition validation.
 */
function rtBranches(
  z: ZbarInternal,
  objectType: string,
  acceptable: ReadonlySet<string>,
  depth: number,
): Traversal[] {
  const paths = z.graphConfig.readTimePaths;
  if (!paths || paths.length === 0) return [];

  const canChain = depth + 1 < z.readTimeChainDepth;
  const branches: Traversal[] = [];

  for (const rt of paths) {
    if (rt.objectType !== objectType) continue;
    if (!acceptable.has(rt.derivedRelation)) continue;
    for (const sourceType of rt.sourceTypes) {
      const targetRelations = resolveRelationInheritance(
        z,
        sourceType,
        rt.targetRelation,
      ).map((t) => t.relation);
      if (targetRelations.length === 0) continue;

      const sourceSide = new EdgeExpand(z, sourceType, [rt.sourceRelation]);
      const subjectSide: Traversal = canChain
        ? planRelation(
            z,
            sourceType,
            targetRelations.map((r) => ({ relation: r })),
            undefined,
            undefined,
            depth + 1,
          )
        : new Materialised(z, targetRelations);
      branches.push(new Compose(sourceSide, subjectSide));
    }
  }
  return branches;
}

/**
 * Compile a Traversal tree for `(relation, objectType)` by walking the
 * schema from the object side.
 *
 * `targets` carries the inheritance- / userset-expanded relations (with
 * optional conditions) that the caller considers acceptable; conditions
 * only apply when `permission` is provided. Every schema-declared path
 * becomes a branch of the returned tree:
 *
 *     Union([
 *       direct,                     // one leaf — the inherited relations
 *       Compose(edge, plan(...)),   // one branch per read-time dot-path
 *       Compose(edge, plan(...)),   // ...
 *     ])
 *
 *   - `direct` is `ValidatedMaterialised` when `permission` is given (the
 *     condition-aware shape used by `can` / `hasRelationship` / `list` /
 *     `getPermissions`), or plain `Materialised` otherwise (the structural
 *     connectivity shape used by `.via()` gate/chain hops).
 *   - Each Compose is the 2-hop expansion of one read-time path; its
 *     subject side recursively plans the target relation on the source
 *     entity type, so chained RT paths unfold as nested Composes.
 *
 * The tree collapses to the single direct branch when the schema declares
 * no applicable RT paths. It collapses to `EMPTY` when `targets` is empty.
 *
 * ## Runtime cost
 *
 *     leaves visited by check(s, o)  =  number of schema edges on the
 *                                       chosen path from s to o
 *
 * Every leaf is one `effectiveRelationships` point/range query. A direct
 * lookup is one query; a single RT dot is two; a two-level RT chain is
 * three.
 */
export function planRelation<Data = unknown>(
  z: ZbarInternal,
  objectType: string,
  targets: ReadonlyArray<{ relation: string; condition?: string }>,
  permission?: string,
  requestContext?: Data,
  depth: number = 0,
): Traversal {
  if (targets.length === 0) return EMPTY;

  const relations = targets.map((t) => t.relation);
  const direct: Traversal = permission !== undefined
    ? new ValidatedMaterialised(z, targets, permission, requestContext)
    : new Materialised(z, relations);

  const rts = rtBranches(z, objectType, new Set(relations), depth);
  if (rts.length === 0) return direct;
  return new Union([direct, ...rts]);
}

// ============================================================================
// Multi-permission evaluator — `getPermissions`' theoretical minimum shape.
//
// `planRelation` gives each permission its own plan, which is clean but
// costs one materialised query per permission. A `getPermissions` call asks
// about many permissions at once on a shared (subject, object), so the
// minimum-work evaluator is:
//
//   1. ONE materialised query for the union of every target relation.
//   2. Per-permission CPU-side validation of the pre-fetched rows.
//   3. Per-permission RT fallback through `rtBranches` for whatever the
//      materialised branch didn't resolve — all in parallel.
// ============================================================================

/**
 * Evaluate multiple permissions on a shared `(subject, object)` in the
 * minimum number of queries. Returns the granted permissions in input
 * order.
 */
export async function evaluateManyPermissions<Data = unknown>(
  z: ZbarInternal,
  ctx: QueryCtx | ActionCtx,
  subject: Entity,
  object: Entity,
  perms: ReadonlyArray<{
    permission: string;
    targets: ReadonlyArray<{ relation: string; condition?: string }>;
  }>,
  requestContext?: Data,
): Promise<string[]> {
  if (perms.length === 0) return [];

  const allRelations = new Set<string>();
  for (const p of perms) for (const t of p.targets) allRelations.add(t.relation);
  if (allRelations.size === 0) return [];

  // Single materialised batch — one round-trip covers every permission.
  const rows: any[] = await ctx.runQuery(
    z.component.queries.checkPermissionFast,
    {
      tenantId: z.tenantId,
      subject,
      relations: [...allRelations],
      object,
    },
  );
  const rowsByRelation = new Map<string, any[]>();
  for (const r of rows) {
    const bucket = rowsByRelation.get(r.relation);
    if (bucket) bucket.push(r);
    else rowsByRelation.set(r.relation, [r]);
  }

  // Per-permission CPU-side validation, then RT fallback (parallel).
  const results = await Promise.all(
    perms.map(async ({ permission, targets }) => {
      if (targets.length === 0) return null;
      for (const target of targets) {
        const matched = rowsByRelation.get(target.relation);
        if (!matched) continue;
        for (const eff of matched) {
          for (const path of eff.paths) {
            if (
              await validatePath(
                z,
                path,
                target,
                ctx,
                subject,
                object,
                permission,
                requestContext,
              )
            ) {
              return permission;
            }
          }
        }
      }
      const rts = rtBranches(
        z,
        object.type,
        new Set(targets.map((t) => t.relation)),
        0,
      );
      if (rts.length === 0) return null;
      const rt: Traversal = rts.length === 1 ? rts[0] : new Union(rts);
      return (await rt.check(ctx, subject, object)) ? permission : null;
    }),
  );

  return results.filter((p): p is string => p !== null);
}
