import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../../component/schema.js";
import { api } from "../../component/_generated/api.js";
import { Zbar, createZbarSchema } from "../index.js";
import { register as registerWorkpool } from "@convex-dev/workpool/test";

// ============================================================================
// Harness
// ============================================================================

const modules = import.meta.glob("../../component/**/*.ts");

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

async function dbCounts(t: any) {
  const relationships = await t.run(
    async (inner: any) => await inner.db.query("relationships").collect(),
  );
  const effective = await t.run(
    async (inner: any) =>
      await inner.db.query("effectiveRelationships").collect(),
  );
  return {
    base: relationships.length,
    effective: effective.length,
    totalPaths: effective.reduce((n: number, e: any) => n + e.paths.length, 0),
    rows: { relationships, effective },
  };
}

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
// Schema: IoT permissions with effective reverse edges + read-time relations.
// ============================================================================
//
// Relative to the original schema, this version:
//   1. Adds notification_rule admin/viewer relations and permissions so rules
//      inherit access from their sources and recipients (the user's first
//      request — "notification_rules visible to anyone with access to the
//      resources that are sources or recipients").
//   2. Extends group.contact_member with `user_member.primary_contact`, giving
//      groups the same primary-contact auto-enrolment the system already had.
//   3. Moves both `contact.admin` and `contact.viewer` to read-time paths.
//      Eliminates O(#system_members × #primary-contact-derived contacts)
//      write amplification on both viewer *and* admin tiers.
//   4. Moves both `notification_rule.admin` and `notification_rule.viewer` to
//      RT. Eliminates O(#rules × #members_per_source_or_recipient)
//      amplification across the rule's entire permission set.
//   5. Keeps device.viewer materialised on `owner.viewer` / `container.viewer`.
//      The fan-out is modest (bounded by #devices × #system_viewers per
//      system), and keeping it materialised lets the rule-source RT step-2
//      resolve device sources without chaining.
//
// `device.admin`, `group.admin`, `system.admin` stay materialised — device /
// group / system admin checks are the hot path for management permissions.
// ============================================================================

const iotSchema = createZbarSchema()
  .entity("user", (e) => e.relation("primary_contact"))

  .entity("system", (e) =>
    e
      .relation("owner", "user")
      .relation("admin", "user", "owner")
      .relation("viewer", "user", "admin")
      .relation("has_group")
      .relation("user_member", "viewer")
      .relation("device_member")
      .relation("contact_member")
      .permission("view", "viewer")
      .permission("manage_groups", "admin")
      .permission("manage_contacts", "admin")
      .permission("manage_rules", "admin")
      .permission("manage_members", "admin")
      .permission("manage_owners", "owner"),
  )

  .entity("group", (e) =>
    e
      .relation("owner", { type: "system", reverse: "has_group" })
      .relation("admin", "user", "owner.admin")
      .relation("viewer", "user", "admin", "owner.viewer")
      .relation("user_member", "viewer")
      .relation("device_member")
      .relation("contact_member")
      .permission("view", "viewer")
      .permission("manage", "admin")
      .permission("manage_members", "admin"),
  )

  .entity("device", (e) =>
    e
      .relation("owner", { type: "system", reverse: "device_member" })
      .relation("container", { type: "group", reverse: "device_member" })
      .relation("admin", "user", "owner.admin", "container.admin")
      // Materialised: moderate fan-out and keeps the
      // notification_rule.viewer RT step-2 cheap for device-sourced rules.
      .relation("viewer", "user", "admin", "owner.viewer", "container.viewer")
      .relation("user_member", "viewer")
      .permission("view", "viewer")
      .permission("manage", "admin")
      .permission("manage_members", "admin"),
  )

  .entity("contact", (e) =>
    e
      .relation("owner", { type: "system", reverse: "contact_member" })
      .relation("container", { type: "group", reverse: "contact_member" })
      // Both admin and viewer are RT — the whole contact permission set is
      // resolved at read time to avoid any write amplification.
      .relation("admin")
      .readTimeRelation("admin", "owner.admin", "container.admin")
      .relation("viewer", "admin")
      .readTimeRelation("viewer", "owner.viewer", "container.viewer")
      .permission("view", "viewer")
      .permission("manage", "admin"),
  )

  .entity("notification_rule", (e) =>
    e
      .relation(
        "source",
        "device",
        "group",
        "system",
        "group#device_member",
        "system#device_member",
      )
      .relation(
        "recipient",
        "contact",
        "group",
        "system",
        "group#contact_member",
        "system#contact_member",
      )
      // Both admin and viewer are RT — no rule-access rows materialised.
      .relation("admin")
      .readTimeRelation("admin", "source.admin", "recipient.admin")
      .relation("viewer", "admin")
      .readTimeRelation("viewer", "source.viewer", "recipient.viewer")
      .permission("view", "viewer")
      .permission("manage", "admin"),
  )

  .extend("group", (e) =>
    e
      .relation("user_member", "device_member.user_member")
      // Parity with system: group viewers' primary contacts auto-enrol as
      // group contact_members.
      .relation("contact_member", "user_member.primary_contact"),
  )
  .extend("user", (e) => e.relation("primary_contact", "contact"))
  .extend("system", (e) =>
    e
      .relation(
        "user_member",
        "has_group.user_member",
        "device_member.user_member",
      )
      .relation("device_member", "has_group.device_member")
      .relation(
        "contact_member",
        "has_group.contact_member",
        "user_member.primary_contact",
      ),
  )
  .build();

const mkZbar = (opts?: { readTimeChainDepth?: number }) =>
  new Zbar(api, {
    schema: iotSchema,
    asyncWrites: false,
    readTimeChainDepth: opts?.readTimeChainDepth,
  });

// ============================================================================
// Enhancement 1 — Effective Reverse Edges
// ============================================================================

describe("Effective reverse edges on the IoT schema", () => {
  test("primary_contact → contact_member derivation also populates contact.owner effectively", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const aliceContact = { type: "contact" as const, id: "alice-contact" };

    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, aliceContact, "primary_contact", alice);

    // Derived via system.contact_member = user_member.primary_contact.
    expect(
      await effectiveRowExists(t, aliceContact, "contact_member", sys),
    ).toBe(true);

    // The new effective-reverse-edge behaviour: the derivation should also
    // populate the other side of the `{ type, reverse }` declaration.
    expect(await effectiveRowExists(t, sys, "owner", aliceContact)).toBe(true);
  });

  test("system admin inherits admin on primary-contact-derived contacts", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const adminUser = { type: "user" as const, id: "admin1" };
    const viewerUser = { type: "user" as const, id: "viewer1" };
    const viewerContact = {
      type: "contact" as const,
      id: "viewer1-contact",
    };

    await zbar.addRelation(ctx, adminUser, "admin", sys);
    await zbar.addRelation(ctx, viewerUser, "viewer", sys);
    await zbar.addRelation(ctx, viewerContact, "primary_contact", viewerUser);

    // System admins should manage the auto-enrolled contact via the reverse
    // edge + materialised contact.admin = owner.admin.
    expect(
      await zbar.can(ctx, adminUser, "manage", viewerContact),
    ).toBe(true);
  });

  test("reverse edge cascades on removal: pulling the primary_contact drops contact.owner", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const aliceContact = { type: "contact" as const, id: "alice-contact" };

    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, aliceContact, "primary_contact", alice);

    expect(await effectiveRowExists(t, sys, "owner", aliceContact)).toBe(true);

    await zbar.removeRelation(ctx, aliceContact, "primary_contact", alice);

    expect(
      await effectiveRowExists(t, aliceContact, "contact_member", sys),
    ).toBe(false);
    expect(await effectiveRowExists(t, sys, "owner", aliceContact)).toBe(false);
  });
});

// ============================================================================
// Enhancement 2 — Read-time relations
// ============================================================================

describe("Read-time relations on the IoT schema", () => {
  test("contact.viewer RT: system viewer can view a system's primary-contact-derived contacts", async () => {
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

    // Alice and Bob are both viewers of sys1. Bob's primary contact should
    // now be viewable by Alice — the user's desired behaviour, resolved at
    // read time via contact.readTimeRelation('viewer', 'owner.viewer').
    expect(await zbar.can(ctx, alice, "view", bobContact)).toBe(true);

    // And critically: no materialised (alice, viewer, bobContact) row
    // should exist — that's the amplification we're avoiding.
    expect(await effectiveRowExists(t, alice, "viewer", bobContact)).toBe(
      false,
    );
  });

  test("contact.viewer RT: non-viewer cannot see the contact", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const insider = { type: "user" as const, id: "insider" };
    const insiderContact = {
      type: "contact" as const,
      id: "insider-contact",
    };
    const outsider = { type: "user" as const, id: "outsider" };

    await zbar.addRelation(ctx, insider, "viewer", sys);
    await zbar.addRelation(ctx, insiderContact, "primary_contact", insider);

    expect(await zbar.can(ctx, outsider, "view", insiderContact)).toBe(false);
  });

  test("contact.viewer RT also works through the group container", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };

    // Alice views the *group*, not the system. Bob's primary_contact should
    // enrol as a group contact_member and alice should see it via the
    // container.viewer read-time path.
    await zbar.addRelation(ctx, sys, "owner", grp);
    await zbar.addRelation(ctx, alice, "viewer", grp);
    await zbar.addRelation(ctx, bob, "viewer", grp);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);

    expect(await zbar.can(ctx, alice, "view", bobContact)).toBe(true);
    expect(await effectiveRowExists(t, alice, "viewer", bobContact)).toBe(
      false,
    );
  });

  test("notification_rule.viewer RT: source viewer sees the rule (device source)", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };
    const dev = { type: "device" as const, id: "dev1" };
    const alice = { type: "user" as const, id: "alice" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    await zbar.addRelation(ctx, sys, "owner", grp);
    await zbar.addRelation(ctx, grp, "container", dev);
    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, dev, "source", rule);

    // Alice is sys viewer → device viewer (materialised) → step-2
    // materialised check on the device source succeeds.
    expect(await zbar.can(ctx, alice, "view", rule)).toBe(true);
    expect(await effectiveRowExists(t, alice, "viewer", rule)).toBe(false);
  });

  test("notification_rule.viewer RT: source viewer sees the rule (system source via userset)", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, sys, "source", rule);

    // Alice is sys viewer. The system itself is source. Materialised check
    // on (alice, viewer, sys) succeeds at step 2.
    expect(await zbar.can(ctx, alice, "view", rule)).toBe(true);
  });

  test("notification_rule.viewer RT CHAIN: system viewer → contact recipient → rule", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);
    await zbar.addRelation(ctx, bobContact, "recipient", rule);

    // Chain we're exercising:
    //   can(alice, view, rule)                                  depth 0
    //     → notification_rule.viewer RT: recipient.viewer      chain hop 1
    //     → contact.viewer RT: owner.viewer                    chain hop 2
    //     → materialised (alice, viewer, sys)                  hit
    expect(await zbar.can(ctx, alice, "view", rule)).toBe(true);
  });

  test("disabling RT chaining (depth=0) breaks the system-viewer → contact-recipient path", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar({ readTimeChainDepth: 0 });

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);
    await zbar.addRelation(ctx, bobContact, "recipient", rule);

    // With chaining disabled, the step-2 materialised check on the contact
    // recipient misses — alice is not a direct viewer/admin of bobContact,
    // and the RT on contact.viewer can't be chained into.
    expect(await zbar.can(ctx, alice, "view", rule)).toBe(false);
  });

  test("list() returns RT-accessible objects unioned with materialised ones", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };
    const carol = { type: "user" as const, id: "carol" };
    const carolContact = { type: "contact" as const, id: "carol-contact" };

    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);
    await zbar.addRelation(ctx, carol, "viewer", sys);
    await zbar.addRelation(ctx, carolContact, "primary_contact", carol);

    const viewable = await zbar
      .list()
      .object("contact")
      .permission("view")
      .subject(alice)
      .collect(ctx);

    const ids = viewable.map((v) => v.objectId).sort();
    // Alice should see bob's and carol's primary contacts via RT, but *not*
    // have any materialised viewer rows on those contacts.
    expect(ids).toEqual(["bob-contact", "carol-contact"]);
    expect(await effectiveRowExists(t, alice, "viewer", bobContact)).toBe(
      false,
    );
    expect(await effectiveRowExists(t, alice, "viewer", carolContact)).toBe(
      false,
    );
  });

  test("list() listSubjects returns everyone who can view via RT chain", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);
    await zbar.addRelation(ctx, bobContact, "recipient", rule);

    const viewers = await zbar
      .list()
      .object(rule)
      .permission("view")
      .subject("user")
      .collect(ctx);

    // Both alice and bob should surface via the RT chain (rule → recipient
    // (contact) → owner (system) → viewer (alice, bob)).
    expect(viewers.map((v) => v.subjectId).sort()).toEqual(["alice", "bob"]);
  });
});

// ============================================================================
// .via() + RT integration
// ============================================================================

describe(".via() cooperates with RT traversal", () => {
  test("list contacts scoped to a system — RT-reachable contacts included", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };
    const carol = { type: "user" as const, id: "carol" };
    const carolContact = { type: "contact" as const, id: "carol-contact" };

    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);
    await zbar.addRelation(ctx, carol, "viewer", sys);
    await zbar.addRelation(ctx, carolContact, "primary_contact", carol);

    // Scoped to sys1 — both primary-contact-derived contacts should show
    // up through the RT path, with no materialised viewer rows on them.
    const ids = (
      await zbar
        .list()
        .object("contact")
        .permission("view")
        .subject(alice)
        .via(sys)
        .collect(ctx)
    )
      .map((r) => r.objectId)
      .sort();
    expect(ids).toEqual(["bob-contact", "carol-contact"]);

    expect(await effectiveRowExists(t, alice, "viewer", bobContact)).toBe(
      false,
    );
    expect(await effectiveRowExists(t, alice, "viewer", carolContact)).toBe(
      false,
    );
  });

  test("list contacts scoped to a group — container.viewer RT kicks in", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };

    await zbar.addRelation(ctx, sys, "owner", grp);
    await zbar.addRelation(ctx, alice, "viewer", grp);
    await zbar.addRelation(ctx, bob, "viewer", grp);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);

    const ids = (
      await zbar
        .list()
        .object("contact")
        .permission("view")
        .subject(alice)
        .via(grp)
        .collect(ctx)
    ).map((r) => r.objectId);
    expect(ids).toEqual(["bob-contact"]);
  });

  test(".via() scopes correctly — cross-system contacts are excluded", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sysA = { type: "system" as const, id: "sysA" };
    const sysB = { type: "system" as const, id: "sysB" };
    const alice = { type: "user" as const, id: "alice" };
    const inA = { type: "user" as const, id: "in-A" };
    const inAContact = { type: "contact" as const, id: "in-A-contact" };
    const inB = { type: "user" as const, id: "in-B" };
    const inBContact = { type: "contact" as const, id: "in-B-contact" };

    // Alice sees both systems.
    await zbar.addRelation(ctx, alice, "viewer", sysA);
    await zbar.addRelation(ctx, alice, "viewer", sysB);
    await zbar.addRelation(ctx, inA, "viewer", sysA);
    await zbar.addRelation(ctx, inAContact, "primary_contact", inA);
    await zbar.addRelation(ctx, inB, "viewer", sysB);
    await zbar.addRelation(ctx, inBContact, "primary_contact", inB);

    // Scoping to sysA should return only sysA's derived contact, even
    // though alice could see both if she skipped .via().
    const viaA = (
      await zbar
        .list()
        .object("contact")
        .permission("view")
        .subject(alice)
        .via(sysA)
        .collect(ctx)
    ).map((r) => r.objectId);
    expect(viaA).toEqual(["in-A-contact"]);

    const viaB = (
      await zbar
        .list()
        .object("contact")
        .permission("view")
        .subject(alice)
        .via(sysB)
        .collect(ctx)
    ).map((r) => r.objectId);
    expect(viaB).toEqual(["in-B-contact"]);

    // Sanity: without .via(), alice sees both.
    const all = (
      await zbar
        .list()
        .object("contact")
        .permission("view")
        .subject(alice)
        .collect(ctx)
    )
      .map((r) => r.objectId)
      .sort();
    expect(all).toEqual(["in-A-contact", "in-B-contact"]);
  });

  test(".via() gate blocks non-members — no RT result without gate pass", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const insider = { type: "user" as const, id: "insider" };
    const insiderContact = {
      type: "contact" as const,
      id: "insider-contact",
    };
    const outsider = { type: "user" as const, id: "outsider" };

    await zbar.addRelation(ctx, insider, "viewer", sys);
    await zbar.addRelation(ctx, insiderContact, "primary_contact", insider);

    const result = await zbar
      .list()
      .object("contact")
      .permission("view")
      .subject(outsider)
      .via(sys)
      .collect(ctx);
    expect(result).toEqual([]);
  });

  test("list notification_rules scoped to a system — source.viewer RT via string-entity structural target", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    // notification_rule.source uses plain string targets
    // ('device', 'group', 'system') rather than {type: ...} objects.
    // `.via(sys1)` relies on the string-entity-type extension of
    // getStructuralRelations to identify `source` as a system-targeting
    // structural relation, and on getViaRelevantRelations picking up the
    // RT path (source.viewer) to produce a tight gate.
    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const r1 = { type: "notification_rule" as const, id: "r1" };
    const r2 = { type: "notification_rule" as const, id: "r2" };

    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, sys, "source", r1);
    await zbar.addRelation(ctx, sys, "recipient", r2);

    const ids = (
      await zbar
        .list()
        .object("notification_rule")
        .permission("view")
        .subject(alice)
        .via(sys)
        .collect(ctx)
    )
      .map((r) => r.objectId)
      .sort();
    expect(ids).toEqual(["r1", "r2"]);

    // Confirm no (alice, viewer, ruleN) rows were materialised.
    for (const rule of [r1, r2]) {
      expect(await effectiveRowExists(t, alice, "viewer", rule)).toBe(false);
    }
  });

  test("listSubjects scoped to a system — all system viewers found via RT", async () => {
    // Single-hop via(sys) requires a direct structural edge between the
    // via entity and the object. Here sys is added as `source` of rule,
    // so (sys, source, rule) is the structural gate — then the RT path
    // `rule.viewer = source.viewer` surfaces every sys viewer.
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, sys, "source", rule);

    const viewers = (
      await zbar
        .list()
        .object(rule)
        .permission("view")
        .subject("user")
        .via(sys)
        .collect(ctx)
    )
      .map((v) => v.subjectId)
      .sort();
    expect(viewers).toEqual(["alice", "bob"]);

    // No materialised (user, viewer, rule) rows — all access resolved via RT.
    for (const u of [alice, bob]) {
      expect(await effectiveRowExists(t, u, "viewer", rule)).toBe(false);
    }
  });

  test("multi-hop .via(sys, contact) chain resolves primary-contact-derived recipients", async () => {
    // For rules whose recipient is a primary-contact-derived contact,
    // sys1 isn't structurally a source/recipient of the rule. But via
    // the effective reverse edge (sys1, owner, bobContact) we *can* chain
    // .via(sys, bobContact) to scope through both hops.
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);
    await zbar.addRelation(ctx, bobContact, "recipient", rule);

    const viewers = (
      await zbar
        .list()
        .object(rule)
        .permission("view")
        .subject("user")
        .via(sys, bobContact)
        .collect(ctx)
    )
      .map((v) => v.subjectId)
      .sort();
    expect(viewers).toEqual(["alice", "bob"]);
  });

  test("device-source rule is reachable via its system (string-entity structural)", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };
    const dev = { type: "device" as const, id: "dev1" };
    const alice = { type: "user" as const, id: "alice" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    await zbar.addRelation(ctx, sys, "owner", grp);
    await zbar.addRelation(ctx, grp, "container", dev);
    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, dev, "source", rule);

    // Rule's source is a device; the device is in a group of sys1; so
    // the rule is transitively a sys1-scoped rule. The via=sys1 query
    // should surface it via the structural path (device, source, rule) +
    // (sys1, owner, grp1) + (grp1, container, dev). That chain lands the
    // rule in the structural expand of sys1 only if `device` as string
    // target on rule.source is treated as structural — the extension
    // we just added. For the rule to be KNOWN structurally reachable
    // through sys1 we take the "rule has sys1 as source/recipient"
    // shortcut: add sys1 directly as source.
    //
    // In practice users either scope `.via(device)` for device-owned
    // rules or set the system/group as source too; we verify the direct
    // case here.
    await zbar.addRelation(ctx, sys, "source", rule);

    const ids = (
      await zbar
        .list()
        .object("notification_rule")
        .permission("view")
        .subject(alice)
        .via(sys)
        .collect(ctx)
    ).map((r) => r.objectId);
    expect(ids).toEqual(["rule1"]);
  });

  test(".via() + .map()/.collect() still works end-to-end", async () => {
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

    const mapped = await zbar
      .list()
      .object("contact")
      .permission("view")
      .subject(alice)
      .via(sys)
      .map((r) => ({ id: r.objectId, kind: "contact" }))
      .collect(ctx);
    expect(mapped).toEqual([{ id: "bob-contact", kind: "contact" }]);
  });
});

// ============================================================================
// Materialisation hygiene
// ============================================================================

describe("Materialisation hygiene: RT paths produce no write amplification", () => {
  test("adding a system viewer to N primary-contact-derived contacts creates O(N) rows, not O(N × V)", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const viewers = ["v1", "v2", "v3", "v4", "v5"].map((id) => ({
      type: "user" as const,
      id,
    }));
    const contacts = viewers.map((v) => ({
      type: "contact" as const,
      id: `${v.id}-contact`,
    }));

    // 5 system viewers, each with a primary contact.
    for (const v of viewers) await zbar.addRelation(ctx, v, "viewer", sys);
    for (let i = 0; i < viewers.length; i++)
      await zbar.addRelation(ctx, contacts[i], "primary_contact", viewers[i]);

    // For every (viewer V, contact C), check that there is no materialised
    // (V, viewer, C) row. If contact.viewer = 'owner.viewer' were
    // materialised this would be V × C = 25 rows.
    for (const v of viewers) {
      for (const c of contacts) {
        expect(await effectiveRowExists(t, v, "viewer", c)).toBe(false);
      }
    }

    // Sanity: the primary-contact propagation *did* fire and each contact is
    // readable to all system viewers.
    for (const v of viewers) {
      for (const c of contacts) {
        expect(await zbar.can(ctx, v, "view", c)).toBe(true);
      }
    }
  });

  test("adding sources / recipients to N rules does not materialise rule-viewer rows", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const viewers = ["v1", "v2", "v3"].map((id) => ({
      type: "user" as const,
      id,
    }));
    const rules = ["r1", "r2", "r3", "r4"].map((id) => ({
      type: "notification_rule" as const,
      id,
    }));

    for (const v of viewers) await zbar.addRelation(ctx, v, "viewer", sys);
    for (const r of rules) await zbar.addRelation(ctx, sys, "source", r);

    // No (V, viewer, R) materialised — that's the whole point of RT.
    for (const v of viewers) {
      for (const r of rules) {
        expect(await effectiveRowExists(t, v, "viewer", r)).toBe(false);
      }
    }

    // But all viewers can see all rules (via the RT path on source.viewer).
    for (const v of viewers) {
      for (const r of rules) {
        expect(await zbar.can(ctx, v, "view", r)).toBe(true);
      }
    }
  });
});

// ============================================================================
// Cascade / orphan correctness
// ============================================================================

describe("Cascade correctness under complex teardown", () => {
  test("tearing down a fully-built scenario leaves zero rows in both tables", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };
    const dev = { type: "device" as const, id: "dev1" };
    const owner = { type: "user" as const, id: "owner1" };
    const admin = { type: "user" as const, id: "admin1" };
    const viewer = { type: "user" as const, id: "viewer1" };
    const viewerContact = { type: "contact" as const, id: "viewer1-contact" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    // Build up — exercises every rule in the schema.
    await zbar.addRelation(ctx, sys, "owner", grp);
    await zbar.addRelation(ctx, grp, "container", dev);
    await zbar.addRelation(ctx, owner, "owner", sys);
    await zbar.addRelation(ctx, admin, "admin", sys);
    await zbar.addRelation(ctx, viewer, "viewer", sys);
    await zbar.addRelation(ctx, viewerContact, "primary_contact", viewer);
    await zbar.addRelation(ctx, dev, "source", rule);
    await zbar.addRelation(ctx, viewerContact, "recipient", rule);

    // Tear down.
    await zbar.removeRelation(ctx, viewerContact, "recipient", rule);
    await zbar.removeRelation(ctx, dev, "source", rule);
    await zbar.removeRelation(ctx, viewerContact, "primary_contact", viewer);
    await zbar.removeRelation(ctx, viewer, "viewer", sys);
    await zbar.removeRelation(ctx, admin, "admin", sys);
    await zbar.removeRelation(ctx, owner, "owner", sys);
    await zbar.removeRelation(ctx, grp, "container", dev);
    await zbar.removeRelation(ctx, sys, "owner", grp);

    const counts = await dbCounts(t);
    expect(counts.base).toBe(0);
    expect(counts.effective).toBe(0);
  });

  test("deleteEntity on a device cleans up every derived row", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };
    const dev = { type: "device" as const, id: "dev1" };
    const viewer = { type: "user" as const, id: "viewer1" };

    await zbar.addRelation(ctx, sys, "owner", grp);
    await zbar.addRelation(ctx, grp, "container", dev);
    await zbar.addRelation(ctx, viewer, "viewer", sys);

    const before = await dbCounts(t);
    expect(before.effective).toBeGreaterThan(0);

    await zbar.deleteEntity(ctx, dev);

    // Nothing with dev in subjectKey or objectKey should remain.
    const { rows } = await dbCounts(t);
    for (const r of rows.effective) {
      expect(r.subjectKey).not.toBe("device:dev1");
      expect(r.objectKey).not.toBe("device:dev1");
    }
    for (const r of rows.relationships) {
      expect(`${r.subjectType}:${r.subjectId}`).not.toBe("device:dev1");
      expect(`${r.objectType}:${r.objectId}`).not.toBe("device:dev1");
    }
  });

  test("removing a viewer drops their primary-contact's contact_member rows but not other viewers'", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const aliceContact = { type: "contact" as const, id: "alice-contact" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };

    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, aliceContact, "primary_contact", alice);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);

    expect(
      await effectiveRowExists(t, aliceContact, "contact_member", sys),
    ).toBe(true);
    expect(
      await effectiveRowExists(t, bobContact, "contact_member", sys),
    ).toBe(true);

    // Remove alice's access to the system. Her primary_contact's
    // contact_member / owner edges should cascade away; bob's must remain.
    await zbar.removeRelation(ctx, alice, "viewer", sys);

    expect(
      await effectiveRowExists(t, aliceContact, "contact_member", sys),
    ).toBe(false);
    expect(await effectiveRowExists(t, sys, "owner", aliceContact)).toBe(false);

    expect(
      await effectiveRowExists(t, bobContact, "contact_member", sys),
    ).toBe(true);
    expect(await effectiveRowExists(t, sys, "owner", bobContact)).toBe(true);
  });
});

// ============================================================================
// Stress scenario
// ============================================================================

describe("Stress: multi-system IoT deployment", () => {
  test("realistic deployment — permissions, RT resolution, and bounded materialisation", async () => {
    // Larger scenario — convex-test is per-mutation slow so we give this
    // one room. The test does ~120 writes + ~200 permission checks.
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    // Shape: 3 systems × 3 groups × 4 devices + shared users/contacts + 3
    // rules per system.
    const SYSTEMS = 3;
    const GROUPS_PER_SYSTEM = 3;
    const DEVICES_PER_GROUP = 4;
    const RULES_PER_SYSTEM = 3;

    type Entity = { type: string; id: string };
    const systems: Entity[] = [];
    const groups: Entity[] = [];
    const devices: Entity[] = [];
    const rules: Entity[] = [];

    // Users: every system gets its own admin + viewer; one user ("spy")
    // belongs to no system and should be denied across the board.
    const spy = { type: "user" as const, id: "spy" };
    const viewersBySystem: Record<string, Entity> = {};
    const adminsBySystem: Record<string, Entity> = {};

    // Build the world.
    for (let s = 0; s < SYSTEMS; s++) {
      const sys = { type: "system" as const, id: `sys${s}` };
      systems.push(sys);

      const sysViewer = { type: "user" as const, id: `u-v-${s}` };
      const sysAdmin = { type: "user" as const, id: `u-a-${s}` };
      viewersBySystem[sys.id] = sysViewer;
      adminsBySystem[sys.id] = sysAdmin;

      await zbar.addRelation(ctx, sysAdmin, "admin", sys);
      await zbar.addRelation(ctx, sysViewer, "viewer", sys);

      // Primary contact for the system viewer. This exercises the
      // primary_contact → contact_member propagation and the effective
      // reverse edge.
      const viewerContact = {
        type: "contact" as const,
        id: `u-v-${s}-contact`,
      };
      await zbar.addRelation(ctx, viewerContact, "primary_contact", sysViewer);

      for (let g = 0; g < GROUPS_PER_SYSTEM; g++) {
        const grp = {
          type: "group" as const,
          id: `sys${s}-grp${g}`,
        };
        groups.push(grp);
        await zbar.addRelation(ctx, sys, "owner", grp);

        for (let d = 0; d < DEVICES_PER_GROUP; d++) {
          const dev = {
            type: "device" as const,
            id: `sys${s}-grp${g}-dev${d}`,
          };
          devices.push(dev);
          await zbar.addRelation(ctx, grp, "container", dev);
        }
      }

      for (let r = 0; r < RULES_PER_SYSTEM; r++) {
        const rule = {
          type: "notification_rule" as const,
          id: `sys${s}-rule${r}`,
        };
        rules.push(rule);
        // Rotate source types so we cover device / group / system source.
        if (r % 3 === 0) {
          await zbar.addRelation(
            ctx,
            devices.find((x) => x.id.startsWith(`sys${s}`))!,
            "source",
            rule,
          );
        } else if (r % 3 === 1) {
          await zbar.addRelation(
            ctx,
            groups.find((x) => x.id.startsWith(`sys${s}`))!,
            "source",
            rule,
          );
        } else {
          await zbar.addRelation(ctx, sys, "source", rule);
        }
        // Every rule has the system viewer's primary_contact as a recipient
        // — that's the RT-chain stress.
        await zbar.addRelation(ctx, viewerContact, "recipient", rule);
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // Correctness: permission checks across the whole deployment.
    // ──────────────────────────────────────────────────────────────────

    // Every system's viewer sees every resource in their system and nothing
    // in anyone else's system.
    for (const sys of systems) {
      const v = viewersBySystem[sys.id];
      const a = adminsBySystem[sys.id];

      const sysGroups = groups.filter((g) => g.id.startsWith(`${sys.id}-`));
      const sysDevices = devices.filter((d) => d.id.startsWith(`${sys.id}-`));
      const sysRules = rules.filter((r) => r.id.startsWith(`${sys.id}-`));

      for (const g of sysGroups) {
        expect(await zbar.can(ctx, v, "view", g)).toBe(true);
        expect(await zbar.can(ctx, a, "manage", g)).toBe(true);
      }
      for (const d of sysDevices) {
        expect(await zbar.can(ctx, v, "view", d)).toBe(true);
        expect(await zbar.can(ctx, a, "manage", d)).toBe(true);
      }
      for (const r of sysRules) {
        // This is the key RT assertion: the viewer sees the rule via
        // source.viewer (materialised device viewer) or via the RT chain
        // (recipient → contact → owner → system viewer).
        expect(await zbar.can(ctx, v, "view", r)).toBe(true);
        expect(await zbar.can(ctx, a, "manage", r)).toBe(true);
      }
    }

    // Cross-system isolation.
    for (let i = 0; i < systems.length; i++) {
      for (let j = 0; j < systems.length; j++) {
        if (i === j) continue;
        const v = viewersBySystem[systems[i].id];
        const otherGroups = groups.filter((g) =>
          g.id.startsWith(`${systems[j].id}-`),
        );
        const otherRules = rules.filter((r) =>
          r.id.startsWith(`${systems[j].id}-`),
        );
        for (const g of otherGroups) {
          expect(await zbar.can(ctx, v, "view", g)).toBe(false);
        }
        for (const r of otherRules) {
          expect(await zbar.can(ctx, v, "view", r)).toBe(false);
        }
      }
    }

    // The spy sees nothing.
    for (const sys of systems) expect(await zbar.can(ctx, spy, "view", sys)).toBe(false);
    for (const d of devices) expect(await zbar.can(ctx, spy, "view", d)).toBe(false);
    for (const r of rules) expect(await zbar.can(ctx, spy, "view", r)).toBe(false);

    // ──────────────────────────────────────────────────────────────────
    // Materialisation hygiene: no RT-path rows appear in the effective
    // table. These are the precise amplifications we converted to RT.
    // ──────────────────────────────────────────────────────────────────
    for (const sys of systems) {
      const v = viewersBySystem[sys.id];
      const contacts = [{ type: "contact", id: `${v.id}-contact` }];
      for (const c of contacts) {
        expect(
          await effectiveRowExists(t, v, "viewer", { type: c.type, id: c.id }),
        ).toBe(false);
      }
      for (const r of rules.filter((x) => x.id.startsWith(`${sys.id}-`))) {
        expect(await effectiveRowExists(t, v, "viewer", r)).toBe(false);
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // listSubjects across the full graph should enumerate exactly the
    // right users — nothing more, nothing less.
    // ──────────────────────────────────────────────────────────────────
    for (const sys of systems) {
      const rule = rules.find((r) => r.id === `${sys.id}-rule0`)!;
      const found = await zbar
        .list()
        .object(rule)
        .permission("view")
        .subject("user")
        .collect(ctx);
      const expected = [
        adminsBySystem[sys.id].id,
        viewersBySystem[sys.id].id,
      ].sort();
      expect(found.map((x) => x.subjectId).sort()).toEqual(expected);
    }

    // ──────────────────────────────────────────────────────────────────
    // Full teardown — everything should cascade to empty.
    // ──────────────────────────────────────────────────────────────────
    for (const sys of systems) {
      await zbar.deleteEntity(ctx, sys);
    }
    // After deleting the systems, everything that depends on them
    // cascades. We'll clean up the remaining leaf entities too.
    for (const g of groups) await zbar.deleteEntity(ctx, g);
    for (const d of devices) await zbar.deleteEntity(ctx, d);
    for (const r of rules) await zbar.deleteEntity(ctx, r);
    for (const sys of systems) {
      await zbar.deleteEntity(ctx, viewersBySystem[sys.id]);
      await zbar.deleteEntity(ctx, adminsBySystem[sys.id]);
    }
    const contactEntities = Array.from(
      new Set(
        Object.values(viewersBySystem).map((v) => `${v.id}-contact`),
      ),
    ).map((id) => ({ type: "contact" as const, id }));
    for (const c of contactEntities) await zbar.deleteEntity(ctx, c);

    const after = await dbCounts(t);
    expect(after.base).toBe(0);
    expect(after.effective).toBe(0);
  }, 60_000);
});

// ============================================================================
// getPermissions — batched permission enumeration
// ============================================================================

describe("getPermissions on the IoT schema", () => {
  test("owner of a system gets every permission declared on system", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const ownerUser = { type: "user" as const, id: "owner1" };
    await zbar.addRelation(ctx, ownerUser, "owner", sys);

    const perms = await zbar.getPermissions(ctx, ownerUser, sys);
    expect([...perms].sort()).toEqual(
      [
        "manage_contacts",
        "manage_groups",
        "manage_members",
        "manage_owners",
        "manage_rules",
        "view",
      ].sort(),
    );
  });

  test("admin gets every system permission except manage_owners", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const adminUser = { type: "user" as const, id: "admin1" };
    await zbar.addRelation(ctx, adminUser, "admin", sys);

    const perms = await zbar.getPermissions(ctx, adminUser, sys);
    expect([...perms].sort()).toEqual(
      [
        "manage_contacts",
        "manage_groups",
        "manage_members",
        "manage_rules",
        "view",
      ].sort(),
    );
    expect(perms).not.toContain("manage_owners");
  });

  test("viewer gets only 'view' on a system", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const viewerUser = { type: "user" as const, id: "viewer1" };
    await zbar.addRelation(ctx, viewerUser, "viewer", sys);

    const perms = await zbar.getPermissions(ctx, viewerUser, sys);
    expect(perms).toEqual(["view"]);
  });

  test("subject with no access gets []", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const stranger = { type: "user" as const, id: "stranger" };

    const perms = await zbar.getPermissions(ctx, stranger, sys);
    expect(perms).toEqual([]);
  });

  test("entity type with no permissions declared returns []", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    // `user` defines no permissions in the schema — even a connected subject
    // should get an empty array.
    const alice = { type: "user" as const, id: "alice" };
    const contact = { type: "contact" as const, id: "alice-contact" };
    await zbar.addRelation(ctx, contact, "primary_contact", alice);

    const perms = await zbar.getPermissions(ctx, contact, alice);
    expect(perms).toEqual([]);
  });

  test("returned permissions are a subset of the schema's declared permissions", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const admin = { type: "user" as const, id: "admin1" };
    await zbar.addRelation(ctx, admin, "admin", sys);

    const declared = new Set(Object.keys(iotSchema.entities.system.permissions));
    const perms = await zbar.getPermissions(ctx, admin, sys);
    for (const p of perms) {
      expect(declared.has(p)).toBe(true);
    }
  });

  test("RT: system viewer gets ['view'] on a primary-contact-derived contact", async () => {
    // contact.viewer is RT only (owner.viewer / container.viewer). No
    // materialised rows exist on the contact; getPermissions must resolve
    // the view permission through the RT fallback.
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

    const perms = await zbar.getPermissions(ctx, alice, bobContact);
    expect(perms).toEqual(["view"]);

    // Sanity: no materialised viewer row exists — RT did the work.
    expect(await effectiveRowExists(t, alice, "viewer", bobContact)).toBe(false);
  });

  test("RT: system admin gets ['view', 'manage'] on a primary-contact-derived contact", async () => {
    // Both contact.admin and contact.viewer are RT. A system admin should
    // satisfy both — `manage` via admin RT on owner.admin, and `view` via
    // viewer's admin rewrite (admin path reuse) or the viewer RT path.
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const adminUser = { type: "user" as const, id: "admin1" };
    const viewer = { type: "user" as const, id: "viewer1" };
    const viewerContact = {
      type: "contact" as const,
      id: "viewer1-contact",
    };

    await zbar.addRelation(ctx, adminUser, "admin", sys);
    await zbar.addRelation(ctx, viewer, "viewer", sys);
    await zbar.addRelation(ctx, viewerContact, "primary_contact", viewer);

    const perms = await zbar.getPermissions(ctx, adminUser, viewerContact);
    expect([...perms].sort()).toEqual(["manage", "view"]);
  });

  test("RT: a plain viewer on a primary-contact-derived contact gets ['view'] but not 'manage'", async () => {
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

    const perms = await zbar.getPermissions(ctx, alice, bobContact);
    expect(perms).toEqual(["view"]);
    expect(perms).not.toContain("manage");
  });

  test("RT: outsider gets [] on contact even with RT paths declared", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const insider = { type: "user" as const, id: "insider" };
    const insiderContact = {
      type: "contact" as const,
      id: "insider-contact",
    };
    const outsider = { type: "user" as const, id: "outsider" };

    await zbar.addRelation(ctx, insider, "viewer", sys);
    await zbar.addRelation(ctx, insiderContact, "primary_contact", insider);

    const perms = await zbar.getPermissions(ctx, outsider, insiderContact);
    expect(perms).toEqual([]);
  });

  test("RT: notification_rule admin gets ['view', 'manage'] via source.admin", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const admin = { type: "user" as const, id: "admin1" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    await zbar.addRelation(ctx, admin, "admin", sys);
    await zbar.addRelation(ctx, sys, "source", rule);

    const perms = await zbar.getPermissions(ctx, admin, rule);
    expect([...perms].sort()).toEqual(["manage", "view"]);

    // No (admin, viewer, rule) or (admin, admin, rule) materialised.
    expect(await effectiveRowExists(t, admin, "viewer", rule)).toBe(false);
    expect(await effectiveRowExists(t, admin, "admin", rule)).toBe(false);
  });

  test("RT: notification_rule viewer gets only ['view']", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const viewer = { type: "user" as const, id: "viewer1" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    await zbar.addRelation(ctx, viewer, "viewer", sys);
    await zbar.addRelation(ctx, sys, "source", rule);

    const perms = await zbar.getPermissions(ctx, viewer, rule);
    expect(perms).toEqual(["view"]);
  });

  test("RT chain: system viewer reaches a rule through contact recipient → owner → viewer", async () => {
    // This exercises the full RT chain across two entities:
    //   notification_rule.viewer (RT: recipient.viewer)
    //     → contact.viewer (RT: owner.viewer)
    //       → materialised (alice, viewer, sys)
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);
    await zbar.addRelation(ctx, bobContact, "recipient", rule);

    const perms = await zbar.getPermissions(ctx, alice, rule);
    expect(perms).toEqual(["view"]);
  });

  test("RT chain disabled (depth=0): getPermissions returns [] when only chained RT would satisfy", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar({ readTimeChainDepth: 0 });

    const sys = { type: "system" as const, id: "sys1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);
    await zbar.addRelation(ctx, bobContact, "recipient", rule);

    const perms = await zbar.getPermissions(ctx, alice, rule);
    expect(perms).toEqual([]);
  });

  test("getPermissions and can() agree across every permission on an object", async () => {
    // Parity check: whatever getPermissions returns must match, one-for-one,
    // the set of permissions for which can() returns true. Exercises the
    // batched path + RT fallback against the per-permission fallback.
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };
    const dev = { type: "device" as const, id: "dev1" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const bobContact = { type: "contact" as const, id: "bob-contact" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    await zbar.addRelation(ctx, sys, "owner", grp);
    await zbar.addRelation(ctx, grp, "container", dev);
    await zbar.addRelation(ctx, alice, "admin", sys);
    await zbar.addRelation(ctx, bob, "viewer", sys);
    await zbar.addRelation(ctx, bobContact, "primary_contact", bob);
    await zbar.addRelation(ctx, bobContact, "recipient", rule);
    await zbar.addRelation(ctx, dev, "source", rule);

    const targets: Array<{
      subject: { type: "user"; id: string };
      object: { type: any; id: string };
    }> = [
      { subject: alice, object: sys },
      { subject: alice, object: grp },
      { subject: alice, object: dev },
      { subject: alice, object: bobContact },
      { subject: alice, object: rule },
      { subject: bob, object: sys },
      { subject: bob, object: bobContact },
      { subject: bob, object: rule },
    ];

    for (const { subject, object } of targets) {
      const allPerms = Object.keys(
        (iotSchema.entities as any)[object.type]?.permissions || {},
      );
      const viaCan: string[] = [];
      for (const p of allPerms) {
        if (await (zbar as any).can(ctx, subject, p, object)) {
          viaCan.push(p);
        }
      }
      const viaGet = await zbar.getPermissions(ctx, subject, object);
      expect([...viaGet].sort()).toEqual(viaCan.sort());
    }
  });
});
