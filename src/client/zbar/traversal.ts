import type { ActionCtx, QueryCtx, ZbarInternal } from "../internal";
import { resolveRelationInheritance } from "./resolvers";
import {
  getEntityRelations,
  getReverseStructuralRelations,
  getStructuralRelations,
  getViaRelevantRelations,
} from "./structural";
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
  /**
   * Rough leaf count — one unit per `effectiveRelationships` query the
   * worst-case traversal would issue. Used by `Union.of` to order children
   * so narrowing probes the cheapest paths first.
   */
  readonly cost: number;

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

  /**
   * Batched forward expansion: union of `objectType` IDs reachable from any
   * of `subjects`. Lets chained `Compose` operators collapse the forward
   * fan-out to O(depth) queries instead of O(branching ^ depth).
   */
  expandObjectsFromMany(
    ctx: QueryCtx | ActionCtx,
    subjects: readonly Entity[],
    objectType: string,
  ): Promise<Set<string>>;

  /**
   * Batched reverse expansion: union of `subjectType` IDs reaching any of
   * `objects`. The mirror of `expandObjectsFromMany`; lets chained `Compose`
   * reverse walks stay linear in depth.
   */
  expandSubjectsFromMany(
    ctx: QueryCtx | ActionCtx,
    objects: readonly Entity[],
    subjectType: string,
  ): Promise<Set<string>>;
}

// ---------------------------------------------------------------------------
// Materialised query primitives.
//
// Seven one-liner helpers map `(shape, direction)` onto a Convex query. Both
// `Materialised` and `ValidatedMaterialised` dispatch through these — the
// only difference between the classes is what they do with the rows.
// ---------------------------------------------------------------------------

async function fetchCheckPoint(
  z: ZbarInternal,
  ctx: QueryCtx | ActionCtx,
  subject: Entity,
  relations: readonly string[],
  object: Entity,
): Promise<any[]> {
  return ctx.runQuery(z.component.queries.checkPermissionFast, {
    tenantId: z.tenantId,
    subject,
    relations: [...relations],
    object,
  });
}

async function fetchBatchObjects(
  z: ZbarInternal,
  ctx: QueryCtx | ActionCtx,
  subject: Entity,
  relations: readonly string[],
  objectType: string,
  candidateIds: readonly string[],
): Promise<any[]> {
  return ctx.runQuery(z.component.queries.checkPermissionBatchObjects, {
    tenantId: z.tenantId,
    subject,
    relations: [...relations],
    objectType,
    candidateObjectIds: [...candidateIds],
  });
}

async function fetchBatchSubjects(
  z: ZbarInternal,
  ctx: QueryCtx | ActionCtx,
  object: Entity,
  relations: readonly string[],
  subjectType: string,
  candidateIds: readonly string[],
): Promise<any[]> {
  return ctx.runQuery(z.component.queries.checkPermissionBatchSubjects, {
    tenantId: z.tenantId,
    object,
    relations: [...relations],
    subjectType,
    candidateSubjectIds: [...candidateIds],
  });
}

async function fetchExpandObjects(
  z: ZbarInternal,
  ctx: QueryCtx | ActionCtx,
  subject: Entity,
  relations: readonly string[],
  objectType: string,
): Promise<any[]> {
  return ctx.runQuery(z.component.queries.listAccessibleObjectsFast, {
    tenantId: z.tenantId,
    subject,
    relations: [...relations],
    objectType,
  });
}

async function fetchExpandSubjects(
  z: ZbarInternal,
  ctx: QueryCtx | ActionCtx,
  object: Entity,
  relations: readonly string[],
  subjectType: string,
): Promise<any[]> {
  return ctx.runQuery(z.component.queries.listSubjectsWithAccessFast, {
    tenantId: z.tenantId,
    object,
    relations: [...relations],
    subjectType,
  });
}

async function fetchExpandObjectsFromMany(
  z: ZbarInternal,
  ctx: QueryCtx | ActionCtx,
  subjects: readonly Entity[],
  relations: readonly string[],
  objectType: string,
): Promise<any[]> {
  return ctx.runQuery(z.component.queries.listAccessibleObjectsBatch, {
    tenantId: z.tenantId,
    subjects: [...subjects],
    relations: [...relations],
    objectType,
  });
}

async function fetchExpandSubjectsFromMany(
  z: ZbarInternal,
  ctx: QueryCtx | ActionCtx,
  objects: readonly Entity[],
  relations: readonly string[],
  subjectType: string,
): Promise<any[]> {
  return ctx.runQuery(z.component.queries.listSubjectsWithAccessBatch, {
    tenantId: z.tenantId,
    objects: [...objects],
    relations: [...relations],
    subjectType,
  });
}

function entityFromKey(scopeKey: string): Entity {
  const idx = scopeKey.indexOf(":");
  return { type: scopeKey.slice(0, idx), id: scopeKey.slice(idx + 1) };
}

function idFromKey(scopeKey: string): string {
  const idx = scopeKey.indexOf(":");
  return scopeKey.slice(idx + 1);
}

function objectIds(rows: readonly any[]): Set<string> {
  const ids = new Set<string>();
  for (const r of rows) ids.add(idFromKey(r.objectKey as string));
  return ids;
}

function subjectIds(rows: readonly any[]): Set<string> {
  const ids = new Set<string>();
  for (const r of rows) ids.add(idFromKey(r.subjectKey as string));
  return ids;
}

// ---------------------------------------------------------------------------
// Materialised — leaf reading `effectiveRelationships`.
// ---------------------------------------------------------------------------

/**
 * Existence and enumeration against the materialised graph. `relations` is
 * a union — operations succeed if any of them apply.
 */
export class Materialised implements Traversal {
  readonly cost = 1;

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
    const rows = await fetchCheckPoint(
      this.z,
      ctx,
      subject,
      this.relations,
      object,
    );
    return rows.length > 0;
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
    return objectIds(
      await fetchBatchObjects(
        this.z,
        ctx,
        subject,
        this.relations,
        objectType,
        candidateIds,
      ),
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
    return subjectIds(
      await fetchBatchSubjects(
        this.z,
        ctx,
        object,
        this.relations,
        subjectType,
        candidateIds,
      ),
    );
  }

  async expandObjects(
    ctx: QueryCtx | ActionCtx,
    subject: Entity,
    objectType: string,
  ): Promise<Set<string>> {
    if (this.relations.length === 0) return new Set();
    return objectIds(
      await fetchExpandObjects(
        this.z,
        ctx,
        subject,
        this.relations,
        objectType,
      ),
    );
  }

  async expandSubjects(
    ctx: QueryCtx | ActionCtx,
    object: Entity,
    subjectType: string,
  ): Promise<Set<string>> {
    if (this.relations.length === 0) return new Set();
    return subjectIds(
      await fetchExpandSubjects(
        this.z,
        ctx,
        object,
        this.relations,
        subjectType,
      ),
    );
  }

  /**
   * Batched forward expansion: union of objects of `objectType` reachable
   * from any of `subjects`. One round-trip instead of N. Falls through to
   * the cheaper singleton query when only one subject is supplied.
   */
  async expandObjectsFromMany(
    ctx: QueryCtx | ActionCtx,
    subjects: readonly Entity[],
    objectType: string,
  ): Promise<Set<string>> {
    if (this.relations.length === 0 || subjects.length === 0) return new Set();
    if (subjects.length === 1) {
      return this.expandObjects(ctx, subjects[0], objectType);
    }
    return objectIds(
      await fetchExpandObjectsFromMany(
        this.z,
        ctx,
        subjects,
        this.relations,
        objectType,
      ),
    );
  }

  /**
   * Batched reverse expansion: union of subjects of `subjectType` reaching
   * any of `objects`. One round-trip instead of N. Falls through to the
   * cheaper singleton query when only one object is supplied.
   */
  async expandSubjectsFromMany(
    ctx: QueryCtx | ActionCtx,
    objects: readonly Entity[],
    subjectType: string,
  ): Promise<Set<string>> {
    if (this.relations.length === 0 || objects.length === 0) return new Set();
    if (objects.length === 1) {
      return this.expandSubjects(ctx, objects[0], subjectType);
    }
    return subjectIds(
      await fetchExpandSubjectsFromMany(
        this.z,
        ctx,
        objects,
        this.relations,
        subjectType,
      ),
    );
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

  /**
   * Gather all intermediates reaching any of `objects`. One batched query
   * instead of one per object — keeps reverse fan-in collapsed when a
   * chained `Compose` walks the subject side backward. The singleton case
   * still uses the non-batch query so it reads the cheaper index path.
   */
  async listMany(
    ctx: QueryCtx | ActionCtx,
    objects: readonly Entity[],
  ): Promise<Entity[]> {
    if (objects.length === 0) return [];
    if (objects.length === 1) return this.list(ctx, objects[0]);
    const ids = await this.mat.expandSubjectsFromMany(
      ctx,
      objects,
      this.subjectType,
    );
    return [...ids].map((id) => ({ type: this.subjectType, id }));
  }

  /** Forward fan-out across many intermediates. */
  async listObjectsBatch(
    ctx: QueryCtx | ActionCtx,
    subjects: readonly Entity[],
    objectType: string,
  ): Promise<Set<string>> {
    if (subjects.length === 0) return new Set();
    if (subjects.length === 1) {
      return this.mat.expandObjects(ctx, subjects[0], objectType);
    }
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
  readonly cost: number;

  constructor(
    public readonly sourceSide: EdgeExpand,
    public readonly subjectSide: Traversal,
  ) {
    this.cost = 1 + subjectSide.cost;
  }

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
    return this.expandObjectsFromMany(ctx, [subject], objectType);
  }

  async expandSubjects(
    ctx: QueryCtx | ActionCtx,
    object: Entity,
    subjectType: string,
  ): Promise<Set<string>> {
    return this.expandSubjectsFromMany(ctx, [object], subjectType);
  }

  async expandObjectsFromMany(
    ctx: QueryCtx | ActionCtx,
    subjects: readonly Entity[],
    objectType: string,
  ): Promise<Set<string>> {
    if (subjects.length === 0) return new Set();
    const midIds = await this.subjectSide.expandObjectsFromMany(
      ctx,
      subjects,
      this.sourceSide.subjectType,
    );
    if (midIds.size === 0) return new Set();
    const midRefs: Entity[] = [...midIds].map((id) => ({
      type: this.sourceSide.subjectType,
      id,
    }));
    return this.sourceSide.listObjectsBatch(ctx, midRefs, objectType);
  }

  async expandSubjectsFromMany(
    ctx: QueryCtx | ActionCtx,
    objects: readonly Entity[],
    subjectType: string,
  ): Promise<Set<string>> {
    if (objects.length === 0) return new Set();
    const mids = await this.sourceSide.listMany(ctx, objects);
    if (mids.length === 0) return new Set();
    return this.subjectSide.expandSubjectsFromMany(ctx, mids, subjectType);
  }
}

// ---------------------------------------------------------------------------
// Union — OR across children, with narrowing between tiers.
// ---------------------------------------------------------------------------

/**
 * Disjunction.
 *
 * `check` is hybrid: it probes the cheapest child sequentially first, then —
 * only if that misses — races the remaining children in parallel with a
 * first-true early exit. Since `Union.of` cost-sorts its children, the first
 * probe is typically the direct materialised branch (cost 1) and the rest
 * are RT Composes (cost 2+). The common direct-hit path therefore fires
 * exactly one query; the miss path pays one extra round-trip vs pure
 * Promise.all but saves every RT query fired by the current
 * direct-hits-don't-short-circuit shape.
 *
 * `checkBatch` / `checkBatchSubjects` narrow sequentially: the first child
 * sees the full candidate set; later children only see what wasn't already
 * covered. `expand*` union every child's full results — they genuinely need
 * everything.
 */
export class Union implements Traversal {
  readonly cost: number;

  constructor(public readonly children: readonly Traversal[]) {
    this.cost =
      children.length === 0
        ? 0
        : children.reduce((m, c) => Math.min(m, c.cost), Infinity);
  }

  /**
   * Build a Union from an argument list, applying the algebraic identities
   * that keep plan trees tight:
   *
   *   • `EMPTY` children are dropped.
   *   • Nested `Union`s are flattened one level.
   *   • Zero children collapse to `EMPTY`.
   *   • One child collapses to that child (no `Union` wrapper).
   *   • Surviving children are sorted ascending by `cost`, so later
   *     `checkBatch` narrowing probes the cheapest paths first.
   */
  static of(...children: readonly Traversal[]): Traversal {
    const flat: Traversal[] = [];
    for (const c of children) {
      if (c === EMPTY) continue;
      if (c instanceof Union) flat.push(...c.children);
      else flat.push(c);
    }
    if (flat.length === 0) return EMPTY;
    if (flat.length === 1) return flat[0];
    flat.sort((a, b) => a.cost - b.cost);
    return new Union(flat);
  }

  async check(
    ctx: QueryCtx | ActionCtx,
    subject: Entity,
    object: Entity,
  ): Promise<boolean> {
    if (this.children.length === 0) return false;

    // Sequential probe of the cheapest child. `Union.of` sorts children
    // ascending by cost, so children[0] is usually the direct materialised
    // branch — a hit here skips every RT Compose, saving up to 2×(N−1)
    // queries on the happy path.
    if (await this.children[0].check(ctx, subject, object)) return true;
    if (this.children.length === 1) return false;

    // Miss path: race the remaining children with first-true early exit.
    // Convex reads can't be cancelled, so all queries still fire — but we
    // unblock the caller as soon as any branch reports a hit.
    const rest = this.children.slice(1);
    return new Promise<boolean>((resolve, reject) => {
      let remaining = rest.length;
      for (const c of rest) {
        c.check(ctx, subject, object).then(
          (r) => {
            if (r) resolve(true);
            else if (--remaining === 0) resolve(false);
          },
          reject,
        );
      }
    });
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
    return this.expandObjectsFromMany(ctx, [subject], objectType);
  }

  async expandSubjects(
    ctx: QueryCtx | ActionCtx,
    object: Entity,
    subjectType: string,
  ): Promise<Set<string>> {
    return this.expandSubjectsFromMany(ctx, [object], subjectType);
  }

  async expandObjectsFromMany(
    ctx: QueryCtx | ActionCtx,
    subjects: readonly Entity[],
    objectType: string,
  ): Promise<Set<string>> {
    if (this.children.length === 0 || subjects.length === 0) return new Set();
    const perChild = await Promise.all(
      this.children.map((c) =>
        c.expandObjectsFromMany(ctx, subjects, objectType),
      ),
    );
    const out = new Set<string>();
    for (const s of perChild) for (const id of s) out.add(id);
    return out;
  }

  async expandSubjectsFromMany(
    ctx: QueryCtx | ActionCtx,
    objects: readonly Entity[],
    subjectType: string,
  ): Promise<Set<string>> {
    if (this.children.length === 0 || objects.length === 0) return new Set();
    const perChild = await Promise.all(
      this.children.map((c) =>
        c.expandSubjectsFromMany(ctx, objects, subjectType),
      ),
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
  cost: 0,
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
  async expandObjectsFromMany() {
    return new Set<string>();
  },
  async expandSubjectsFromMany() {
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
  readonly cost = 1;
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
    const rows = await fetchCheckPoint(
      this.z,
      ctx,
      subject,
      this.relations,
      object,
    );
    for (const eff of rows) {
      const targetDef = this.targets.find((t) => t.relation === eff.relation);
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
    const rows = await fetchBatchObjects(
      this.z,
      ctx,
      subject,
      this.relations,
      objectType,
      candidateIds,
    );
    return this._validateRows(
      ctx,
      rows,
      (eff) => idFromKey(eff.objectKey),
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
    const rows = await fetchBatchSubjects(
      this.z,
      ctx,
      object,
      this.relations,
      subjectType,
      candidateIds,
    );
    return this._validateRows(
      ctx,
      rows,
      (eff) => idFromKey(eff.subjectKey),
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
    const rows = await fetchExpandObjects(
      this.z,
      ctx,
      subject,
      this.relations,
      objectType,
    );
    return this._validateRows(
      ctx,
      rows,
      (eff) => idFromKey(eff.objectKey),
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
    const rows = await fetchExpandSubjects(
      this.z,
      ctx,
      object,
      this.relations,
      subjectType,
    );
    return this._validateRows(
      ctx,
      rows,
      (eff) => idFromKey(eff.subjectKey),
      (_eff, id) => ({ type: subjectType, id }),
      () => object,
    );
  }

  async expandObjectsFromMany(
    ctx: QueryCtx | ActionCtx,
    subjects: readonly Entity[],
    objectType: string,
  ): Promise<Set<string>> {
    if (this.relations.length === 0 || subjects.length === 0) return new Set();
    const rows = await fetchExpandObjectsFromMany(
      this.z,
      ctx,
      subjects,
      this.relations,
      objectType,
    );
    // Rows from the batched query mix subjects; decode each row's own subject
    // key so condition validation sees the right pair.
    return this._validateRows(
      ctx,
      rows,
      (eff) => idFromKey(eff.objectKey),
      (eff) => entityFromKey(eff.subjectKey),
      (_eff, id) => ({ type: objectType, id }),
    );
  }

  async expandSubjectsFromMany(
    ctx: QueryCtx | ActionCtx,
    objects: readonly Entity[],
    subjectType: string,
  ): Promise<Set<string>> {
    if (this.relations.length === 0 || objects.length === 0) return new Set();
    const rows = await fetchExpandSubjectsFromMany(
      this.z,
      ctx,
      objects,
      this.relations,
      subjectType,
    );
    return this._validateRows(
      ctx,
      rows,
      (eff) => idFromKey(eff.subjectKey),
      (_eff, id) => ({ type: subjectType, id }),
      (eff) => entityFromKey(eff.objectKey),
    );
  }

  private async _validateRows(
    ctx: QueryCtx | ActionCtx,
    rows: readonly any[],
    getId: (eff: any) => string,
    subjectResolver: (eff: any, id: string) => Entity,
    objectResolver: (eff: any, id: string) => Entity,
  ): Promise<Set<string>> {
    const validated = await listWithValidation(
      this.z,
      ctx,
      [...rows],
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
 * the inner hop collapses to a leaf — `ValidatedMaterialised` if the caller
 * is doing a permission/relation check (so write-time-baked conditions and
 * any target-level conditions are evaluated), or plain `Materialised` for
 * structural connectivity (`.via()` gates).
 *
 * `permission` and `requestContext` propagate down the chain so every
 * inner hop runs the same condition-validation as the top-level direct
 * branch. Without this, conditions baked into intermediate relations'
 * `path.conditions` would be silently bypassed when the path is walked
 * via an RT chain — a permission that fails the direct evaluation could
 * be granted via the RT route.
 */
function rtBranches<Data = unknown>(
  z: ZbarInternal,
  objectType: string,
  acceptable: ReadonlySet<string>,
  depth: number,
  permission?: string,
  requestContext?: Data,
): Traversal[] {
  const paths = z.graphConfig.readTimePaths;
  if (!paths || paths.length === 0) return [];

  const canChain = depth + 1 < z.readTimeChainDepth;
  const branches: Traversal[] = [];

  for (const rt of paths) {
    if (rt.objectType !== objectType) continue;
    if (!acceptable.has(rt.derivedRelation)) continue;
    for (const sourceType of rt.sourceTypes) {
      // Preserve any inheritance-derived conditions on the inner targets —
      // ValidatedMaterialised reads target.condition via validatePath.
      const innerTargets = resolveRelationInheritance(
        z,
        sourceType,
        rt.targetRelation,
      );
      if (innerTargets.length === 0) continue;

      const sourceSide = new EdgeExpand(z, sourceType, [rt.sourceRelation]);
      const subjectSide: Traversal = canChain
        ? planRelation(
            z,
            sourceType,
            innerTargets,
            permission,
            requestContext,
            depth + 1,
          )
        : permission !== undefined
          ? new ValidatedMaterialised(
              z,
              innerTargets,
              permission,
              requestContext,
            )
          : new Materialised(
              z,
              innerTargets.map((t) => t.relation),
            );
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

  const rts = rtBranches(
    z,
    objectType,
    new Set(relations),
    depth,
    permission,
    requestContext,
  );
  return Union.of(direct, ...rts);
}

// ============================================================================
// Multi-permission evaluator — `getPermissions`' theoretical minimum shape.
//
// `planRelation` gives each permission its own plan, which is clean but
// costs one materialised query per permission. A `getPermissions` call asks
// about many permissions at once on a shared `(subject, object)`, so the
// minimum-work evaluator is:
//
//   1. ONE materialised batch covering the union of every target relation.
//   2. Per-permission CPU-side validation of the pre-fetched rows.
//   3. Shared RT fallback: each `(derivedRelation, sourceType)` branch runs
//      at most once. A branch that fires grants every still-pending
//      permission whose targets include its `derivedRelation`.
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

  // ── 1. Single materialised batch — one round-trip covers every permission.
  const rows = await fetchCheckPoint(
    z,
    ctx,
    subject,
    [...allRelations],
    object,
  );
  const rowsByRelation = new Map<string, any[]>();
  for (const r of rows) {
    const bucket = rowsByRelation.get(r.relation);
    if (bucket) bucket.push(r);
    else rowsByRelation.set(r.relation, [r]);
  }

  // ── 2. Per-permission CPU-side validation of pre-fetched rows.
  const granted = new Set<string>();
  const pending: typeof perms = [];
  const matValidations = await Promise.all(
    perms.map(async ({ permission, targets }) => {
      if (targets.length === 0) return { permission, targets, hit: false };
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
              return { permission, targets, hit: true };
            }
          }
        }
      }
      return { permission, targets, hit: false };
    }),
  );
  for (const r of matValidations) {
    if (r.hit) granted.add(r.permission);
    else if (r.targets.length > 0) (pending as any).push(r);
  }

  // ── 3. Per-pending-permission RT fallback. Each permission gets its own
  // RT plan so the inner condition evaluation sees the correct `action`
  // value — condition functions that branch on action would otherwise see
  // whichever permission "won" a shared branch. We trade the previous
  // cross-permission branch sharing for correctness.
  if (pending.length > 0) {
    const rtResults = await Promise.all(
      pending.map(async ({ permission, targets }) => {
        const branches = rtBranches(
          z,
          object.type,
          new Set(targets.map((t) => t.relation)),
          0,
          permission,
          requestContext,
        );
        if (branches.length === 0) return { permission, hit: false };
        const plan = Union.of(...branches);
        const hit = await plan.check(ctx, subject, object);
        return { permission, hit };
      }),
    );
    for (const r of rtResults) if (r.hit) granted.add(r.permission);
  }

  return perms.map((p) => p.permission).filter((p) => granted.has(p));
}

// ============================================================================
// Via-chain planners.
//
// `.via()` pins one or more intermediate entities between the query's
// subject and object. The runtime shape is always the same:
//
//   gate   — connectivity of the first boundary (subject → via[0] forward,
//            or via[last] → object reverse).
//   chain  — connectivity of each interior link (via[i] → via[i+1]).
//   expand — range scan at the other boundary producing candidate IDs.
//   verify — the permission-aware `plan.checkBatch(Subjects)` applied to
//            the candidates. Skipped when the gate relations are tight AND
//            the schema declares no conditions: write-time materialisation
//            guarantees transitivity of every pinned hop, so reaching the
//            candidate from the final via means reaching it from the
//            subject.
//
// Both helpers run gate + chain + expand in parallel; the verify step
// is serialised on the candidate set. `planRelation` is reused for every
// connectivity check, so `.readTimeRelation()` declarations on the via
// entities compose through the chain exactly as they do outside it.
// ============================================================================

/**
 * Forward via: `subject → via[0] → … → via[last] → objects` where objects
 * are enumerated and narrowed to the subjects the permission plan actually
 * grants. Returns the final object-ID set.
 */
export async function collectViaObjects<Data = unknown>(
  z: ZbarInternal,
  ctx: QueryCtx | ActionCtx,
  plan: Traversal,
  subject: Entity,
  via: readonly Entity[],
  objectType: string,
  acceptableRelations: readonly string[],
  schemaHasConditions: boolean,
  _requestContext?: Data,
): Promise<Set<string>> {
  if (via.length === 0) return new Set();
  const firstVia = via[0];
  const lastVia = via[via.length - 1];

  // Gate: subject → firstVia. Prefer tight relations derived from userset
  // rewrites on the object type; fall back to every relation on firstVia.
  const tightGateRelations = getViaRelevantRelations(
    z,
    objectType,
    [...acceptableRelations],
    firstVia.type,
  );
  const isTightGate = tightGateRelations.length > 0;
  const gateRelations = isTightGate
    ? tightGateRelations
    : getEntityRelations(z, firstVia.type);

  const gatePromise = planRelation(
    z,
    firstVia.type,
    gateRelations.map((r) => ({ relation: r })),
  ).check(ctx, subject, firstVia);

  // Chain: via[i] → via[i+1] using all relations on the target type. Uses
  // `planRelation` so read-time declarations on via entities compose.
  const chainPromises: Array<Promise<boolean>> = [];
  for (let i = 0; i < via.length - 1; i++) {
    const next = via[i + 1];
    chainPromises.push(
      planRelation(
        z,
        next.type,
        getEntityRelations(z, next.type).map((r) => ({ relation: r })),
      ).check(ctx, via[i], next),
    );
  }

  // Expand: lastVia → objects. Structural typed relations preferred (either
  // direction); acceptable relations as a last resort.
  const structuralFwdRels = getStructuralRelations(z, objectType, lastVia.type);
  const structuralRevRels = getReverseStructuralRelations(
    z,
    objectType,
    lastVia.type,
  );
  const hasStructural =
    structuralFwdRels.length > 0 || structuralRevRels.length > 0;

  const expandPromises: Array<Promise<Set<string>>> = [];
  if (hasStructural) {
    if (structuralFwdRels.length > 0) {
      expandPromises.push(
        new Materialised(z, structuralFwdRels).expandObjects(
          ctx,
          lastVia,
          objectType,
        ),
      );
    }
    if (structuralRevRels.length > 0) {
      expandPromises.push(
        new Materialised(z, structuralRevRels).expandSubjects(
          ctx,
          lastVia,
          objectType,
        ),
      );
    }
  } else {
    expandPromises.push(
      new Materialised(z, [...acceptableRelations]).expandObjects(
        ctx,
        lastVia,
        objectType,
      ),
    );
  }

  const [gatePassed, chainPassed, expandSets] = await Promise.all([
    gatePromise,
    Promise.all(chainPromises),
    Promise.all(expandPromises),
  ]);

  if (!gatePassed) return new Set();
  for (const c of chainPassed) if (!c) return new Set();

  const candidateIds = new Set<string>();
  for (const s of expandSets) for (const id of s) candidateIds.add(id);
  if (candidateIds.size === 0) return new Set();

  // Fast path: tight gate + no conditions → write-time transitivity
  // guarantees the candidates already satisfy subject→object.
  if (!schemaHasConditions && isTightGate) return candidateIds;

  return plan.checkBatch(ctx, subject, objectType, [...candidateIds]);
}

/**
 * Reverse via: `subjects → via[0] → … → via[last] → object`. Returns the
 * subject-ID set narrowed to what the permission plan grants on the pinned
 * `object`.
 */
export async function collectViaSubjects<Data = unknown>(
  z: ZbarInternal,
  ctx: QueryCtx | ActionCtx,
  plan: Traversal,
  object: Entity,
  via: readonly Entity[],
  subjectType: string,
  acceptableRelations: readonly string[],
  schemaHasConditions: boolean,
  _requestContext?: Data,
): Promise<Set<string>> {
  if (via.length === 0) return new Set();
  const firstVia = via[0];
  const lastVia = via[via.length - 1];
  const objectType = object.type;

  // Expand: firstVia ← subjects. Tight relations (userset-rewrite-derived
  // relations on firstVia.type) if any; otherwise every relation on the type.
  const tightExpandRelations = getViaRelevantRelations(
    z,
    objectType,
    [...acceptableRelations],
    firstVia.type,
  );
  const isTightExpand = tightExpandRelations.length > 0;
  const expandRelations = isTightExpand
    ? tightExpandRelations
    : getEntityRelations(z, firstVia.type);

  const expandPromise = new Materialised(z, expandRelations).expandSubjects(
    ctx,
    firstVia,
    subjectType,
  );

  // Gate: lastVia → object. Structural typed relations preferred; otherwise
  // fall back to the permission-derived acceptable relations (composes with
  // RT via `planRelation`).
  const structuralFwdRels = getStructuralRelations(z, objectType, lastVia.type);
  const structuralRevRels = getReverseStructuralRelations(
    z,
    objectType,
    lastVia.type,
  );
  const hasStructural =
    structuralFwdRels.length > 0 || structuralRevRels.length > 0;

  let gatePromise: Promise<boolean>;
  if (hasStructural) {
    const checks: Array<Promise<boolean>> = [];
    if (structuralFwdRels.length > 0) {
      checks.push(
        new Materialised(z, structuralFwdRels).check(ctx, lastVia, object),
      );
    }
    if (structuralRevRels.length > 0) {
      checks.push(
        new Materialised(z, structuralRevRels).check(ctx, object, lastVia),
      );
    }
    gatePromise = Promise.all(checks).then((rs) => rs.some(Boolean));
  } else {
    gatePromise = planRelation(
      z,
      objectType,
      acceptableRelations.map((r) => ({ relation: r })),
    ).check(ctx, lastVia, object);
  }

  // Chain: via[i] → via[i+1].
  const chainPromises: Array<Promise<boolean>> = [];
  for (let i = 0; i < via.length - 1; i++) {
    const next = via[i + 1];
    chainPromises.push(
      planRelation(
        z,
        next.type,
        getEntityRelations(z, next.type).map((r) => ({ relation: r })),
      ).check(ctx, via[i], next),
    );
  }

  const [gatePassed, chainPassed, candidateIds] = await Promise.all([
    gatePromise,
    Promise.all(chainPromises),
    expandPromise,
  ]);

  if (!gatePassed) return new Set();
  for (const c of chainPassed) if (!c) return new Set();
  if (candidateIds.size === 0) return new Set();

  if (!schemaHasConditions && isTightExpand) return candidateIds;

  return plan.checkBatchSubjects(ctx, object, subjectType, [...candidateIds]);
}
