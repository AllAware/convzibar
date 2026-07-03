import type { ActionCtx, QueryCtx, ZbarInternal } from "../internal";
export interface Entity {
    type: string;
    id: string;
}
export interface Traversal {
    /**
     * Minimum number of `effectiveRelationships` queries on the *cheapest*
     * path that can satisfy this traversal. A leaf is 1; a `Compose` is the
     * sum of its hops (both must run); a `Union` is the min of its children
     * (the cheapest branch can answer it). Used by `Union.of` to order
     * children ascending so narrowing / short-circuit probes the cheapest
     * branch first. (Consistently "cheapest path", not worst case — that's
     * why `Union` takes the min and `Compose` the sum.)
     */
    readonly cost: number;
    check(ctx: QueryCtx | ActionCtx, subject: Entity, object: Entity): Promise<boolean>;
    /** Of the given candidate object IDs, which does `subject` reach? */
    checkBatch(ctx: QueryCtx | ActionCtx, subject: Entity, objectType: string, candidateIds: readonly string[]): Promise<Set<string>>;
    /** Reverse direction: of the candidate subject IDs, which reach `object`? */
    checkBatchSubjects(ctx: QueryCtx | ActionCtx, object: Entity, subjectType: string, candidateIds: readonly string[]): Promise<Set<string>>;
    /** All `objectType` IDs reachable from `subject`. */
    expandObjects(ctx: QueryCtx | ActionCtx, subject: Entity, objectType: string): Promise<Set<string>>;
    /** All `subjectType` IDs reaching `object`. */
    expandSubjects(ctx: QueryCtx | ActionCtx, object: Entity, subjectType: string): Promise<Set<string>>;
    /**
     * Batched forward expansion: union of `objectType` IDs reachable from any
     * of `subjects`. Lets chained `Compose` operators collapse the forward
     * fan-out to O(depth) queries instead of O(branching ^ depth).
     */
    expandObjectsFromMany(ctx: QueryCtx | ActionCtx, subjects: readonly Entity[], objectType: string): Promise<Set<string>>;
    /**
     * Batched reverse expansion: union of `subjectType` IDs reaching any of
     * `objects`. The mirror of `expandObjectsFromMany`; lets chained `Compose`
     * reverse walks stay linear in depth.
     */
    expandSubjectsFromMany(ctx: QueryCtx | ActionCtx, objects: readonly Entity[], subjectType: string): Promise<Set<string>>;
}
/**
 * Existence and enumeration against the materialised graph. `relations` is
 * a union — operations succeed if any of them apply.
 */
export declare class Materialised implements Traversal {
    private readonly z;
    readonly relations: readonly string[];
    readonly cost = 1;
    constructor(z: ZbarInternal, relations: readonly string[]);
    check(ctx: QueryCtx | ActionCtx, subject: Entity, object: Entity): Promise<boolean>;
    checkBatch(ctx: QueryCtx | ActionCtx, subject: Entity, objectType: string, candidateIds: readonly string[]): Promise<Set<string>>;
    checkBatchSubjects(ctx: QueryCtx | ActionCtx, object: Entity, subjectType: string, candidateIds: readonly string[]): Promise<Set<string>>;
    expandObjects(ctx: QueryCtx | ActionCtx, subject: Entity, objectType: string): Promise<Set<string>>;
    expandSubjects(ctx: QueryCtx | ActionCtx, object: Entity, subjectType: string): Promise<Set<string>>;
    /**
     * Batched forward expansion: union of objects of `objectType` reachable
     * from any of `subjects`. One round-trip instead of N; falls through to the
     * cheaper singleton query when only one subject is supplied.
     */
    expandObjectsFromMany(ctx: QueryCtx | ActionCtx, subjects: readonly Entity[], objectType: string): Promise<Set<string>>;
    /**
     * Batched reverse expansion: union of subjects of `subjectType` reaching any
     * of `objects`. One round-trip instead of N; falls through to the cheaper
     * singleton query when only one object is supplied.
     */
    expandSubjectsFromMany(ctx: QueryCtx | ActionCtx, objects: readonly Entity[], subjectType: string): Promise<Set<string>>;
}
/**
 * Source-side primitive for Compose. Wraps a typed relation lookup and
 * exposes three directions — per-object, per-subject (forward, for
 * expandObjects fan-out), and batched forward (for Compose.expandObjects).
 */
export declare class EdgeExpand {
    private readonly z;
    readonly subjectType: string;
    readonly relations: readonly string[];
    /** Underlying Materialised — shared backend for all four access methods. */
    private readonly mat;
    constructor(z: ZbarInternal, subjectType: string, relations: readonly string[]);
    list(ctx: QueryCtx | ActionCtx, object: Entity): Promise<Entity[]>;
    /**
     * Gather all intermediates reaching any of `objects`. One batched query
     * instead of one per object — keeps reverse fan-in collapsed when a
     * chained `Compose` walks the subject side backward. The singleton case
     * still uses the non-batch query so it reads the cheaper index path.
     */
    listMany(ctx: QueryCtx | ActionCtx, objects: readonly Entity[]): Promise<Entity[]>;
    /** Forward fan-out across many intermediates. */
    listObjectsBatch(ctx: QueryCtx | ActionCtx, subjects: readonly Entity[], objectType: string): Promise<Set<string>>;
}
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
export declare class Compose implements Traversal {
    readonly sourceSide: EdgeExpand;
    readonly subjectSide: Traversal;
    readonly cost: number;
    constructor(sourceSide: EdgeExpand, subjectSide: Traversal);
    check(ctx: QueryCtx | ActionCtx, subject: Entity, object: Entity): Promise<boolean>;
    checkBatch(ctx: QueryCtx | ActionCtx, subject: Entity, objectType: string, candidateIds: readonly string[]): Promise<Set<string>>;
    checkBatchSubjects(ctx: QueryCtx | ActionCtx, object: Entity, subjectType: string, candidateIds: readonly string[]): Promise<Set<string>>;
    expandObjects(ctx: QueryCtx | ActionCtx, subject: Entity, objectType: string): Promise<Set<string>>;
    expandSubjects(ctx: QueryCtx | ActionCtx, object: Entity, subjectType: string): Promise<Set<string>>;
    expandObjectsFromMany(ctx: QueryCtx | ActionCtx, subjects: readonly Entity[], objectType: string): Promise<Set<string>>;
    expandSubjectsFromMany(ctx: QueryCtx | ActionCtx, objects: readonly Entity[], subjectType: string): Promise<Set<string>>;
}
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
export declare class Union implements Traversal {
    readonly children: readonly Traversal[];
    readonly cost: number;
    constructor(children: readonly Traversal[]);
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
    static of(...children: readonly Traversal[]): Traversal;
    check(ctx: QueryCtx | ActionCtx, subject: Entity, object: Entity): Promise<boolean>;
    checkBatch(ctx: QueryCtx | ActionCtx, subject: Entity, objectType: string, candidateIds: readonly string[]): Promise<Set<string>>;
    checkBatchSubjects(ctx: QueryCtx | ActionCtx, object: Entity, subjectType: string, candidateIds: readonly string[]): Promise<Set<string>>;
    expandObjects(ctx: QueryCtx | ActionCtx, subject: Entity, objectType: string): Promise<Set<string>>;
    expandSubjects(ctx: QueryCtx | ActionCtx, object: Entity, subjectType: string): Promise<Set<string>>;
    expandObjectsFromMany(ctx: QueryCtx | ActionCtx, subjects: readonly Entity[], objectType: string): Promise<Set<string>>;
    expandSubjectsFromMany(ctx: QueryCtx | ActionCtx, objects: readonly Entity[], subjectType: string): Promise<Set<string>>;
    /**
     * Narrowing loop shared by checkBatch / checkBatchSubjects. Each child
     * only sees candidates the earlier children didn't cover, so the tail
     * children (typically RT) probe a strictly smaller set.
     */
    private _narrow;
}
export declare const EMPTY: Traversal;
/**
 * Compile a Traversal tree for `(relation, objectType)`. `targets` is the
 * inheritance-/userset-expanded set of acceptable relation names. The tree is
 *
 *     Union([ Materialised(targets), ...Compose(edge, plan(...)) ])
 *
 * — a direct materialised lookup unioned with one Compose per applicable
 * read-time path. Collapses to the direct branch when no RT paths apply, and
 * to `EMPTY` when `targets` is empty. Each leaf is one effectiveRelationships
 * query: a direct lookup is one, a single RT dot is two, an N-level RT chain
 * is N+1.
 */
export declare function planRelation(z: ZbarInternal, objectType: string, targets: readonly string[], depth?: number): Traversal;
/**
 * Evaluate multiple permissions on a shared `(subject, object)` in the
 * minimum number of queries. Returns the granted permissions in input
 * order.
 */
export declare function evaluateManyPermissions(z: ZbarInternal, ctx: QueryCtx | ActionCtx, subject: Entity, object: Entity, perms: ReadonlyArray<{
    permission: string;
    targets: readonly string[];
}>): Promise<string[]>;
/**
 * Forward via: `subject → via[0] → … → via[last] → objects` where objects
 * are enumerated and narrowed to the subjects the permission plan actually
 * grants. Returns the final object-ID set.
 */
export declare function collectViaObjects(z: ZbarInternal, ctx: QueryCtx | ActionCtx, plan: Traversal, subject: Entity, via: readonly Entity[], objectType: string, acceptableRelations: readonly string[]): Promise<Set<string>>;
/**
 * Reverse via: `subjects → via[0] → … → via[last] → object`. Returns the
 * subject-ID set narrowed to what the permission plan grants on the pinned
 * `object`.
 */
export declare function collectViaSubjects(z: ZbarInternal, ctx: QueryCtx | ActionCtx, plan: Traversal, object: Entity, via: readonly Entity[], subjectType: string, acceptableRelations: readonly string[]): Promise<Set<string>>;
//# sourceMappingURL=traversal.d.ts.map