import { expect, test, describe } from "vitest";
import { Zbar, createZbarSchema } from "../index.js";
import { convexTest } from "convex-test";
import schema from "../../component/schema.js";
import { api } from "../../component/_generated/api.js";
import { register as registerWorkpool } from "@convex-dev/workpool/test";

const setup = () => {
  const t = convexTest(schema, import.meta.glob("../../component/**/*.ts"));
  registerWorkpool(t, "workpool");
  return t;
};

// ============================================================================
// Shared schemas
// ============================================================================

const iotSchema = createZbarSchema<any>()
  .entity("user")
  .entity("group", (e) => e.relation("member", "user"))
  .entity("system", (e) =>
    e
      .relation("owner", "user")
      .relation("admin", "user", "owner")
      .relation("viewer", "user", "admin")
      .permission("view", "viewer")
      .permission("manage", "admin"),
  )
  .entity("device", (e) =>
    e
      .relation("admin", "user", "system#admin")
      .relation("viewer", "user", "admin", "system#viewer")
      .permission("view", "viewer")
      .permission("manage", "admin"),
  )
  .build();

const orgSchema = createZbarSchema<any>()
  .entity("user")
  .entity("org", (e) =>
    e
      .relation("owner", "user")
      .relation("admin", "user", "owner")
      .relation("viewer", "user", "admin")
      .permission("edit_settings", "admin")
      .permission("view_dashboard", "viewer"),
  )
  .build();

const mkCtx = (t: any) =>
  ({
    runQuery: t.query.bind(t),
    runMutation: t.mutation.bind(t),
  }) as any;

// ============================================================================
// .list() — Effective relationship queries
// ============================================================================

describe("Fluent .list() Query Builder", () => {
  const mkZbar = () =>
    new Zbar(api, {
      schema: iotSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

  // ---- Listing objects ----

  test("list objects by permission", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const dev1 = { type: "device" as const, id: "dev1" };
    const dev2 = { type: "device" as const, id: "dev2" };

    await zbar.addRelation(ctx, alice, "admin", sys1);
    await zbar.addRelation(ctx, sys1, "admin", dev1);
    await zbar.addRelation(ctx, sys1, "admin", dev2);

    const result = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject({ type: "user", id: "alice" })
      .collect(ctx);

    expect(result.map((d) => d.objectId).sort()).toEqual(["dev1", "dev2"]);
  });

  test("list objects by relation", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const dev1 = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "admin", sys1);
    await zbar.addRelation(ctx, sys1, "admin", dev1);

    const result = await zbar
      .list()
      .object("device")
      .relation("admin")
      .subject({ type: "user", id: "alice" })
      .collect(ctx);

    expect(result.map((d) => d.objectId)).toEqual(["dev1"]);
  });

  // ---- Listing subjects ----

  test("list subjects by permission", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const sys2 = { type: "system" as const, id: "sys2" };
    const dev1 = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "admin", sys1);
    await zbar.addRelation(ctx, bob, "admin", sys2);
    await zbar.addRelation(ctx, sys1, "admin", dev1);
    await zbar.addRelation(ctx, sys2, "admin", dev1);

    const result = await zbar
      .list()
      .object({ type: "device", id: "dev1" })
      .permission("view")
      .subject("user")
      .collect(ctx);

    expect(result.map((u) => u.subjectId).sort()).toEqual(["alice", "bob"]);
  });

  test("list subjects by relation", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const dev1 = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "admin", dev1);
    await zbar.addRelation(ctx, bob, "admin", dev1);

    const result = await zbar
      .list()
      .object({ type: "device", id: "dev1" })
      .relation("admin")
      .subject("user")
      .collect(ctx);

    expect(result.map((u) => u.subjectId).sort()).toEqual(["alice", "bob"]);
  });

  // ---- .via() ----

  test("single via: lists objects reachable from via entity", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const sys2 = { type: "system" as const, id: "sys2" };
    const dev1 = { type: "device" as const, id: "dev1" };
    const dev2 = { type: "device" as const, id: "dev2" };
    const dev3 = { type: "device" as const, id: "dev3" };

    await zbar.addRelation(ctx, alice, "admin", sys1);
    await zbar.addRelation(ctx, alice, "admin", sys2);
    await zbar.addRelation(ctx, sys1, "admin", dev1);
    await zbar.addRelation(ctx, sys1, "admin", dev2);
    await zbar.addRelation(ctx, sys2, "admin", dev2);
    await zbar.addRelation(ctx, sys2, "admin", dev3);

    const viaSys1 = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject({ type: "user", id: "alice" })
      .via({ type: "system", id: "sys1" })
      .collect(ctx);
    expect(viaSys1.map((d) => d.objectId).sort()).toEqual(["dev1", "dev2"]);

    const viaSys2 = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject({ type: "user", id: "alice" })
      .via({ type: "system", id: "sys2" })
      .collect(ctx);
    expect(viaSys2.map((d) => d.objectId).sort()).toEqual(["dev2", "dev3"]);
  });

  test("chained via: alice → group → system → devices", async () => {
    const t = setup();
    const ctx = mkCtx(t);

    const chainSchema = createZbarSchema<any>()
      .entity("user")
      .entity("group", (e) =>
        e.relation("member", "user"),
      )
      .entity("system", (e) =>
        e
          .relation("admin", "user", "group#member")
          .relation("viewer", "user", "admin"),
      )
      .entity("device", (e) =>
        e
          .relation("admin", "user", "system#admin")
          .relation("viewer", "user", "admin", "system#viewer")
          .permission("view", "viewer")
          .permission("manage", "admin"),
      )
      .build();

    const zbar = new Zbar(api, {
      schema: chainSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const alice = { type: "user" as const, id: "alice" };
    const grp1 = { type: "group" as const, id: "grp1" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const dev1 = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "member", grp1);
    await zbar.addRelation(ctx, grp1, "admin", sys1);
    await zbar.addRelation(ctx, sys1, "admin", dev1);

    const result = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject(alice)
      .via(grp1, sys1)
      .collect(ctx);
    expect(result.map((d) => d.objectId)).toEqual(["dev1"]);
  });

  test("chained via: broken link returns empty", async () => {
    const t = setup();
    const ctx = mkCtx(t);

    const chainSchema = createZbarSchema<any>()
      .entity("user")
      .entity("group", (e) =>
        e.relation("member", "user"),
      )
      .entity("system", (e) =>
        e
          .relation("admin", "user", "group#member")
          .relation("viewer", "user", "admin"),
      )
      .entity("device", (e) =>
        e
          .relation("admin", "user", "system#admin")
          .relation("viewer", "user", "admin", "system#viewer")
          .permission("view", "viewer")
          .permission("manage", "admin"),
      )
      .build();

    const zbar = new Zbar(api, {
      schema: chainSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const alice = { type: "user" as const, id: "alice" };
    const grp1 = { type: "group" as const, id: "grp1" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const dev1 = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "member", grp1);
    await zbar.addRelation(ctx, sys1, "admin", dev1);

    const result = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject(alice)
      .via(grp1, sys1)
      .collect(ctx);
    expect(result).toEqual([]);
  });

  test("via: list subjects", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const sys2 = { type: "system" as const, id: "sys2" };
    const dev1 = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "admin", sys1);
    await zbar.addRelation(ctx, bob, "admin", sys2);
    await zbar.addRelation(ctx, sys1, "admin", dev1);
    await zbar.addRelation(ctx, sys2, "admin", dev1);

    const viaSys1 = await zbar
      .list()
      .object({ type: "device", id: "dev1" })
      .permission("view")
      .subject("user")
      .via({ type: "system", id: "sys1" })
      .collect(ctx);

    expect(viaSys1.map((u) => u.subjectId)).toEqual(["alice"]);
  });

  test("via: list objects with relation filter", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const dev1 = { type: "device" as const, id: "dev1" };
    const dev2 = { type: "device" as const, id: "dev2" };

    await zbar.addRelation(ctx, alice, "admin", sys1);
    await zbar.addRelation(ctx, sys1, "admin", dev1);
    await zbar.addRelation(ctx, alice, "admin", dev2); // direct

    const viaSys1 = await zbar
      .list()
      .object("device")
      .relation("admin")
      .subject({ type: "user", id: "alice" })
      .via({ type: "system", id: "sys1" })
      .collect(ctx);

    expect(viaSys1.map((d) => d.objectId)).toEqual(["dev1"]);
  });

  test("via: list subjects with relation filter", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const dev1 = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "admin", sys1);
    await zbar.addRelation(ctx, sys1, "admin", dev1);
    await zbar.addRelation(ctx, bob, "admin", dev1); // direct

    const viaSys1 = await zbar
      .list()
      .object({ type: "device", id: "dev1" })
      .relation("admin")
      .subject("user")
      .via({ type: "system", id: "sys1" })
      .collect(ctx);

    expect(viaSys1.map((u) => u.subjectId)).toEqual(["alice"]);
  });

  // ---- Edge cases ----

  test("via with non-matching intermediate returns empty", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const sys2 = { type: "system" as const, id: "sys2" };
    const dev1 = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "admin", sys1);
    await zbar.addRelation(ctx, sys1, "admin", dev1);

    const viaSys2 = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject(alice)
      .via(sys2)
      .collect(ctx);

    expect(viaSys2).toEqual([]);
  });

  test("tight gate: viewer of system does not get manage permission on devices", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const dev1 = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "viewer", sys1);
    await zbar.addRelation(ctx, sys1, "admin", dev1);

    const viewResult = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject(alice)
      .via(sys1)
      .collect(ctx);
    expect(viewResult.map((d) => d.objectId)).toEqual(["dev1"]);

    const manageResult = await zbar
      .list()
      .object("device")
      .permission("manage")
      .subject(alice)
      .via(sys1)
      .collect(ctx);
    expect(manageResult).toEqual([]);
  });

  test("via gate-check: subject with no relationship to via entity returns empty", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const dev1 = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "admin", dev1);
    await zbar.addRelation(ctx, sys1, "admin", dev1);

    const withoutVia = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject(alice)
      .collect(ctx);
    expect(withoutVia.map((d) => d.objectId)).toEqual(["dev1"]);

    const viaSys1 = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject(alice)
      .via(sys1)
      .collect(ctx);
    expect(viaSys1).toEqual([]);
  });

  // ---- .map() ----

  test(".map() transforms results in parallel", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const dev1 = { type: "device" as const, id: "dev1" };
    const dev2 = { type: "device" as const, id: "dev2" };

    await zbar.addRelation(ctx, alice, "admin", sys1);
    await zbar.addRelation(ctx, sys1, "admin", dev1);
    await zbar.addRelation(ctx, sys1, "admin", dev2);

    const ids = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject(alice)
      .map((d) => d.objectId.toUpperCase())
      .collect(ctx);

    expect(ids.sort()).toEqual(["DEV1", "DEV2"]);
  });

  test(".map() works with async mapper", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const dev1 = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "admin", sys1);
    await zbar.addRelation(ctx, sys1, "admin", dev1);

    const results = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject(alice)
      .map(async (d) => ({ id: d.objectId, fetched: true }))
      .collect(ctx);

    expect(results).toEqual([{ id: "dev1", fetched: true }]);
  });

  test(".map() works after .via()", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const dev1 = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "admin", sys1);
    await zbar.addRelation(ctx, sys1, "admin", dev1);

    const ids = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject(alice)
      .via(sys1)
      .map((d) => d.objectId)
      .collect(ctx);

    expect(ids).toEqual(["dev1"]);
  });

  test(".map() works for listing subjects", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const dev1 = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "admin", dev1);

    const ids = await zbar
      .list()
      .object(dev1)
      .relation("admin")
      .subject("user")
      .map((s) => s.subjectId)
      .collect(ctx);

    expect(ids).toEqual(["alice"]);
  });
});

// ============================================================================
// .listDirect() — Base relationship queries
// ============================================================================

describe("Fluent .listDirect() Query Builder", () => {
  const mkZbar = () =>
    new Zbar(api, {
      schema: orgSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

  test("object({type,id}) returns all direct relationships for that object", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, alice, "owner", org);
    await zbar.addRelation(ctx, bob, "viewer", org);

    const rels = await zbar.listDirect().object(org).collect(ctx);

    expect(rels.length).toBe(2);
    expect(
      rels.map((r) => `${r.subject.id}:${r.relation}`).sort(),
    ).toEqual(["alice:owner", "bob:viewer"]);
  });

  test("subject({type,id}) returns all direct relationships for that subject", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const org1 = { type: "org" as const, id: "org1" };
    const org2 = { type: "org" as const, id: "org2" };

    await zbar.addRelation(ctx, alice, "owner", org1);
    await zbar.addRelation(ctx, alice, "viewer", org2);

    const rels = await zbar.listDirect().subject(alice).collect(ctx);

    expect(rels.length).toBe(2);
    expect(
      rels.map((r) => `${r.object.id}:${r.relation}`).sort(),
    ).toEqual(["org1:owner", "org2:viewer"]);
  });

  test("object + subject returns direct relationships between the pair", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, alice, "owner", org);
    await zbar.addRelation(ctx, bob, "viewer", org);

    const rels = await zbar.listDirect().object(org).subject(alice).collect(ctx);

    expect(rels.length).toBe(1);
    expect(rels[0].relation).toBe("owner");
  });

  test(".relation() filters with inheritance", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, alice, "owner", org);
    await zbar.addRelation(ctx, bob, "viewer", org);

    const viewers = await zbar.listDirect().object(org).relation("viewer").collect(ctx);
    expect(viewers.length).toBe(2);
    expect(viewers.map((r) => r.subject.id).sort()).toEqual(["alice", "bob"]);

    const admins = await zbar.listDirect().object(org).relation("admin").collect(ctx);
    expect(admins.length).toBe(1);
    expect(admins[0].subject.id).toBe("alice");

    const owners = await zbar.listDirect().object(org).relation("owner").collect(ctx);
    expect(owners.length).toBe(1);
    expect(owners[0].subject.id).toBe("alice");
  });

  test(".permission() filters by permission-contributing relations", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, alice, "owner", org);
    await zbar.addRelation(ctx, bob, "viewer", org);

    const editors = await zbar.listDirect().object(org).permission("edit_settings").collect(ctx);
    expect(editors.length).toBe(1);
    expect(editors[0].subject.id).toBe("alice");

    const dashViewers = await zbar
      .listDirect()
      .object(org)
      .permission("view_dashboard")
      .collect(ctx);
    expect(dashViewers.length).toBe(2);
  });

  test("object(type) filters by object type only", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const org1 = { type: "org" as const, id: "org1" };
    const org2 = { type: "org" as const, id: "org2" };

    await zbar.addRelation(ctx, alice, "owner", org1);
    await zbar.addRelation(ctx, alice, "viewer", org2);

    const rels = await zbar
      .listDirect()
      .subject(alice)
      .object("org")
      .collect(ctx);

    expect(rels.length).toBe(2);
  });

  test("subject(type) filters by subject type only", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, alice, "owner", org);
    await zbar.addRelation(ctx, bob, "viewer", org);

    const rels = await zbar
      .listDirect()
      .object(org)
      .subject("user")
      .collect(ctx);

    expect(rels.length).toBe(2);
  });

  test("no object or subject returns empty", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const result = await (zbar.listDirect() as any).collect(ctx);
    expect(result).toEqual([]);
  });

  test(".map() transforms results", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, alice, "owner", org);
    await zbar.addRelation(ctx, bob, "viewer", org);

    const summaries = await zbar
      .listDirect()
      .object(org)
      .map((r) => `${r.subject.id} is ${r.relation}`)
      .collect(ctx);

    expect(summaries.sort()).toEqual([
      "alice is owner",
      "bob is viewer",
    ]);
  });

  test(".map() works with async mapper", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, alice, "owner", org);

    const results = await zbar
      .listDirect()
      .object(org)
      .map(async (r) => ({ who: r.subject.id, role: r.relation }))
      .collect(ctx);

    expect(results).toEqual([{ who: "alice", role: "owner" }]);
  });

  test("result shape includes full subject and object", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, alice, "owner", org);

    const [rel] = await zbar.listDirect().object(org).collect(ctx);

    expect(rel).toEqual({
      subject: { type: "user", id: "alice" },
      relation: "owner",
      object: { type: "org", id: "org1" },
    });
  });
});
