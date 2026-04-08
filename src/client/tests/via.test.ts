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
  .entity("system", (e) =>
    e
      .relation("owner", "user")
      .relation("admin", "user", "owner")
      .relation("viewer", "user", "admin")
      .permission("view", "viewer")
      .permission("manage", "admin")
      .permission("own", "owner")
      .permission("list_devices", "viewer"),
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

describe("Via (Intermediary Filtering)", () => {
  test("listAccessibleObjectsVia filters devices by intermediate system", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const sys2 = { type: "system" as const, id: "sys2" };
    const dev1 = { type: "device" as const, id: "dev1" };
    const dev2 = { type: "device" as const, id: "dev2" };
    const dev3 = { type: "device" as const, id: "dev3" };

    // Alice is admin of sys1 and sys2
    await zbar.addRelation(ctx, alice, "admin", sys1);
    await zbar.addRelation(ctx, alice, "admin", sys2);

    // sys1 is admin of dev1 and dev2 (userset)
    await zbar.addRelation(ctx, sys1, "admin", dev1);
    await zbar.addRelation(ctx, sys1, "admin", dev2);

    // sys2 is admin of dev2 and dev3 (userset)
    await zbar.addRelation(ctx, sys2, "admin", dev3);
    await zbar.addRelation(ctx, sys2, "admin", dev2);

    // Without via: Alice can view all 3 devices
    const allDevices = await zbar.listAccessibleObjects(
      ctx,
      alice,
      "view",
      "device",
    );
    expect(allDevices.map((d) => d.objectId).sort()).toEqual([
      "dev1",
      "dev2",
      "dev3",
    ]);

    // Via sys1: Alice can view dev1 and dev2 through sys1
    const viaSys1 = await zbar.listAccessibleObjectsVia(
      ctx,
      alice,
      "view",
      "device",
      [sys1],
    );
    expect(viaSys1.map((d) => d.objectId).sort()).toEqual(["dev1", "dev2"]);

    // Via sys2: Alice can view dev2 and dev3 through sys2
    const viaSys2 = await zbar.listAccessibleObjectsVia(
      ctx,
      alice,
      "view",
      "device",
      [sys2],
    );
    expect(viaSys2.map((d) => d.objectId).sort()).toEqual(["dev2", "dev3"]);

    // Via both sys1 AND sys2: only dev2 is reachable through both
    const viaBoth = await zbar.listAccessibleObjectsVia(
      ctx,
      alice,
      "view",
      "device",
      [sys1, sys2],
    );
    expect(viaBoth.map((d) => d.objectId).sort()).toEqual(["dev2"]);
  });

  test("listObjectsWithRelationVia filters devices by intermediate system", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const dev1 = { type: "device" as const, id: "dev1" };
    const dev2 = { type: "device" as const, id: "dev2" };

    // Alice is admin of sys1
    await zbar.addRelation(ctx, alice, "admin", sys1);

    // sys1 links to dev1 (userset admin)
    await zbar.addRelation(ctx, sys1, "admin", dev1);

    // Alice is DIRECTLY admin of dev2
    await zbar.addRelation(ctx, alice, "admin", dev2);

    // Without via: Alice is admin of both
    const all = await zbar.listObjectsWithRelation(
      ctx,
      alice,
      "admin",
      "device",
    );
    expect(all.map((d) => d.objectId).sort()).toEqual(["dev1", "dev2"]);

    // Via sys1: only dev1 goes through sys1
    const viaSys1 = await zbar.listObjectsWithRelationVia(
      ctx,
      alice,
      "admin",
      "device",
      [sys1],
    );
    expect(viaSys1.map((d) => d.objectId).sort()).toEqual(["dev1"]);
  });

  test("listSubjectsWithAccessVia filters users by intermediate system", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const sys2 = { type: "system" as const, id: "sys2" };
    const dev1 = { type: "device" as const, id: "dev1" };

    // Alice is admin of sys1, Bob is admin of sys2
    await zbar.addRelation(ctx, alice, "admin", sys1);
    await zbar.addRelation(ctx, bob, "admin", sys2);

    // Both systems link to dev1
    await zbar.addRelation(ctx, sys1, "admin", dev1);
    await zbar.addRelation(ctx, sys2, "admin", dev1);

    // Without via: both Alice and Bob can view dev1
    const allUsers = await zbar.listSubjectsWithAccess(
      ctx,
      "user",
      "view",
      dev1,
    );
    expect(allUsers.map((u) => u.subjectId).sort()).toEqual(["alice", "bob"]);

    // Via sys1: only Alice accesses dev1 through sys1
    const viaSys1 = await zbar.listSubjectsWithAccessVia(
      ctx,
      "user",
      "view",
      dev1,
      [sys1],
    );
    expect(viaSys1.map((u) => u.subjectId).sort()).toEqual(["alice"]);

    // Via sys2: only Bob accesses dev1 through sys2
    const viaSys2 = await zbar.listSubjectsWithAccessVia(
      ctx,
      "user",
      "view",
      dev1,
      [sys2],
    );
    expect(viaSys2.map((u) => u.subjectId).sort()).toEqual(["bob"]);
  });

  test("listSubjectsWithRelationVia filters users by intermediate system", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const dev1 = { type: "device" as const, id: "dev1" };

    // Alice is admin of sys1
    await zbar.addRelation(ctx, alice, "admin", sys1);

    // sys1 links to dev1
    await zbar.addRelation(ctx, sys1, "admin", dev1);

    // Bob is DIRECTLY admin of dev1
    await zbar.addRelation(ctx, bob, "admin", dev1);

    // Without via: both are admins
    const all = await zbar.listSubjectsWithRelation(
      ctx,
      "user",
      "admin",
      dev1,
    );
    expect(all.map((u) => u.subjectId).sort()).toEqual(["alice", "bob"]);

    // Via sys1: only Alice's access goes through sys1
    const viaSys1 = await zbar.listSubjectsWithRelationVia(
      ctx,
      "user",
      "admin",
      dev1,
      [sys1],
    );
    expect(viaSys1.map((u) => u.subjectId).sort()).toEqual(["alice"]);
  });

  test("empty via array returns unfiltered results", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const dev1 = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "admin", sys1);
    await zbar.addRelation(ctx, sys1, "admin", dev1);

    const withEmptyVia = await zbar.listAccessibleObjectsVia(
      ctx,
      alice,
      "view",
      "device",
      [],
    );
    const withoutVia = await zbar.listAccessibleObjects(
      ctx,
      alice,
      "view",
      "device",
    );

    expect(withEmptyVia).toEqual(withoutVia);
  });

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
    const viaSys2 = await zbar.listAccessibleObjectsVia(
      ctx,
      alice,
      "view",
      "device",
      [sys2],
    );
    expect(viaSys2).toEqual([]);
  });
});
