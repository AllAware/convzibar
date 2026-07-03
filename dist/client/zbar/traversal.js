import { buildScopeKey, idFromKey } from "../../shared/keys";
import { resolveRelationInheritance } from "./resolvers";
import { getEntityRelations, getReverseStructuralRelations, getStructuralRelations, getViaRelevantRelations, } from "./structural";
function fetchForward(z, ctx, subjects, relations, far) {
    return ctx.runQuery(z.component.queries.effectiveForward, {
        subjects: [...subjects],
        relations: [...relations],
        objectPoints: "points" in far ? [...far.points] : undefined,
        objectRange: "range" in far ? far.range : undefined,
    });
}
function fetchReverse(z, ctx, objects, relations, far) {
    return ctx.runQuery(z.component.queries.effectiveReverse, {
        objects: [...objects],
        relations: [...relations],
        subjectPoints: "points" in far ? [...far.points] : undefined,
        subjectRange: "range" in far ? far.range : undefined,
    });
}
function objectIds(rows) {
    const ids = new Set();
    for (const r of rows)
        ids.add(idFromKey(r.objectKey));
    return ids;
}
function subjectIds(rows) {
    const ids = new Set();
    for (const r of rows)
        ids.add(idFromKey(r.subjectKey));
    return ids;
}
// ---------------------------------------------------------------------------
// Materialised — leaf reading `effectiveRelationships`.
// ---------------------------------------------------------------------------
/**
 * Existence and enumeration against the materialised graph. `relations` is
 * a union — operations succeed if any of them apply.
 */
export class Materialised {
    z;
    relations;
    cost = 1;
    constructor(z, relations) {
        this.z = z;
        this.relations = relations;
    }
    async check(ctx, subject, object) {
        if (this.relations.length === 0)
            return false;
        const rows = await fetchForward(this.z, ctx, [subject], this.relations, {
            points: [buildScopeKey(object.type, object.id)],
        });
        return rows.length > 0;
    }
    async checkBatch(ctx, subject, objectType, candidateIds) {
        if (this.relations.length === 0 || candidateIds.length === 0)
            return new Set();
        return objectIds(await fetchForward(this.z, ctx, [subject], this.relations, {
            points: candidateIds.map((id) => buildScopeKey(objectType, id)),
        }));
    }
    async checkBatchSubjects(ctx, object, subjectType, candidateIds) {
        if (this.relations.length === 0 || candidateIds.length === 0)
            return new Set();
        return subjectIds(await fetchReverse(this.z, ctx, [object], this.relations, {
            points: candidateIds.map((id) => buildScopeKey(subjectType, id)),
        }));
    }
    async expandObjects(ctx, subject, objectType) {
        if (this.relations.length === 0)
            return new Set();
        return objectIds(await fetchForward(this.z, ctx, [subject], this.relations, { range: objectType }));
    }
    async expandSubjects(ctx, object, subjectType) {
        if (this.relations.length === 0)
            return new Set();
        return subjectIds(await fetchReverse(this.z, ctx, [object], this.relations, { range: subjectType }));
    }
    /**
     * Batched forward expansion: union of objects of `objectType` reachable
     * from any of `subjects`. One round-trip instead of N; falls through to the
     * cheaper singleton query when only one subject is supplied.
     */
    async expandObjectsFromMany(ctx, subjects, objectType) {
        if (this.relations.length === 0 || subjects.length === 0)
            return new Set();
        if (subjects.length === 1)
            return this.expandObjects(ctx, subjects[0], objectType);
        return objectIds(await fetchForward(this.z, ctx, subjects, this.relations, { range: objectType }));
    }
    /**
     * Batched reverse expansion: union of subjects of `subjectType` reaching any
     * of `objects`. One round-trip instead of N; falls through to the cheaper
     * singleton query when only one object is supplied.
     */
    async expandSubjectsFromMany(ctx, objects, subjectType) {
        if (this.relations.length === 0 || objects.length === 0)
            return new Set();
        if (objects.length === 1)
            return this.expandSubjects(ctx, objects[0], subjectType);
        return subjectIds(await fetchReverse(this.z, ctx, objects, this.relations, { range: subjectType }));
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
    z;
    subjectType;
    relations;
    /** Underlying Materialised — shared backend for all four access methods. */
    mat;
    constructor(z, subjectType, relations) {
        this.z = z;
        this.subjectType = subjectType;
        this.relations = relations;
        this.mat = new Materialised(z, relations);
    }
    async list(ctx, object) {
        const ids = await this.mat.expandSubjects(ctx, object, this.subjectType);
        return [...ids].map((id) => ({ type: this.subjectType, id }));
    }
    /**
     * Gather all intermediates reaching any of `objects`. One batched query
     * instead of one per object — keeps reverse fan-in collapsed when a
     * chained `Compose` walks the subject side backward. The singleton case
     * still uses the non-batch query so it reads the cheaper index path.
     */
    async listMany(ctx, objects) {
        if (objects.length === 0)
            return [];
        if (objects.length === 1)
            return this.list(ctx, objects[0]);
        const ids = await this.mat.expandSubjectsFromMany(ctx, objects, this.subjectType);
        return [...ids].map((id) => ({ type: this.subjectType, id }));
    }
    /** Forward fan-out across many intermediates. */
    async listObjectsBatch(ctx, subjects, objectType) {
        if (subjects.length === 0)
            return new Set();
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
export class Compose {
    sourceSide;
    subjectSide;
    cost;
    constructor(sourceSide, subjectSide) {
        this.sourceSide = sourceSide;
        this.subjectSide = subjectSide;
        this.cost = 1 + subjectSide.cost;
    }
    async check(ctx, subject, object) {
        const intermediates = await this.sourceSide.list(ctx, object);
        if (intermediates.length === 0)
            return false;
        const midIds = intermediates.map((m) => m.id);
        const hits = await this.subjectSide.checkBatch(ctx, subject, this.sourceSide.subjectType, midIds);
        return hits.size > 0;
    }
    async checkBatch(ctx, subject, objectType, candidateIds) {
        if (candidateIds.length === 0)
            return new Set();
        const reachable = await this.expandObjects(ctx, subject, objectType);
        const hits = new Set();
        for (const id of candidateIds)
            if (reachable.has(id))
                hits.add(id);
        return hits;
    }
    async checkBatchSubjects(ctx, object, subjectType, candidateIds) {
        if (candidateIds.length === 0)
            return new Set();
        const reachable = await this.expandSubjects(ctx, object, subjectType);
        const hits = new Set();
        for (const id of candidateIds)
            if (reachable.has(id))
                hits.add(id);
        return hits;
    }
    async expandObjects(ctx, subject, objectType) {
        return this.expandObjectsFromMany(ctx, [subject], objectType);
    }
    async expandSubjects(ctx, object, subjectType) {
        return this.expandSubjectsFromMany(ctx, [object], subjectType);
    }
    async expandObjectsFromMany(ctx, subjects, objectType) {
        if (subjects.length === 0)
            return new Set();
        const midIds = await this.subjectSide.expandObjectsFromMany(ctx, subjects, this.sourceSide.subjectType);
        if (midIds.size === 0)
            return new Set();
        const midRefs = [...midIds].map((id) => ({
            type: this.sourceSide.subjectType,
            id,
        }));
        return this.sourceSide.listObjectsBatch(ctx, midRefs, objectType);
    }
    async expandSubjectsFromMany(ctx, objects, subjectType) {
        if (objects.length === 0)
            return new Set();
        const mids = await this.sourceSide.listMany(ctx, objects);
        if (mids.length === 0)
            return new Set();
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
export class Union {
    children;
    cost;
    constructor(children) {
        this.children = children;
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
    static of(...children) {
        const flat = [];
        for (const c of children) {
            if (c === EMPTY)
                continue;
            if (c instanceof Union)
                flat.push(...c.children);
            else
                flat.push(c);
        }
        if (flat.length === 0)
            return EMPTY;
        if (flat.length === 1)
            return flat[0];
        flat.sort((a, b) => a.cost - b.cost);
        return new Union(flat);
    }
    async check(ctx, subject, object) {
        if (this.children.length === 0)
            return false;
        // Sequential probe of the cheapest child. `Union.of` sorts children
        // ascending by cost, so children[0] is usually the direct materialised
        // branch — a hit here skips every RT Compose, saving up to 2×(N−1)
        // queries on the happy path.
        if (await this.children[0].check(ctx, subject, object))
            return true;
        if (this.children.length === 1)
            return false;
        // Miss path: race the remaining children with first-true early exit.
        // Convex reads can't be cancelled, so all queries still fire — but we
        // unblock the caller as soon as any branch reports a hit.
        const rest = this.children.slice(1);
        return new Promise((resolve, reject) => {
            let remaining = rest.length;
            for (const c of rest) {
                c.check(ctx, subject, object).then((r) => {
                    if (r)
                        resolve(true);
                    else if (--remaining === 0)
                        resolve(false);
                }, reject);
            }
        });
    }
    async checkBatch(ctx, subject, objectType, candidateIds) {
        return this._narrow(candidateIds, (child, remaining) => child.checkBatch(ctx, subject, objectType, remaining));
    }
    async checkBatchSubjects(ctx, object, subjectType, candidateIds) {
        return this._narrow(candidateIds, (child, remaining) => child.checkBatchSubjects(ctx, object, subjectType, remaining));
    }
    async expandObjects(ctx, subject, objectType) {
        return this.expandObjectsFromMany(ctx, [subject], objectType);
    }
    async expandSubjects(ctx, object, subjectType) {
        return this.expandSubjectsFromMany(ctx, [object], subjectType);
    }
    async expandObjectsFromMany(ctx, subjects, objectType) {
        if (this.children.length === 0 || subjects.length === 0)
            return new Set();
        const perChild = await Promise.all(this.children.map((c) => c.expandObjectsFromMany(ctx, subjects, objectType)));
        const out = new Set();
        for (const s of perChild)
            for (const id of s)
                out.add(id);
        return out;
    }
    async expandSubjectsFromMany(ctx, objects, subjectType) {
        if (this.children.length === 0 || objects.length === 0)
            return new Set();
        const perChild = await Promise.all(this.children.map((c) => c.expandSubjectsFromMany(ctx, objects, subjectType)));
        const out = new Set();
        for (const s of perChild)
            for (const id of s)
                out.add(id);
        return out;
    }
    /**
     * Narrowing loop shared by checkBatch / checkBatchSubjects. Each child
     * only sees candidates the earlier children didn't cover, so the tail
     * children (typically RT) probe a strictly smaller set.
     */
    async _narrow(candidateIds, runChild) {
        if (this.children.length === 0 || candidateIds.length === 0) {
            return new Set();
        }
        const hits = new Set();
        let remaining = candidateIds;
        for (const child of this.children) {
            if (remaining.length === 0)
                break;
            const got = await runChild(child, remaining);
            if (got.size === 0)
                continue;
            for (const id of got)
                hits.add(id);
            remaining = remaining.filter((id) => !hits.has(id));
        }
        return hits;
    }
}
// ---------------------------------------------------------------------------
// EMPTY — constant-false singleton.
// ---------------------------------------------------------------------------
export const EMPTY = {
    cost: 0,
    async check() {
        return false;
    },
    async checkBatch() {
        return new Set();
    },
    async checkBatchSubjects() {
        return new Set();
    },
    async expandObjects() {
        return new Set();
    },
    async expandSubjects() {
        return new Set();
    },
    async expandObjectsFromMany() {
        return new Set();
    },
    async expandSubjectsFromMany() {
        return new Set();
    },
};
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
 * Read-time-path contributions for `(objectType, acceptable)`, grouped by the
 * derived relation each one grants. One `Compose(EdgeExpand, planRelation(...))`
 * per declared dot-path / userset. Recursion is bounded by
 * `z.readTimeChainDepth`; at the cap the inner hop collapses to a `Materialised`
 * leaf instead of recursing further.
 */
function rtComposeByDerived(z, objectType, acceptable, depth) {
    const paths = z.graphConfig.readTimePaths;
    if (!paths || paths.length === 0)
        return [];
    const canChain = depth + 1 < z.readTimeChainDepth;
    const out = [];
    for (const rt of paths) {
        if (rt.objectType !== objectType)
            continue;
        if (!acceptable.has(rt.derivedRelation))
            continue;
        for (const sourceType of rt.sourceTypes) {
            const innerTargets = resolveRelationInheritance(z, sourceType, rt.targetRelation);
            if (innerTargets.length === 0)
                continue;
            const sourceSide = new EdgeExpand(z, sourceType, [rt.sourceRelation]);
            const subjectSide = canChain
                ? planRelation(z, sourceType, innerTargets, depth + 1)
                : new Materialised(z, innerTargets);
            out.push({
                derivedRelation: rt.derivedRelation,
                branch: new Compose(sourceSide, subjectSide),
            });
        }
    }
    return out;
}
function rtBranches(z, objectType, acceptable, depth) {
    return rtComposeByDerived(z, objectType, acceptable, depth).map((x) => x.branch);
}
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
export function planRelation(z, objectType, targets, depth = 0) {
    if (targets.length === 0)
        return EMPTY;
    const direct = new Materialised(z, targets);
    const rts = rtBranches(z, objectType, new Set(targets), depth);
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
export async function evaluateManyPermissions(z, ctx, subject, object, perms) {
    if (perms.length === 0)
        return [];
    const allRelations = new Set();
    for (const p of perms)
        for (const t of p.targets)
            allRelations.add(t);
    if (allRelations.size === 0)
        return [];
    // ── 1. Single materialised batch — one round-trip covers every permission.
    const rows = await fetchForward(z, ctx, [subject], [...allRelations], {
        points: [buildScopeKey(object.type, object.id)],
    });
    const matchedRelations = new Set(rows.map((r) => r.relation));
    // ── 2. A permission is granted iff any of its target relations matched.
    const granted = new Set();
    const pendingTargets = new Set();
    const pending = [];
    for (const p of perms) {
        if (p.targets.length === 0)
            continue;
        if (p.targets.some((t) => matchedRelations.has(t))) {
            granted.add(p.permission);
        }
        else {
            pending.push(p);
            for (const t of p.targets)
                pendingTargets.add(t);
        }
    }
    // ── 3. Shared RT fallback: each (derivedRelation) branch-union runs at most
    // once. A derived relation that an RT branch grants satisfies every pending
    // permission whose targets include it.
    if (pending.length > 0) {
        const byDerived = new Map();
        for (const { derivedRelation, branch } of rtComposeByDerived(z, object.type, pendingTargets, 0)) {
            const arr = byDerived.get(derivedRelation) ?? [];
            arr.push(branch);
            byDerived.set(derivedRelation, arr);
        }
        const grantedRelations = new Set();
        await Promise.all([...byDerived].map(async ([rel, branches]) => {
            if (await Union.of(...branches).check(ctx, subject, object)) {
                grantedRelations.add(rel);
            }
        }));
        for (const p of pending) {
            if (p.targets.some((t) => grantedRelations.has(t)))
                granted.add(p.permission);
        }
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
//            the candidates. ALWAYS run. The gate/chain/expand steps only
//            establish *structural connectivity*, and they admit relations
//            that do not compose into the queried permission: the expand
//            step enumerates every typed relation between the via and the
//            object (e.g. a device merely `monitored_by` a system, not
//            owned by it), and interior chain links are checked with
//            *every* relation on the intermediate type. So a candidate
//            reachable from the final via is NOT necessarily reachable
//            from the subject *through the permission* — only the permission
//            plan's checkBatch can decide that, and it is a single batched
//            query, so there is no fast path worth the unsoundness.
//
// Both helpers run gate + chain + expand in parallel; the verify step
// is serialised on the candidate set. `planRelation` is reused for every
// connectivity check, so `.readTimeRelation()` declarations on the via
// entities compose through the chain exactly as they do outside it.
//
// The forward and reverse helpers are mirror images — what is a gate on one
// boundary is an expand on the other — so the genuinely shared pieces (the
// interior chain, the relation-set selection at each boundary) are factored
// into the three helpers below and the two directions stay as thin, readable
// wrappers rather than one branch-heavy function over security-critical code.
// ============================================================================
/** Connectivity of every interior `via[i] → via[i+1]` link (all relations). */
async function viaChainPasses(z, ctx, via) {
    const checks = [];
    for (let i = 0; i < via.length - 1; i++) {
        const next = via[i + 1];
        checks.push(planRelation(z, next.type, getEntityRelations(z, next.type)).check(ctx, via[i], next));
    }
    return (await Promise.all(checks)).every(Boolean);
}
/**
 * Relations to use at the subject-side via boundary: the tight set derived
 * from userset/dot-path rewrites that compose into the queried permission, or
 * — when none — every relation on the via type (loose).
 */
function viaBoundaryRelations(z, objectType, acceptableRelations, viaType) {
    const tight = getViaRelevantRelations(z, objectType, [...acceptableRelations], viaType);
    return tight.length > 0 ? tight : getEntityRelations(z, viaType);
}
/** Structural typed relations connecting `objectType` and `viaType`, both ways. */
function viaStructuralRelations(z, objectType, viaType) {
    const fwd = getStructuralRelations(z, objectType, viaType);
    const rev = getReverseStructuralRelations(z, objectType, viaType);
    return { fwd, rev, hasStructural: fwd.length > 0 || rev.length > 0 };
}
/**
 * Forward via: `subject → via[0] → … → via[last] → objects` where objects
 * are enumerated and narrowed to the subjects the permission plan actually
 * grants. Returns the final object-ID set.
 */
export async function collectViaObjects(z, ctx, plan, subject, via, objectType, acceptableRelations) {
    if (via.length === 0)
        return new Set();
    const firstVia = via[0];
    const lastVia = via[via.length - 1];
    // Gate: subject → firstVia (tight-or-loose relations on firstVia).
    const gatePromise = planRelation(z, firstVia.type, viaBoundaryRelations(z, objectType, acceptableRelations, firstVia.type)).check(ctx, subject, firstVia);
    const chainPromise = viaChainPasses(z, ctx, via);
    // Expand: lastVia → objects. Structural typed relations preferred (either
    // direction); acceptable relations as a last resort.
    const { fwd, rev, hasStructural } = viaStructuralRelations(z, objectType, lastVia.type);
    const expandPromises = [];
    if (hasStructural) {
        if (fwd.length > 0) {
            expandPromises.push(new Materialised(z, fwd).expandObjects(ctx, lastVia, objectType));
        }
        if (rev.length > 0) {
            expandPromises.push(new Materialised(z, rev).expandSubjects(ctx, lastVia, objectType));
        }
    }
    else {
        expandPromises.push(new Materialised(z, [...acceptableRelations]).expandObjects(ctx, lastVia, objectType));
    }
    const [gatePassed, chainPassed, expandSets] = await Promise.all([
        gatePromise,
        chainPromise,
        Promise.all(expandPromises),
    ]);
    if (!gatePassed || !chainPassed)
        return new Set();
    const candidateIds = new Set();
    for (const s of expandSets)
        for (const id of s)
            candidateIds.add(id);
    if (candidateIds.size === 0)
        return new Set();
    // Verify: structural connectivity (gate + chain + expand) is necessary but
    // NOT sufficient — the expand/chain steps admit relations that don't compose
    // into the queried permission, so a structurally-reachable candidate can
    // still be a non-grant. Bind the candidates to the subject through the
    // permission plan. checkBatch is a single batched query.
    return plan.checkBatch(ctx, subject, objectType, [...candidateIds]);
}
/**
 * Reverse via: `subjects → via[0] → … → via[last] → object`. Returns the
 * subject-ID set narrowed to what the permission plan grants on the pinned
 * `object`.
 */
export async function collectViaSubjects(z, ctx, plan, object, via, subjectType, acceptableRelations) {
    if (via.length === 0)
        return new Set();
    const firstVia = via[0];
    const lastVia = via[via.length - 1];
    const objectType = object.type;
    // Expand: firstVia ← subjects (tight-or-loose relations on firstVia).
    const expandPromise = new Materialised(z, viaBoundaryRelations(z, objectType, acceptableRelations, firstVia.type)).expandSubjects(ctx, firstVia, subjectType);
    // Gate: lastVia → object. Structural typed relations preferred (either
    // direction); fall back to the permission plan (composes with RT).
    const { fwd, rev, hasStructural } = viaStructuralRelations(z, objectType, lastVia.type);
    let gatePromise;
    if (hasStructural) {
        const checks = [];
        if (fwd.length > 0)
            checks.push(new Materialised(z, fwd).check(ctx, lastVia, object));
        if (rev.length > 0)
            checks.push(new Materialised(z, rev).check(ctx, object, lastVia));
        gatePromise = Promise.all(checks).then((rs) => rs.some(Boolean));
    }
    else {
        gatePromise = planRelation(z, objectType, [...acceptableRelations]).check(ctx, lastVia, object);
    }
    const chainPromise = viaChainPasses(z, ctx, via);
    const [gatePassed, chainPassed, candidateIds] = await Promise.all([
        gatePromise,
        chainPromise,
        expandPromise,
    ]);
    if (!gatePassed || !chainPassed)
        return new Set();
    if (candidateIds.size === 0)
        return new Set();
    // Verify: see collectViaObjects — structural reachability of a subject to the
    // object does not imply the subject holds the permission. Always bind
    // candidates through the permission plan.
    return plan.checkBatchSubjects(ctx, object, subjectType, [...candidateIds]);
}
//# sourceMappingURL=traversal.js.map