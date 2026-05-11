import type { ActionCtx, QueryCtx, ZbarInternal } from "../internal";
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
     * from any of `subjects`. One round-trip instead of N. Falls through to
     * the cheaper singleton query when only one subject is supplied.
     */
    expandObjectsFromMany(ctx: QueryCtx | ActionCtx, subjects: readonly Entity[], objectType: string): Promise<Set<string>>;
    /**
     * Batched reverse expansion: union of subjects of `subjectType` reaching
     * any of `objects`. One round-trip instead of N. Falls through to the
     * cheaper singleton query when only one object is supplied.
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
export declare class ValidatedMaterialised<Data = unknown> implements Traversal {
    private readonly z;
    readonly targets: ReadonlyArray<{
        relation: string;
        condition?: string;
    }>;
    private readonly permission;
    private readonly requestContext;
    readonly cost = 1;
    readonly relations: string[];
    constructor(z: ZbarInternal, targets: ReadonlyArray<{
        relation: string;
        condition?: string;
    }>, permission: string, requestContext: Data | undefined);
    check(ctx: QueryCtx | ActionCtx, subject: Entity, object: Entity): Promise<boolean>;
    checkBatch(ctx: QueryCtx | ActionCtx, subject: Entity, objectType: string, candidateIds: readonly string[]): Promise<Set<string>>;
    checkBatchSubjects(ctx: QueryCtx | ActionCtx, object: Entity, subjectType: string, candidateIds: readonly string[]): Promise<Set<string>>;
    expandObjects(ctx: QueryCtx | ActionCtx, subject: Entity, objectType: string): Promise<Set<string>>;
    expandSubjects(ctx: QueryCtx | ActionCtx, object: Entity, subjectType: string): Promise<Set<string>>;
    expandObjectsFromMany(ctx: QueryCtx | ActionCtx, subjects: readonly Entity[], objectType: string): Promise<Set<string>>;
    expandSubjectsFromMany(ctx: QueryCtx | ActionCtx, objects: readonly Entity[], subjectType: string): Promise<Set<string>>;
    /**
     * Forward validation: row objects decode from `objectKey` with the fixed
     * `objectType`, row subjects supplied by `subjectForRow` (either a constant
     * or a per-row decoder for the batched-fan-out case).
     */
    private _validateForward;
    /** Mirror of `_validateForward` for the reverse direction. */
    private _validateReverse;
    private _validateRows;
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
export declare function planRelation<Data = unknown>(z: ZbarInternal, objectType: string, targets: ReadonlyArray<{
    relation: string;
    condition?: string;
}>, permission?: string, requestContext?: Data, depth?: number): Traversal;
/**
 * Evaluate multiple permissions on a shared `(subject, object)` in the
 * minimum number of queries. Returns the granted permissions in input
 * order.
 */
export declare function evaluateManyPermissions<Data = unknown>(z: ZbarInternal, ctx: QueryCtx | ActionCtx, subject: Entity, object: Entity, perms: ReadonlyArray<{
    permission: string;
    targets: ReadonlyArray<{
        relation: string;
        condition?: string;
    }>;
}>, requestContext?: Data): Promise<string[]>;
/**
 * Forward via: `subject → via[0] → … → via[last] → objects` where objects
 * are enumerated and narrowed to the subjects the permission plan actually
 * grants. Returns the final object-ID set.
 */
export declare function collectViaObjects<Data = unknown>(z: ZbarInternal, ctx: QueryCtx | ActionCtx, plan: Traversal, subject: Entity, via: readonly Entity[], objectType: string, acceptableRelations: readonly string[], schemaHasConditions: boolean, _requestContext?: Data): Promise<Set<string>>;
/**
 * Reverse via: `subjects → via[0] → … → via[last] → object`. Returns the
 * subject-ID set narrowed to what the permission plan grants on the pinned
 * `object`.
 */
export declare function collectViaSubjects<Data = unknown>(z: ZbarInternal, ctx: QueryCtx | ActionCtx, plan: Traversal, object: Entity, via: readonly Entity[], subjectType: string, acceptableRelations: readonly string[], schemaHasConditions: boolean, _requestContext?: Data): Promise<Set<string>>;
//# sourceMappingURL=traversal.d.ts.map