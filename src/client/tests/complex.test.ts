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

async function assertDbState(
  t: any,
  expectedRelationships: number,
  expectedEffectiveRelationships: number,
) {
  const relationships = await t.run(
    async (innerCtx: any) => await innerCtx.db.query("relationships").collect(),
  );
  const effectiveRelationships = await t.run(
    async (innerCtx: any) =>
      await innerCtx.db.query("effectiveRelationships").collect(),
  );

  expect(relationships.length).toBe(expectedRelationships);
  expect(effectiveRelationships.length).toBe(expectedEffectiveRelationships);
}

const complexSchema = createZbarSchema<any>()
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
      .relation("owned_by", "system")
      .relation("viewer", "user", "owned_by.viewer")
      .relation("manager", "user", "owned_by.admin")
      .permission("view", "viewer")
      .permission("manage", "manager"),
  )
  .build();

describe("Complex Schema Inheritance Flows", () => {
  test("User -> System -> Device inheritance flow", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: complexSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const ownerUser = { type: "user" as const, id: "u_owner" };
    const adminUser = { type: "user" as const, id: "u_admin" };
    const viewerUser = { type: "user" as const, id: "u_viewer" };
    const noAccessUser = { type: "user" as const, id: "u_none" };

    const sys = { type: "system" as const, id: "sys1" };
    const device1 = { type: "device" as const, id: "d1" };
    const device2 = { type: "device" as const, id: "d2" };

    // 1. Setup the basic graph
    await zbar.addRelation(ctx, ownerUser, "owner", sys);
    await zbar.addRelation(ctx, adminUser, "admin", sys);
    await zbar.addRelation(ctx, viewerUser, "viewer", sys);

    // Link devices to system (Note: Subject=Device, Relation=owned_by, Object=System)
    await zbar.addRelation(ctx, sys, "owned_by", device1);
    await zbar.addRelation(ctx, sys, "owned_by", device2);

    // 2. Verify System-level permissions via local inheritance

    // Owner should have everything
    expect(await zbar.can(ctx, ownerUser, "own", sys)).toBe(true);
    expect(await zbar.can(ctx, ownerUser, "manage", sys)).toBe(true);
    expect(await zbar.can(ctx, ownerUser, "view", sys)).toBe(true);

    // Admin should not have own, but should have manage and view
    expect(await zbar.can(ctx, adminUser, "own", sys)).toBe(false);
    expect(await zbar.can(ctx, adminUser, "manage", sys)).toBe(true);
    expect(await zbar.can(ctx, adminUser, "view", sys)).toBe(true);

    // Viewer should only have view
    expect(await zbar.can(ctx, viewerUser, "own", sys)).toBe(false);
    expect(await zbar.can(ctx, viewerUser, "manage", sys)).toBe(false);
    expect(await zbar.can(ctx, viewerUser, "view", sys)).toBe(true);

    // 3. Verify Device-level permissions via distant inheritance

    // Owner inherits viewer and manager on device
    expect(await zbar.can(ctx, ownerUser, "manage", device1)).toBe(true);
    expect(await zbar.can(ctx, ownerUser, "view", device1)).toBe(true);

    // Admin inherits viewer and manager on device
    expect(await zbar.can(ctx, adminUser, "manage", device1)).toBe(true);
    expect(await zbar.can(ctx, adminUser, "view", device1)).toBe(true);

    // Viewer inherits viewer, but not manager on device
    expect(await zbar.can(ctx, viewerUser, "manage", device1)).toBe(false);
    expect(await zbar.can(ctx, viewerUser, "view", device1)).toBe(true);

    // No access user has nothing
    expect(await zbar.can(ctx, noAccessUser, "view", device1)).toBe(false);
    expect(await zbar.can(ctx, noAccessUser, "manage", device1)).toBe(false);

    // 4. Test Listing Accessible Objects
    const devicesToManage = await zbar.listAccessibleObjects(
      ctx,
      adminUser,
      "manage",
      "device",
    );
    expect(devicesToManage.length).toBe(2);
    expect(devicesToManage.map((d) => d.objectId).sort()).toEqual(["d1", "d2"]);

    // 5. Test Relational Modifications Break Inference Safely
    // Remove the admin user
    await zbar.removeRelation(ctx, adminUser, "admin", sys);

    // Admin should no longer have access
    expect(await zbar.can(ctx, adminUser, "manage", sys)).toBe(false);
    expect(await zbar.can(ctx, adminUser, "manage", device1)).toBe(false);

    // Disconnect device 2
    await zbar.removeRelation(ctx, sys, "owned_by", device2);

    // Owner should still manage device 1, but not device 2
    expect(await zbar.can(ctx, ownerUser, "manage", device1)).toBe(true);
    expect(await zbar.can(ctx, ownerUser, "manage", device2)).toBe(false);

    // Verify DB state
    await assertDbState(t, 3, 6);
  });
});
