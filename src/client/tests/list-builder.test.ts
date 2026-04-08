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
  test("list().object(type).permission().subject().via().collect() — listAccessibleObjectsVia", async () => {
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

    // Via sys1 only
    const viaSys1 = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject({ type: "user", id: "alice" })
      .via({ type: "system", id: "sys1" })
      .collect(ctx);

    expect(viaSys1.map((d) => d.objectId).sort()).toEqual(["dev1", "dev2"]);

    // Via both sys1 AND sys2 — intersection
    const viaBoth = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject({ type: "user", id: "alice" })
      .via({ type: "system", id: "sys1" }, { type: "system", id: "sys2" })
      .collect(ctx);

    expect(viaBoth.map((d) => d.objectId).sort()).toEqual(["dev2"]);
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

  // ---- Equivalence with direct methods ----
  test("fluent builder matches direct method results exactly", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const dev1 = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "admin", sys1);
    await zbar.addRelation(ctx, sys1, "admin", dev1);

    // listAccessibleObjects
    const direct1 = await zbar.listAccessibleObjects(ctx, alice, "view", "device");
    const fluent1 = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject(alice)
      .collect(ctx);
    expect(fluent1).toEqual(direct1);

    // listObjectsWithRelation
    const direct2 = await zbar.listObjectsWithRelation(ctx, alice, "admin", "device");
    const fluent2 = await zbar
      .list()
      .object("device")
      .relation("admin")
      .subject(alice)
      .collect(ctx);
    expect(fluent2).toEqual(direct2);

    // listSubjectsWithAccess
    const direct3 = await zbar.listSubjectsWithAccess(ctx, "user", "view", dev1);
    const fluent3 = await zbar
      .list()
      .object(dev1)
      .permission("view")
      .subject("user")
      .collect(ctx);
    expect(fluent3).toEqual(direct3);

    // listSubjectsWithRelation
    const direct4 = await zbar.listSubjectsWithRelation(ctx, "user", "admin", dev1);
    const fluent4 = await zbar
      .list()
      .object(dev1)
      .relation("admin")
      .subject("user")
      .collect(ctx);
    expect(fluent4).toEqual(direct4);
  });
});
