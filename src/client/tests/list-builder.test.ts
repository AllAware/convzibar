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

const mkCtx = (t: any) =>
  ({
    runQuery: t.query.bind(t),
    runMutation: t.mutation.bind(t),
  }) as any;

const mkZbar = () =>
  new Zbar(api, {
    schema: iotSchema,
    tenantId: "t1",
    asyncWrites: false,
  });

describe("Fluent List Query Builder", () => {
  // ---- Listing objects with permission ----
  test("list().object(type).permission().subject({type,id}).collect() — listAccessibleObjects", async () => {
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

  // ---- Listing objects with relation ----
  test("list().object(type).relation().subject({type,id}).collect() — listObjectsWithRelation", async () => {
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

  // ---- Listing subjects with permission ----
  test("list().object({type,id}).permission().subject(type).collect() — listSubjectsWithAccess", async () => {
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

  // ---- Listing subjects with relation ----
  test("list().object({type,id}).relation().subject(type).collect() — listSubjectsWithRelation", async () => {
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

  // ---- With .via() ----
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

    // Via sys1: alice → sys1 → {dev1, dev2}
    const viaSys1 = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject({ type: "user", id: "alice" })
      .via({ type: "system", id: "sys1" })
      .collect(ctx);
    expect(viaSys1.map((d) => d.objectId).sort()).toEqual(["dev1", "dev2"]);

    // Via sys2: alice → sys2 → {dev2, dev3}
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

    // Schema that supports user → group → system → device chain
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

    // Chain: alice → grp1 (member) → sys1 (admin via group#member) → dev1
    await zbar.addRelation(ctx, alice, "member", grp1);
    await zbar.addRelation(ctx, grp1, "admin", sys1);
    await zbar.addRelation(ctx, sys1, "admin", dev1);

    // Via chain [grp1, sys1]: alice → grp1 → sys1 → dev1
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

    // alice → grp1 (member), but grp1 has NO link to sys1
    await zbar.addRelation(ctx, alice, "member", grp1);
    await zbar.addRelation(ctx, sys1, "admin", dev1);

    // Chain is broken at grp1 → sys1 → return []
    const result = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject(alice)
      .via(grp1, sys1)
      .collect(ctx);
    expect(result).toEqual([]);
  });

  test("list().object({type,id}).permission().subject(type).via().collect() — listSubjectsWithAccessVia", async () => {
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

    // Via sys1: only Alice
    const viaSys1 = await zbar
      .list()
      .object({ type: "device", id: "dev1" })
      .permission("view")
      .subject("user")
      .via({ type: "system", id: "sys1" })
      .collect(ctx);

    expect(viaSys1.map((u) => u.subjectId)).toEqual(["alice"]);
  });

  test("list().object(type).relation().subject().via().collect() — listObjectsWithRelationVia", async () => {
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

    // Only dev1 goes through sys1; dev2 is direct
    expect(viaSys1.map((d) => d.objectId)).toEqual(["dev1"]);
  });

  test("list().object({type,id}).relation().subject(type).via().collect() — listSubjectsWithRelationVia", async () => {
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

    // Alice → sys1 → dev1
    await zbar.addRelation(ctx, alice, "admin", sys1);
    await zbar.addRelation(ctx, sys1, "admin", dev1);

    // Filter through sys2 (which has no link to dev1)
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

    // Alice is only viewer of sys1 (not admin or owner)
    await zbar.addRelation(ctx, alice, "viewer", sys1);
    // sys1 is admin of dev1
    await zbar.addRelation(ctx, sys1, "admin", dev1);

    // Alice CAN view devices via sys1 (device.viewer includes system#viewer,
    // and viewer inherits from admin on system, so alice as viewer of sys1
    // gets device viewer through system#viewer userset)
    const viewResult = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject(alice)
      .via(sys1)
      .collect(ctx);
    expect(viewResult.map((d) => d.objectId)).toEqual(["dev1"]);

    // Alice CANNOT manage devices via sys1 (device.admin includes
    // system#admin, but alice is only viewer — not admin — of sys1)
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

    // Alice is DIRECTLY admin of dev1 (not through sys1)
    await zbar.addRelation(ctx, alice, "admin", dev1);
    // sys1 is also admin of dev1 — but Alice has NO relationship to sys1
    await zbar.addRelation(ctx, sys1, "admin", dev1);

    // Without via: Alice can view dev1 (direct access)
    const withoutVia = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject(alice)
      .collect(ctx);
    expect(withoutVia.map((d) => d.objectId)).toEqual(["dev1"]);

    // With via sys1: Alice has no relationship to sys1, so no access
    // flows THROUGH sys1 — gate check should short-circuit to empty.
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

    // .map() transforms each result and runs in parallel
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
      .map(async (d) => {
        // Simulate async work
        return { id: d.objectId, fetched: true };
      })
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

  test("collect without via returns all results", async () => {
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
      .permission("view")
      .subject(alice)
      .collect(ctx);

    expect(result.length).toBe(1);
    expect(result[0].objectId).toBe("dev1");
  });
});
