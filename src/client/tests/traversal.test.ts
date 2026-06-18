import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../../component/schema.js";
import { api } from "../../component/_generated/api.js";
import { getFunctionName } from "convex/server";
import { Zbar, createZbarSchema } from "../index.js";
import { register as registerWorkpool } from "@convex-dev/workpool/test";
import type { ZbarInternal } from "../internal.js";
import type { GraphConfig } from "../../component/types.js";
import {
  Compose,
  EdgeExpand,
  EMPTY,
  Materialised,
  Union,
  evaluateManyPermissions,
  planRelation,
} from "../zbar/traversal.js";

// ============================================================================
// Harness
// ============================================================================

const modules = import.meta.glob("../../component/**/*.ts");
const TENANT = "trv-tenant";

const setup = () => {
  const t = convexTest(schema, modules);
  registerWorkpool(t, "workpool");
  return t;
};

const mkCtx = (t: any) =>
  ({
    runQuery: t.query.bind(t),
    runMutation: t.mutation.bind(t),
  }) as any;

// Slim schema with two RT declarations — same shape as the IoT one but
// trimmed to only what these tests exercise. Using a local schema keeps
// these tests isolated from iot-schema.test.ts changes.
const trvSchema = createZbarSchema()
  .entity("user", (e) => e.relation("primary_contact"))
  .entity("system", (e) =>
    e
      .relation("owner", "user")
      .relation("admin", "user", "owner")
      .relation("viewer", "user", "admin")
      .relation("user_member", "viewer")
      .relation("contact_member")
      .permission("view", "viewer"),
  )
  .entity("contact", (e) =>
    e
      .relation("owner", { type: "system", reverse: "contact_member" })
      .relation("admin")
      .readTimeRelation("admin", "owner.admin")
      .relation("viewer", "admin")
      .readTimeRelation("viewer", "owner.viewer")
      .permission("view", "viewer"),
  )
  .extend("user", (e) => e.relation("primary_contact", "contact"))
  .extend("system", (e) => e.relation("contact_member", "user_member.primary_contact"))
  .build();

const mkZbar = (opts?: { readTimeChainDepth?: number }) =>
  new Zbar(api, {
    schema: trvSchema,
    asyncWrites: false,
    readTimeChainDepth: opts?.readTimeChainDepth,
  });

async function effectiveRowExists(
  t: any,
  subject: { type: string; id: string },
  relation: string,
  object: { type: string; id: string },
): Promise<boolean> {
  const rows = await t.run(
    async (inner: any) =>
      await inner.db.query("effectiveRelationships").collect(),
  );
  return rows.some(
    (r: any) =>
      r.subjectKey === `${subject.type}:${subject.id}` &&
      r.relation === relation &&
      r.objectKey === `${object.type}:${object.id}`,
  );
}

// ============================================================================
// planRelation — tree-shape assertions, no DB.
//
// The plan shape is part of the public contract: later executor-side
// optimisations are allowed to change *how* a plan runs, but the planner
// must produce the same topology for the same schema, so these tests lock
// the tree rather than just the behaviour.
// ============================================================================

function fakeInternal(overrides: Partial<ZbarInternal> = {}): ZbarInternal {
  const graphConfig: GraphConfig = {
    traversalRules: [],
    readTimePaths: [
      {
        objectType: "contact",
        derivedRelation: "viewer",
        sourceRelation: "owner",
        targetRelation: "viewer",
        sourceTypes: ["system"],
      },
    ],
    ...(overrides.graphConfig ?? {}),
  } as GraphConfig;

  return {
    component: {} as any,
    schema: {
      entities: {
        system: { relations: { viewer: [] } },
        contact: { relations: { viewer: [] } },
      },
    } as any,
    asyncWrites: false,
    graphConfig,
    configHash: "test-config-hash",
    readTimeChainDepth: 3,
    permissionRelationsCache: new Map(),
    ...overrides,
  };
}

// Convenience for the shape tests: `planRelation` takes a plain `string[]`
// of accepted relation names — the direct leaf is always a plain
// `Materialised`, matching the tree every other caller would also observe
// for an access-style query on the same schema.
const planR = (
  z: ZbarInternal,
  objectType: string,
  relations: string[],
  opts?: { depth?: number },
) => planRelation(z, objectType, relations, opts?.depth ?? 0);

describe("planRelation (plan tree)", () => {
  test("returns EMPTY when targets is empty", () => {
    const z = fakeInternal();
    expect(planR(z, "contact", [])).toBe(EMPTY);
  });

  test("with no RT paths applicable → bare direct branch (one Materialised leaf)", () => {
    // Either no RT paths declared at all, or none whose derivedRelation
    // matches the accepted set — both collapse to just the direct branch.
    const zEmpty = fakeInternal({
      graphConfig: { traversalRules: [], readTimePaths: [] } as GraphConfig,
    });
    expect(planR(zEmpty, "contact", ["viewer"])).toBeInstanceOf(Materialised);

    const z = fakeInternal();
    expect(planR(z, "contact", ["admin"])).toBeInstanceOf(Materialised);
    expect(planR(z, "system", ["viewer"])).toBeInstanceOf(Materialised);
  });

  test("with an RT path applicable → Union(direct, Compose(edge, recurse))", () => {
    const z = fakeInternal({ readTimeChainDepth: 3 });
    const plan = planR(z, "contact", ["viewer"]) as Union;
    expect(plan).toBeInstanceOf(Union);

    // Direct branch: one materialised leaf over the accepted relations.
    expect(plan.children[0]).toBeInstanceOf(Materialised);

    // RT branch: Compose(EdgeExpand(system, [owner]), recursion).
    const compose = plan.children[1] as Compose;
    expect(compose).toBeInstanceOf(Compose);
    expect(compose.sourceSide).toBeInstanceOf(EdgeExpand);
    expect(compose.sourceSide.subjectType).toBe("system");

    // The fake schema declares no RT paths on `system`, so the recursion
    // on the subject side collapses to a bare Materialised — no Union.
    expect(compose.subjectSide).toBeInstanceOf(Materialised);
  });

  test("chaining disabled (chainDepth = 0) → the RT branch's subject side is still a bare Materialised", () => {
    // Depth cap gates *recursion* into nested RT, not the base RT hop. A
    // single RT path is always expressible as one Compose — its subject
    // side just doesn't get a nested union of deeper RT when capped.
    const z = fakeInternal({ readTimeChainDepth: 0 });
    const plan = planR(z, "contact", ["viewer"]) as Union;
    expect(plan).toBeInstanceOf(Union);
    const compose = plan.children[1] as Compose;
    expect(compose.subjectSide).toBeInstanceOf(Materialised);
  });

  test("with a deeper RT chain: recursion on the RT subject side becomes a nested Union", () => {
    // Declare an RT path on `system` (the mid-type of the contact RT) so
    // the recursion produces its own Union(direct, Compose).
    const z = fakeInternal({
      graphConfig: {
        traversalRules: [],
        readTimePaths: [
          {
            objectType: "contact",
            derivedRelation: "viewer",
            sourceRelation: "owner",
            targetRelation: "viewer",
            sourceTypes: ["system"],
          },
          {
            objectType: "system",
            derivedRelation: "viewer",
            sourceRelation: "parent",
            targetRelation: "viewer",
            sourceTypes: ["org"],
          },
        ],
      } as GraphConfig,
    });
    // Make sure the fake schema can resolve `org.viewer` inheritance.
    (z.schema as any).entities.org = { relations: { viewer: [] } };

    const plan = planR(z, "contact", ["viewer"]) as Union;
    const contactCompose = plan.children[1] as Compose;
    expect(contactCompose).toBeInstanceOf(Compose);

    // The subject side recurses into planRelation on system, which now
    // produces its own Union(direct, Compose(EdgeExpand(org, [parent]), …)).
    const systemPlan = contactCompose.subjectSide as Union;
    expect(systemPlan).toBeInstanceOf(Union);
    expect(systemPlan.children[0]).toBeInstanceOf(Materialised);
    const systemCompose = systemPlan.children[1] as Compose;
    expect(systemCompose).toBeInstanceOf(Compose);
    expect(systemCompose.sourceSide.subjectType).toBe("org");
    expect(systemCompose.subjectSide).toBeInstanceOf(Materialised);
  });
});

// ============================================================================
// Operator semantics — each operator pinned against a real Zbar context.
//
// We don't want later executor optimisations to silently change what a given
// operator means. These tests exercise each operator directly (bypassing the
// planner) and assert the primitive behaviour.
// ============================================================================

describe("operator semantics", () => {
  test("Materialised.check matches iff an effective edge exists", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    await zbar.addRelation(ctx, alice, "viewer", sys);

    const z = (zbar as any)._internal as ZbarInternal;
    const mat = new Materialised(z, ["viewer"]);
    expect(await mat.check(ctx, alice, sys)).toBe(true);
    expect(await mat.check(ctx, bob, sys)).toBe(false);
  });

  test("Materialised.checkBatch returns the subset reached in a single query", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const s1 = { type: "system" as const, id: "sys1" };
    const s2 = { type: "system" as const, id: "sys2" };
    const s3 = { type: "system" as const, id: "sys3" };
    const alice = { type: "user" as const, id: "alice" };
    await zbar.addRelation(ctx, alice, "viewer", s1);
    await zbar.addRelation(ctx, alice, "viewer", s3);

    const z = (zbar as any)._internal as ZbarInternal;
    const mat = new Materialised(z, ["viewer"]);
    const hits = await mat.checkBatch(ctx, alice, "system", [
      s1.id,
      s2.id,
      s3.id,
    ]);
    expect([...hits].sort()).toEqual(["sys1", "sys3"]);
  });

  test("Materialised.checkBatch short-circuits on empty inputs without querying", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const z = (zbar as any)._internal as ZbarInternal;

    const alice = { type: "user" as const, id: "alice" };
    const mat = new Materialised(z, ["viewer"]);
    expect([...(await mat.checkBatch(ctx, alice, "system", []))]).toEqual([]);
    const empty = new Materialised(z, []);
    expect([...(await empty.checkBatch(ctx, alice, "system", ["sys1"]))]).toEqual(
      [],
    );
  });

  test("EdgeExpand.list enumerates subjects of the requested type, scoped to relation", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const carol = { type: "user" as const, id: "carol" };
    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, carol, "viewer", sys);

    const z = (zbar as any)._internal as ZbarInternal;
    const edge = new EdgeExpand(z, "user", ["viewer"]);
    const subs = await edge.list(ctx, sys);
    expect(subs.map((s) => s.id).sort()).toEqual(["alice", "bob", "carol"]);
    for (const s of subs) expect(s.type).toBe("user");
  });

  test("Compose.check joins a source-side enumeration with a subject-side check", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };

    // Seed: alice is sys.viewer; bob's primary_contact enrols bobContact as
    // a contact_member of sys, populating contact.owner via reverse edge.
    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);

    // Exactly the shape the planner emits for contact.viewer RT.
    const z = (zbar as any)._internal as ZbarInternal;
    const sourceSide = new EdgeExpand(z, "system", ["owner"]);
    const subjectSide = new Materialised(z, ["viewer"]);
    const plan = new Compose(sourceSide, subjectSide);

    expect(await plan.check(ctx, alice, bobContact)).toBe(true);
    const outsider = { type: "user" as const, id: "outsider" };
    expect(await plan.check(ctx, outsider, bobContact)).toBe(false);
  });

  test("Union.check ORs its children", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    await zbar.addRelation(ctx, alice, "viewer", sys);

    const z = (zbar as any)._internal as ZbarInternal;
    const match = new Materialised(z, ["viewer"]);
    const miss = new Materialised(z, ["admin"]);
    expect(await new Union([match, miss]).check(ctx, alice, sys)).toBe(true);
    expect(await new Union([miss, miss]).check(ctx, alice, sys)).toBe(false);
    expect(await new Union([]).check(ctx, alice, sys)).toBe(false);
  });

  test("Union.checkBatch narrows: later children only see earlier misses", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const z = (zbar as any)._internal as ZbarInternal;

    const alice = { type: "user" as const, id: "alice" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const sys2 = { type: "system" as const, id: "sys2" };
    await zbar.addRelation(ctx, alice, "viewer", sys1);
    await zbar.addRelation(ctx, alice, "admin", sys2);

    // First child covers sys1, second must pick up sys2 from the narrowed
    // remainder — verifying both that the union ORs correctly and that the
    // narrowing pass actually runs the tail child on the remaining set.
    const viewer = new Materialised(z, ["viewer"]);
    const admin = new Materialised(z, ["admin"]);
    const union = new Union([viewer, admin]);
    const hits = await union.checkBatch(ctx, alice, "system", ["sys1", "sys2"]);
    expect([...hits].sort()).toEqual(["sys1", "sys2"]);
  });

  test("EMPTY is a constant-false singleton", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const alice = { type: "user" as const, id: "alice" };
    const sys = { type: "system" as const, id: "sys1" };

    expect(await EMPTY.check(ctx, alice, sys)).toBe(false);
    expect([...(await EMPTY.checkBatch(ctx, alice, "system", ["sys1"]))]).toEqual(
      [],
    );
  });
});

// ============================================================================
// End-to-end RT behaviour — the plan-driven engine matches the declared
// semantics. The iot-schema suite exercises the same guarantees against a
// richer schema; the tests here use the trimmed schema so a failure points
// at the engine rather than at a schema quirk.
// ============================================================================

describe("RT check behaviour (engine driving can / hasRelationship)", () => {
  async function seed(zbar: any, ctx: any) {
    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };

    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);
    return { sys, alice, bob, bobContact };
  }

  test("contact.viewer RT grants access to a derived contact for a system viewer", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const e = await seed(zbar, ctx);
    expect(await zbar.can(ctx, e.alice, "view", e.bobContact)).toBe(true);
  });

  test("contact.viewer RT denies access to a user with no system membership", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const e = await seed(zbar, ctx);
    const outsider = { type: "user" as const, id: "outsider" };
    expect(await zbar.can(ctx, outsider, "view", e.bobContact)).toBe(false);
  });

  test("RT hits do not write a materialised viewer row — the amplification stays zero", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const e = await seed(zbar, ctx);
    expect(await zbar.can(ctx, e.alice, "view", e.bobContact)).toBe(true);
    expect(await effectiveRowExists(t, e.alice, "viewer", e.bobContact)).toBe(
      false,
    );
  });

  test("readTimeChainDepth = 0 disables the chain at the planner level", async () => {
    // With chaining off, subject-side collapses to a bare Materialised —
    // we can reach bobContact via owner.viewer on sys1 (one hop, doesn't
    // need chaining), so `can` still succeeds. This locks down that the
    // depth cap gates only recursion, not the base RT probe.
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar({ readTimeChainDepth: 0 });
    const e = await seed(zbar, ctx);
    expect(await zbar.can(ctx, e.alice, "view", e.bobContact)).toBe(true);
  });
});

// ============================================================================
// Enumeration operators and plan-driven list paths.
//
// These tests lock down the `expand*` / `checkBatchSubjects` contracts and
// exercise the list builder's planner-driven paths. The end-to-end RT and
// IoT suites cover plan×DB parity; this section nails down the primitives
// against known seeded graphs so executor refactors don't drift silently.
// ============================================================================

describe("operator enumeration (step 2)", () => {
  async function seedExpand(zbar: any, ctx: any) {
    const s1 = { type: "system" as const, id: "sys1" };
    const s2 = { type: "system" as const, id: "sys2" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const carol = { type: "user" as const, id: "carol" };
    await zbar.addRelation(ctx, alice, "viewer", s1);
    await zbar.addRelation(ctx, alice, "viewer", s2);
    await zbar.addRelation(ctx, bob, "viewer", s1);
    await zbar.addRelation(ctx, carol, "admin", s1);
    return { s1, s2, alice, bob, carol };
  }

  test("Materialised.expandObjects enumerates all objects of type reachable from subject", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const e = await seedExpand(zbar, ctx);

    const z = (zbar as any)._internal as ZbarInternal;
    const mat = new Materialised(z, ["viewer"]);
    const ids = await mat.expandObjects(ctx, e.alice, "system");
    expect([...ids].sort()).toEqual(["sys1", "sys2"]);
  });

  test("Materialised.expandSubjects enumerates all subjects of type reaching object", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const e = await seedExpand(zbar, ctx);

    const z = (zbar as any)._internal as ZbarInternal;
    const viewer = new Materialised(z, ["viewer"]);
    const adminOrViewer = new Materialised(z, ["admin", "viewer"]);

    const viewers = await viewer.expandSubjects(ctx, e.s1, "user");
    expect([...viewers].sort()).toEqual(["alice", "bob"]);

    const all = await adminOrViewer.expandSubjects(ctx, e.s1, "user");
    expect([...all].sort()).toEqual(["alice", "bob", "carol"]);
  });

  test("Materialised.checkBatchSubjects filters candidate subject IDs in one query", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const e = await seedExpand(zbar, ctx);

    const z = (zbar as any)._internal as ZbarInternal;
    const viewer = new Materialised(z, ["viewer"]);
    const hits = await viewer.checkBatchSubjects(ctx, e.s1, "user", [
      e.alice.id,
      e.bob.id,
      e.carol.id,
      "outsider",
    ]);
    // carol is admin not viewer; outsider is absent entirely.
    expect([...hits].sort()).toEqual(["alice", "bob"]);
  });

  test("EdgeExpand.listObjectsBatch unions forward fan-out in one round-trip", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };
    // Seed two users who both have viewer on sys; neither on grp.
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);

    // EdgeExpand forward: given user subjects, which systems do they reach
    // via "viewer"? Both should hit sys1; the batch must union.
    const z = (zbar as any)._internal as ZbarInternal;
    const fwd = new EdgeExpand(z, "user", ["viewer"]);
    const union = await fwd.listObjectsBatch(ctx, [alice, bob], "system");
    expect([...union]).toEqual([sys.id]);
    // Empty inputs short-circuit without failing.
    expect([...(await fwd.listObjectsBatch(ctx, [], "system"))]).toEqual([]);
    // Objects only of the requested type — grp shouldn't leak in.
    void grp;
  });

  test("Compose.expandObjects drives the RT dot-path and batches the forward step", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    // Seed three contacts derived from primary_contact → contact_member.
    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const carol = { type: "user" as const, id: "carol" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };
    const carolContact = { type: "contact" as const, id: "carol-contact" };
    const bobContact2 = { type: "contact" as const, id: "bob-contact-2" };

    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, carol, "viewer", sys);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);
    await zbar.addRelation(ctx, carolContact, "primary_contact", carol);
    await zbar.addRelation(ctx, bobContact2, "primary_contact", bob);

    // Compose(EdgeExpand("system", ["owner"]), Materialised(["viewer"])) —
    // the planner's exact shape for contact.viewer RT.
    const z = (zbar as any)._internal as ZbarInternal;
    const sourceSide = new EdgeExpand(z, "system", ["owner"]);
    const subjectSide = new Materialised(z, ["viewer"]);
    const plan = new Compose(sourceSide, subjectSide);

    const ids = await plan.expandObjects(ctx, alice, "contact");
    expect([...ids].sort()).toEqual([
      "bob-contact",
      "bob-contact-2",
      "carol-contact",
    ]);
  });

  test("Compose.expandSubjects returns all subjects reaching the object through the RT path", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    // bobContact owner = sys1; sys1 viewers = alice, bob, carol — all three
    // should show up via `Compose.expandSubjects`.
    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const carol = { type: "user" as const, id: "carol" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };
    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, carol, "viewer", sys);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);

    const z = (zbar as any)._internal as ZbarInternal;
    const plan = new Compose(
      new EdgeExpand(z, "system", ["owner"]),
      new Materialised(z, ["viewer"]),
    );
    const subs = await plan.expandSubjects(ctx, bobContact, "user");
    expect([...subs].sort()).toEqual(["alice", "bob", "carol"]);
  });

  test("Compose.checkBatch intersects the RT reachable set with pending candidates", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };
    const unrelated = { type: "contact" as const, id: "unrelated-contact" };
    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);

    const z = (zbar as any)._internal as ZbarInternal;
    const plan = new Compose(
      new EdgeExpand(z, "system", ["owner"]),
      new Materialised(z, ["viewer"]),
    );

    // Of the three candidates, only bobContact is reachable for alice.
    // `unrelated` has no primary_contact backing; a bogus id must not match.
    void unrelated;
    const hits = await plan.checkBatch(ctx, alice, "contact", [
      "bob-contact",
      "unrelated-contact",
      "does-not-exist",
    ]);
    expect([...hits]).toEqual(["bob-contact"]);
  });

  test("Compose.checkBatchSubjects intersects reachable subjects with candidates", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };
    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);

    const z = (zbar as any)._internal as ZbarInternal;
    const plan = new Compose(
      new EdgeExpand(z, "system", ["owner"]),
      new Materialised(z, ["viewer"]),
    );
    const hits = await plan.checkBatchSubjects(ctx, bobContact, "user", [
      "alice",
      "bob",
      "outsider",
    ]);
    expect([...hits].sort()).toEqual(["alice", "bob"]);
  });

  test("Union.expandObjects unions children", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const z = (zbar as any)._internal as ZbarInternal;

    const s1 = { type: "system" as const, id: "sys1" };
    const s2 = { type: "system" as const, id: "sys2" };
    const alice = { type: "user" as const, id: "alice" };
    await zbar.addRelation(ctx, alice, "viewer", s1);
    await zbar.addRelation(ctx, alice, "admin", s2);

    const viewer = new Materialised(z, ["viewer"]);
    const admin = new Materialised(z, ["admin"]);
    const ids = await new Union([viewer, admin]).expandObjects(
      ctx,
      alice,
      "system",
    );
    expect([...ids].sort()).toEqual(["sys1", "sys2"]);
  });

  test("Union.expandSubjects unions children", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const z = (zbar as any)._internal as ZbarInternal;

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "admin", sys);

    const viewer = new Materialised(z, ["viewer"]);
    const admin = new Materialised(z, ["admin"]);
    const ids = await new Union([viewer, admin]).expandSubjects(
      ctx,
      sys,
      "user",
    );
    expect([...ids].sort()).toEqual(["alice", "bob"]);
  });

  test("Union.checkBatchSubjects narrows between tiers", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const z = (zbar as any)._internal as ZbarInternal;

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "admin", sys);

    const viewer = new Materialised(z, ["viewer"]);
    const admin = new Materialised(z, ["admin"]);
    const hits = await new Union([viewer, admin]).checkBatchSubjects(
      ctx,
      sys,
      "user",
      ["alice", "bob", "carol"],
    );
    expect([...hits].sort()).toEqual(["alice", "bob"]);
  });

  test("EMPTY.expandObjects / expandSubjects / checkBatchSubjects return empty sets", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const alice = { type: "user" as const, id: "alice" };
    const sys = { type: "system" as const, id: "sys1" };

    expect([...(await EMPTY.expandObjects(ctx, alice, "system"))]).toEqual([]);
    expect([...(await EMPTY.expandSubjects(ctx, sys, "user"))]).toEqual([]);
    expect(
      [...(await EMPTY.checkBatchSubjects(ctx, sys, "user", ["alice"]))],
    ).toEqual([]);
  });
});

// ============================================================================
// Plan-driven list paths — `list().collect()` routes everything through
// `plan.expandObjects` / `plan.expandSubjects` / `plan.checkBatch`. These
// tests pin the behavioural contracts on a seeded graph so we can spot
// drift in the ported code path rather than relying on the IoT suite alone.
// ============================================================================

describe("plan-driven list paths", () => {
  async function seedContacts(zbar: any, ctx: any) {
    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const carol = { type: "user" as const, id: "carol" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };
    const carolContact = { type: "contact" as const, id: "carol-contact" };

    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, carol, "viewer", sys);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);
    await zbar.addRelation(ctx, carolContact, "primary_contact", carol);
    return { sys, alice, bob, carol, bobContact, carolContact };
  }

  test("zbar.list().object('contact').subject(user) picks up RT-derived objects", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const e = await seedContacts(zbar, ctx);

    const contacts = await zbar
      .list()
      .object("contact")
      .permission("view")
      .subject(e.alice)
      .collect(ctx);
    expect(contacts.map((r: any) => r.objectId).sort()).toEqual([
      "bob-contact",
      "carol-contact",
    ]);
  });

  test("zbar.list().object('contact', id).subject('user') picks up RT-derived subjects", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const e = await seedContacts(zbar, ctx);

    const users = await zbar
      .list()
      .object(e.bobContact)
      .permission("view")
      .subject("user")
      .collect(ctx);
    expect(users.map((r: any) => r.subjectId).sort()).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
  });

  test("no-via list paths ignore unrelated users", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const e = await seedContacts(zbar, ctx);
    // outsider has no system membership at all.
    const outsider = { type: "user" as const, id: "outsider" };

    const contacts = await zbar
      .list()
      .object("contact")
      .permission("view")
      .subject(outsider)
      .collect(ctx);
    expect(contacts).toEqual([]);
    // And the contact has no unexpected subjects.
    const users = await zbar
      .list()
      .object(e.bobContact)
      .permission("view")
      .subject("user")
      .collect(ctx);
    expect(users.map((r: any) => r.subjectId)).not.toContain("outsider");
  });
});

// ============================================================================
// No-RT schema — a plain inheritance-only schema used by the planner-shape,
// getPermissions, and query-count tests that need a `doc` entity with NO
// read-time paths declared, so every answer must come from the single
// materialised branch.
// ============================================================================

const docSchema = createZbarSchema()
  .entity("user", (e) => e)
  .entity("doc", (e) =>
    e
      .relation("owner", "user")
      .relation("viewer", "user", "owner")
      .permission("read", "viewer"),
  )
  .build();

const mkCondZbar = () =>
  new Zbar(api, {
    schema: docSchema,
    asyncWrites: false,
  });

describe("planRelation — real-schema shape + behaviour", () => {
  test("plan on a no-RT schema is a bare Materialised (no RT on `doc`)", () => {
    const zbar = mkCondZbar();
    const z = (zbar as any)._internal as ZbarInternal;
    const plan = planRelation(z, "doc", ["viewer", "owner"]);
    expect(plan).toBeInstanceOf(Materialised);
  });

  test("plan on an RT-carrying schema is Union(Materialised, …RT composes)", () => {
    const zbar = mkZbar();
    const z = (zbar as any)._internal as ZbarInternal;
    const plan = planRelation(z, "contact", ["viewer", "admin"]);
    expect(plan).toBeInstanceOf(Union);
    const children = (plan as Union).children;
    expect(children[0]).toBeInstanceOf(Materialised);
    for (const child of children.slice(1)) expect(child).toBeInstanceOf(Compose);
  });

  test("end-to-end: plan.check agrees with zbar.can on a no-RT schema", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkCondZbar();
    const alice = { type: "user" as const, id: "alice" };
    const doc = { type: "doc" as const, id: "doc1" };
    await zbar.addRelation(ctx, alice, "owner", doc);

    // Inheritance: read <- viewer <- owner. An owner is granted read.
    expect(await zbar.can(ctx, alice, "read", doc)).toBe(true);
  });
});

// ============================================================================
// getPermissions via the planner.
// ============================================================================

describe("getPermissions through the unified plan", () => {
  test("returns all permissions granted by inheritance + RT", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const e = await (async () => {
      const sys = { type: "system" as const, id: "sys1" };
      const alice = { type: "user" as const, id: "alice" };
      const bob = { type: "user" as const, id: "bob" };
      const bobContact = { type: "contact" as const, id: "bob-contact" };
      await zbar.addRelation(ctx, alice, "viewer", sys);
      await zbar.addRelation(ctx, bob, "viewer", sys);
      await zbar.addRelation(ctx, bobContact, "primary_contact", bob);
      return { sys, alice, bob, bobContact };
    })();

    // contact declares `view` (via viewer) and `manage` (via admin).
    // Alice is a system viewer → gets the RT-derived contact.viewer path.
    const perms = await zbar.getPermissions(ctx, e.alice, e.bobContact);
    expect([...perms].sort()).toEqual(["view"]);
  });
});

// ============================================================================
// Access-style planRelation calls + the evaluateManyPermissions optimiser.
// ============================================================================

/**
 * Wrap a convex-test context's `runQuery` so we can count calls to specific
 * component queries. `api` is a `anyApi` proxy, so references aren't stable
 * across accesses; we identify the function by its Convex-assigned name
 * (`"queries:checkPermissionFast"` etc.) via `getFunctionName`.
 */
function countingCtx(t: any) {
  const base = mkCtx(t);
  // The entire effective-graph read surface is two component queries; counting
  // them by direction is the meaningful query-count contract (point vs range
  // vs batch is an internal dispatch detail of each).
  const counts = {
    effectiveForward: 0,
    effectiveReverse: 0,
  };
  const ctx = {
    runQuery: async (fn: any, args: any) => {
      const name = getFunctionName(fn);
      if (name === "queries:effectiveForward") counts.effectiveForward++;
      else if (name === "queries:effectiveReverse") counts.effectiveReverse++;
      return base.runQuery(fn, args);
    },
    runMutation: base.runMutation,
  } as any;
  return { ctx, counts };
}

describe("planRelation with no permission (the .via() gate/chain shape)", () => {
  // Passing `undefined` for `permission` is how `.via()` gate/chain hops
  // ask planRelation for a structural connectivity plan. These tests lock
  // the shape + behaviour of that call path.
  test("one call, one materialised query when no RT applies", async () => {
    const t = setup();
    const { ctx, counts } = countingCtx(t);
    const zbar = mkZbar();
    const z = (zbar as any)._internal as ZbarInternal;
    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    await zbar.addRelation(ctx, alice, "viewer", sys);

    for (const k of Object.keys(counts) as Array<keyof typeof counts>) {
      counts[k] = 0;
    }
    const plan = planRelation(z, "system", ["viewer"]);
    expect(plan).toBeInstanceOf(Materialised);
    expect(await plan.check(ctx, alice, sys)).toBe(true);
    const bob = { type: "user" as const, id: "bob" };
    expect(await plan.check(ctx, bob, sys)).toBe(false);

    // Two checks → exactly two forward queries, no reverse.
    expect(counts.effectiveForward).toBe(2);
    expect(counts.effectiveReverse).toBe(0);
  });

  test("two materialised queries when exactly one RT dot-path applies", async () => {
    const t = setup();
    const { ctx, counts } = countingCtx(t);
    const zbar = mkZbar();
    const z = (zbar as any)._internal as ZbarInternal;
    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };
    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);

    for (const k of Object.keys(counts) as Array<keyof typeof counts>) {
      counts[k] = 0;
    }
    // Force the direct branch to miss by only asking for `admin` — then the
    // RT path `owner.admin` is the only way to reach the contact, and we
    // want exactly: 1 direct check + 1 edge expansion + 1 inner hop check.
    // (The direct branch runs regardless; the hop-2 Compose runs only
    // because direct missed.)
    const plan = planRelation(z, "contact", ["admin"]);
    expect(plan).toBeInstanceOf(Union); // direct + one Compose branch

    // Alice has no admin anywhere → everything denies.
    expect(await plan.check(ctx, alice, bobContact)).toBe(false);
    // Direct branch: 1 × checkPermissionFast
    // RT branch (owner.admin): 1 × listSubjectsWithAccessFast (hop 1)
    //                         + 1 × checkPermissionBatchObjects (hop 2)
    expect(counts.effectiveForward).toBe(2); // direct + RT hop-2
    expect(counts.effectiveReverse).toBe(1); // RT hop-1
  });
});

describe("evaluateManyPermissions (getPermissions' minimum-work evaluator)", () => {
  test("issues exactly one materialised query regardless of permission count", async () => {
    const t = setup();
    const { ctx, counts } = countingCtx(t);
    // Use the no-RT schema so there are NO RT paths — every answer
    // must come from the single materialised batch.
    const zbar = mkCondZbar();
    const alice = { type: "user" as const, id: "alice" };
    const doc = { type: "doc" as const, id: "doc1" };
    await zbar.addRelation(ctx, alice, "owner", doc);

    // Reset: we only care about queries fired by getPermissions itself.
    for (const k of Object.keys(counts) as Array<keyof typeof counts>) {
      counts[k] = 0;
    }
    await zbar.getPermissions(ctx, alice, doc);

    // No RT paths declared on `doc` → one forward batch, no fallback queries.
    expect(counts.effectiveForward).toBe(1);
    expect(counts.effectiveReverse).toBe(0);
  });

  test("batches the materialised side even when some permissions need RT fallback", async () => {
    const t = setup();
    const { ctx, counts } = countingCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };
    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);

    for (const k of Object.keys(counts) as Array<keyof typeof counts>) {
      counts[k] = 0;
    }
    const perms = await zbar.getPermissions(ctx, alice, bobContact);
    expect([...perms].sort()).toEqual(["view"]);

    // One materialised forward batch covers every permission (shared, not
    // plan-per-permission); the RT fallback adds one source hop (reverse) +
    // one inner check (forward) per derived relation (viewer, admin).
    expect(counts.effectiveForward).toBe(3); // 1 materialised + 2 RT hop-2
    expect(counts.effectiveReverse).toBe(2); // 2 RT hop-1
  });

  test("returns granted permissions in input order", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkCondZbar();
    const z = (zbar as any)._internal as ZbarInternal;
    const alice = { type: "user" as const, id: "alice" };
    const doc = { type: "doc" as const, id: "doc1" };
    await zbar.addRelation(ctx, alice, "owner", doc);

    // Invoke evaluateManyPermissions directly so we control input order.
    const perms = await evaluateManyPermissions(
      z,
      ctx,
      alice,
      doc,
      [
        { permission: "read", targets: ["viewer"] },
        // "phantom" has no declared targets → never granted.
        { permission: "phantom", targets: [] },
      ],
    );
    // Neither passes (no viewer edge, phantom is empty). A non-trivial
    // assertion: add a direct viewer relation and re-check.
    expect(perms).toEqual([]);

    await zbar.addRelation(ctx, alice, "viewer", doc);
    const perms2 = await evaluateManyPermissions(
      z,
      ctx,
      alice,
      doc,
      [
        { permission: "read", targets: ["viewer"] },
        { permission: "phantom", targets: [] },
      ],
    );
    expect(perms2).toEqual(["read"]);
  });

  test("empty perms list returns [] without issuing any queries", async () => {
    const t = setup();
    const { ctx, counts } = countingCtx(t);
    const zbar = mkCondZbar();
    const z = (zbar as any)._internal as ZbarInternal;
    const alice = { type: "user" as const, id: "alice" };
    const doc = { type: "doc" as const, id: "doc1" };

    const result = await evaluateManyPermissions(z, ctx, alice, doc, []);
    expect(result).toEqual([]);
    expect(counts.effectiveForward).toBe(0);
    expect(counts.effectiveReverse).toBe(0);
  });
});

// ============================================================================
// Userset read-time relations.
//
// `device.readTimeRelation('viewer', 'group#viewer')` should behave as if
// membership in a group that is (directly) a viewer of the device grants
// viewer access transitively — but without materialising a per-user edge.
//
// The RT compiler already maps userset paths onto the same Compose shape
// that dot-paths use, so these tests pin three guarantees:
//   1. The compiled plan is `Union(direct, Compose(EdgeExpand, …))` and the
//      edge's subject type is the userset type (not the dot-path source).
//   2. End-to-end access via the group membership grants the permission.
//   3. No effective `user → device` row is written; the fan-out is zero.
// ============================================================================

const usersetSchema = createZbarSchema()
  .entity("user", (e) => e)
  .entity("group", (e) =>
    e
      // admins inherit viewer (admin is a sub-relation of viewer) — the
      // conventional role-hierarchy shape where higher roles imply lower.
      .relation("admin", "user")
      .relation("viewer", "user", "admin"),
  )
  .entity("device", (e) =>
    e
      .relation("viewer", "user", { type: "group" })
      .readTimeRelation("viewer", "group#viewer")
      .permission("view", "viewer"),
  )
  .build();

const mkUsersetZbar = () =>
  new Zbar(api, {
    schema: usersetSchema,
    asyncWrites: false,
  });

describe("userset readTimeRelation", () => {
  test("compiles to Union(direct, Compose(EdgeExpand(group, [viewer]), …))", () => {
    const zbar = mkUsersetZbar();
    const z = (zbar as any)._internal as ZbarInternal;
    const plan = planRelation(z, "device", ["viewer"]) as Union;
    expect(plan).toBeInstanceOf(Union);
    expect(plan.children[0]).toBeInstanceOf(Materialised);
    const compose = plan.children[1] as Compose;
    expect(compose).toBeInstanceOf(Compose);
    // The subject type walked first is the userset type ('group').
    expect(compose.sourceSide.subjectType).toBe("group");
    // The edge relation is the derived relation itself — that's how the
    // userset semantics differ from a dot-path (where the edge relation is
    // the source of the dot).
    expect(compose.sourceSide.relations).toEqual(["viewer"]);
  });

  test("grants access through a group viewer membership", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkUsersetZbar();

    const user = { type: "user" as const, id: "alice" };
    const group = { type: "group" as const, id: "g1" };
    const device = { type: "device" as const, id: "d1" };

    await zbar.addRelation(ctx, user, "viewer", group);
    await zbar.addRelation(ctx, group, "viewer", device);

    expect(await zbar.can(ctx, user, "view", device)).toBe(true);
  });

  test("grants access via the inheritance chain on the userset side (group.admin ⇒ group.viewer)", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkUsersetZbar();

    const user = { type: "user" as const, id: "alice" };
    const group = { type: "group" as const, id: "g1" };
    const device = { type: "device" as const, id: "d1" };

    // admin inherits viewer on group; since group is a viewer of device, a
    // group-admin user should also be granted device.view at read time.
    await zbar.addRelation(ctx, user, "admin", group);
    await zbar.addRelation(ctx, group, "viewer", device);

    expect(await zbar.can(ctx, user, "view", device)).toBe(true);
  });

  test("denies users who are not members of any viewer group", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkUsersetZbar();

    const user = { type: "user" as const, id: "alice" };
    const group = { type: "group" as const, id: "g1" };
    const device = { type: "device" as const, id: "d1" };

    // Group is a viewer of device but alice is not a member.
    await zbar.addRelation(ctx, group, "viewer", device);

    expect(await zbar.can(ctx, user, "view", device)).toBe(false);
  });

  test("writes no user→device effective row — fan-out stays zero", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkUsersetZbar();

    const user = { type: "user" as const, id: "alice" };
    const group = { type: "group" as const, id: "g1" };
    const device = { type: "device" as const, id: "d1" };

    await zbar.addRelation(ctx, user, "viewer", group);
    await zbar.addRelation(ctx, group, "viewer", device);

    // Access is granted at read time; no materialised user→device row.
    expect(await zbar.can(ctx, user, "view", device)).toBe(true);
    expect(await effectiveRowExists(t, user, "viewer", device)).toBe(false);
  });

  test("list().object('device').subject(user) enumerates RT-derived devices", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkUsersetZbar();

    const user = { type: "user" as const, id: "alice" };
    const group = { type: "group" as const, id: "g1" };
    const d1 = { type: "device" as const, id: "d1" };
    const d2 = { type: "device" as const, id: "d2" };

    await zbar.addRelation(ctx, user, "viewer", group);
    await zbar.addRelation(ctx, group, "viewer", d1);
    await zbar.addRelation(ctx, group, "viewer", d2);

    const rows = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject(user)
      .collect(ctx);
    expect(rows.map((r: any) => r.objectId).sort()).toEqual(["d1", "d2"]);
  });

  test("list().object(device).subject('user') enumerates RT-derived subjects", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkUsersetZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const outsider = { type: "user" as const, id: "outsider" };
    const group = { type: "group" as const, id: "g1" };
    const device = { type: "device" as const, id: "d1" };

    await zbar.addRelation(ctx, alice, "viewer", group);
    await zbar.addRelation(ctx, bob, "viewer", group);
    await zbar.addRelation(ctx, group, "viewer", device);
    void outsider; // not a group member → must not appear.

    const rows = await zbar
      .list()
      .object(device)
      .permission("view")
      .subject("user")
      .collect(ctx);
    expect(rows.map((r: any) => r.subjectId).sort()).toEqual(["alice", "bob"]);
  });
});

// ============================================================================
// Union.check query-count contract.
//
// The planner builds `Union(direct, ...RT composes)` with children sorted by
// cost so `children[0]` is the cheapest branch (direct Materialised). The
// hybrid check probes that branch sequentially and only fires the RT
// composes when the direct probe misses. These tests pin the query-count
// contract for all three outcomes: direct hit, RT hit, and all miss.
// ============================================================================

describe("Union.check hybrid (sequential direct, parallel RT on miss)", () => {
  test("direct hit fires exactly one query — RT branches are skipped entirely", async () => {
    const t = setup();
    const { ctx, counts } = countingCtx(t);
    const zbar = mkUsersetZbar();
    const z = (zbar as any)._internal as ZbarInternal;

    const alice = { type: "user" as const, id: "alice" };
    const device = { type: "device" as const, id: "d1" };
    await zbar.addRelation(ctx, alice, "viewer", device);

    for (const k of Object.keys(counts) as Array<keyof typeof counts>) {
      counts[k] = 0;
    }
    const plan = planRelation(z, "device", ["viewer"]);
    expect(plan).toBeInstanceOf(Union);
    expect(await plan.check(ctx, alice, device)).toBe(true);

    // Direct branch hits on the first query → RT Compose never fires.
    expect(counts.effectiveForward).toBe(1);
    expect(counts.effectiveReverse).toBe(0);
  });

  test("direct miss + RT hit fires direct + every RT query (no cancellation)", async () => {
    const t = setup();
    const { ctx, counts } = countingCtx(t);
    const zbar = mkUsersetZbar();
    const z = (zbar as any)._internal as ZbarInternal;

    const alice = { type: "user" as const, id: "alice" };
    const group = { type: "group" as const, id: "g1" };
    const device = { type: "device" as const, id: "d1" };
    await zbar.addRelation(ctx, alice, "viewer", group);
    await zbar.addRelation(ctx, group, "viewer", device);

    for (const k of Object.keys(counts) as Array<keyof typeof counts>) {
      counts[k] = 0;
    }
    const plan = planRelation(z, "device", ["viewer"]);
    expect(await plan.check(ctx, alice, device)).toBe(true);

    // Direct probe misses (1 query), then RT Compose fires its two hops.
    expect(counts.effectiveForward).toBe(2); // direct + RT hop-2
    expect(counts.effectiveReverse).toBe(1); // RT hop-1
  });

  test("all miss fires direct + the RT source hop (no intermediates → Compose self-short-circuits)", async () => {
    const t = setup();
    const { ctx, counts } = countingCtx(t);
    const zbar = mkUsersetZbar();
    const z = (zbar as any)._internal as ZbarInternal;

    const alice = { type: "user" as const, id: "alice" };
    const device = { type: "device" as const, id: "d1" };
    // No edges at all — alice has no access.

    for (const k of Object.keys(counts) as Array<keyof typeof counts>) {
      counts[k] = 0;
    }
    const plan = planRelation(z, "device", ["viewer"]);
    expect(await plan.check(ctx, alice, device)).toBe(false);

    // Direct probe misses (1 forward), RT Compose fires its source hop
    // (1 reverse) and bails on empty intermediates before the second hop.
    expect(counts.effectiveForward).toBe(1);
    expect(counts.effectiveReverse).toBe(1);
  });

  test("all miss with intermediates present fires every branch end-to-end", async () => {
    const t = setup();
    const { ctx, counts } = countingCtx(t);
    const zbar = mkUsersetZbar();
    const z = (zbar as any)._internal as ZbarInternal;

    const alice = { type: "user" as const, id: "alice" };
    const group = { type: "group" as const, id: "g1" };
    const device = { type: "device" as const, id: "d1" };
    // Group is on the device (intermediate exists) but alice is not in it.
    await zbar.addRelation(ctx, group, "viewer", device);

    for (const k of Object.keys(counts) as Array<keyof typeof counts>) {
      counts[k] = 0;
    }
    const plan = planRelation(z, "device", ["viewer"]);
    expect(await plan.check(ctx, alice, device)).toBe(false);

    // Direct (1) + RT source hop finds the group (1) + RT subject-side
    // batch check against that group (1) = 3 queries total.
    expect(counts.effectiveForward).toBe(2); // direct + RT hop-2
    expect(counts.effectiveReverse).toBe(1); // RT hop-1
  });
});
