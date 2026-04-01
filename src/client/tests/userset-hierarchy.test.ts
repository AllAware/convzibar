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

// This is the user's proposed schema for IoT device management.
// Chain: system admin → group admin → group viewer → device
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
  .entity("group", (e) =>
    e
      .relation("admin", "user", "system#admin", "group#admin")
      .relation("viewer", "user", "admin", "system#viewer", "group#viewer")
      .permission("manage", "admin")
      .permission("view", "viewer"),
  )
  .entity("device", (e) =>
    e
      .relation("admin", "user", "system#admin", "group#admin")
      .relation("viewer", "user", "admin", "system#viewer", "group#viewer")
      .permission("view", "viewer")
      .permission("manage", "admin"),
  )
  .build();

const mkCtx = (t: any) =>
  ({
    runQuery: t.query.bind(t),
    runMutation: t.mutation.bind(t),
  }) as any;

const mkZbar = (ctx?: any) =>
  new Zbar(api, {
    schema: iotSchema,
    tenantId: "t1",
    asyncWrites: false,
  });

describe("IoT Schema: system → group → device hierarchy", () => {
  test("system admin becomes group admin via system#admin userset", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };

    await zbar.addRelation(ctx, alice, "admin", sys);
    await zbar.addRelation(ctx, sys, "admin", grp);

    // alice is admin of sys → system#admin userset → alice becomes admin of grp
    expect(await zbar.can(ctx, alice, "manage", grp)).toBe(true);
  });

  test("system owner inherits admin, which inherits into group admin via userset", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };

    // alice is owner of sys (owner → admin via local inheritance)
    await zbar.addRelation(ctx, alice, "owner", sys);
    await zbar.addRelation(ctx, sys, "admin", grp);

    // system#admin expands to ['admin', 'owner'] → finds alice's owner record
    expect(await zbar.can(ctx, alice, "manage", grp)).toBe(true);
  });

  test("system viewer becomes group viewer via system#viewer userset", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };

    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, sys, "viewer", grp);

    // alice is direct viewer of sys → system#viewer userset fires
    // group viewer does NOT imply group admin
    expect(await zbar.can(ctx, alice, "manage", grp)).toBe(false);
  });

  test("system admin becomes group viewer (admin ⊆ viewer on group)", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };

    await zbar.addRelation(ctx, alice, "admin", sys);
    // sys is added as admin of grp → alice becomes admin of grp
    await zbar.addRelation(ctx, sys, "admin", grp);

    // group admin ⊆ group viewer via local inheritance
    // so alice should also satisfy viewer checks
    expect(await zbar.can(ctx, alice, "manage", grp)).toBe(true);
  });

  test("full chain: system admin → group admin → device admin", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };
    const dev = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "admin", sys);
    await zbar.addRelation(ctx, sys, "admin", grp);
    await zbar.addRelation(ctx, grp, "admin", dev);

    // system admin → group admin → device admin
    expect(await zbar.can(ctx, alice, "manage", dev)).toBe(true);
    expect(await zbar.can(ctx, alice, "view", dev)).toBe(true);
  });

  test("full chain: system admin → group viewer → device viewer (NOT admin)", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };
    const dev = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "admin", sys);
    // sys is viewer of grp (not admin)
    await zbar.addRelation(ctx, sys, "viewer", grp);
    // grp is viewer of dev (not admin)
    await zbar.addRelation(ctx, grp, "viewer", dev);

    // system#viewer expands to ['viewer', 'admin', 'owner']
    // alice's admin record matches → alice becomes viewer of grp
    // group#viewer expands to ['viewer', 'admin']
    // alice only has viewer on grp → alice becomes viewer of dev
    expect(await zbar.can(ctx, alice, "view", dev)).toBe(true);
    expect(await zbar.can(ctx, alice, "manage", dev)).toBe(false);
  });

  test("group-to-group userset: nested group admin cascades to device", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const grpA = { type: "group" as const, id: "a" };
    const grpB = { type: "group" as const, id: "b" };
    const dev = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "admin", grpA);
    await zbar.addRelation(ctx, grpA, "admin", grpB);
    await zbar.addRelation(ctx, grpB, "admin", dev);

    // group#admin on grpB finds alice → group#admin on dev finds alice
    expect(await zbar.can(ctx, alice, "manage", dev)).toBe(true);
    expect(await zbar.can(ctx, alice, "view", dev)).toBe(true);
  });

  test("mixed chain: system admin → group admin → group viewer → device viewer", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys = { type: "system" as const, id: "sys1" };
    const grpA = { type: "group" as const, id: "a" };
    const grpB = { type: "group" as const, id: "b" };
    const dev = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "admin", sys);
    await zbar.addRelation(ctx, sys, "admin", grpA);     // sys admin → grpA admin
    await zbar.addRelation(ctx, grpA, "viewer", grpB);   // grpA viewer → grpB viewer
    await zbar.addRelation(ctx, grpB, "viewer", dev);     // grpB viewer → dev viewer

    // alice → admin sys → admin grpA → (admin ⊆ viewer) → viewer grpB → viewer dev
    expect(await zbar.can(ctx, alice, "view", dev)).toBe(true);
    // alice only has viewer on grpB, not admin → device admin should NOT propagate
    expect(await zbar.can(ctx, alice, "manage", dev)).toBe(false);
  });

  test("no privilege escalation: viewer userset does not grant admin", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };
    const dev = { type: "device" as const, id: "dev1" };

    // alice is only a viewer of sys
    await zbar.addRelation(ctx, alice, "viewer", sys);
    // sys is added as admin of grp — this should NOT make alice admin of grp
    // because system#admin expansion requires admin or owner records, not viewer
    await zbar.addRelation(ctx, sys, "admin", grp);
    await zbar.addRelation(ctx, grp, "admin", dev);

    // alice's viewer record on sys should NOT match system#admin expansion
    expect(await zbar.can(ctx, alice, "manage", grp)).toBe(false);
    expect(await zbar.can(ctx, alice, "manage", dev)).toBe(false);
  });

  test("removal at system level cascades through group to device", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };
    const dev = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "admin", sys);
    await zbar.addRelation(ctx, sys, "admin", grp);
    await zbar.addRelation(ctx, grp, "admin", dev);

    expect(await zbar.can(ctx, alice, "manage", dev)).toBe(true);

    // Remove alice from system
    await zbar.removeRelation(ctx, alice, "admin", sys);

    // Should cascade: alice loses admin on grp and dev
    expect(await zbar.can(ctx, alice, "manage", sys)).toBe(false);
    expect(await zbar.can(ctx, alice, "manage", grp)).toBe(false);
    expect(await zbar.can(ctx, alice, "manage", dev)).toBe(false);
  });

  test("removal of middle group link breaks the chain", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };
    const dev = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, alice, "admin", sys);
    await zbar.addRelation(ctx, sys, "admin", grp);
    await zbar.addRelation(ctx, grp, "admin", dev);

    expect(await zbar.can(ctx, alice, "manage", dev)).toBe(true);

    // Remove the system → group link
    await zbar.removeRelation(ctx, sys, "admin", grp);

    // alice keeps system admin, but loses group and device access
    expect(await zbar.can(ctx, alice, "manage", sys)).toBe(true);
    expect(await zbar.can(ctx, alice, "manage", grp)).toBe(false);
    expect(await zbar.can(ctx, alice, "manage", dev)).toBe(false);
  });

  test("multiple systems and groups: independent chains don't bleed", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const sys1 = { type: "system" as const, id: "sys1" };
    const sys2 = { type: "system" as const, id: "sys2" };
    const grp1 = { type: "group" as const, id: "grp1" };
    const grp2 = { type: "group" as const, id: "grp2" };
    const dev1 = { type: "device" as const, id: "dev1" };
    const dev2 = { type: "device" as const, id: "dev2" };

    // Chain 1: alice → sys1 → grp1 → dev1
    await zbar.addRelation(ctx, alice, "admin", sys1);
    await zbar.addRelation(ctx, sys1, "admin", grp1);
    await zbar.addRelation(ctx, grp1, "admin", dev1);

    // Chain 2: bob → sys2 → grp2 → dev2
    await zbar.addRelation(ctx, bob, "admin", sys2);
    await zbar.addRelation(ctx, sys2, "admin", grp2);
    await zbar.addRelation(ctx, grp2, "admin", dev2);

    // Each user should only have access to their own chain
    expect(await zbar.can(ctx, alice, "manage", dev1)).toBe(true);
    expect(await zbar.can(ctx, alice, "manage", dev2)).toBe(false);
    expect(await zbar.can(ctx, bob, "manage", dev1)).toBe(false);
    expect(await zbar.can(ctx, bob, "manage", dev2)).toBe(true);
  });

  test("ordering independence: device link before system user assignment", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };
    const dev = { type: "device" as const, id: "dev1" };

    // Build the chain bottom-up: device first, user last
    await zbar.addRelation(ctx, grp, "admin", dev);
    await zbar.addRelation(ctx, sys, "admin", grp);
    await zbar.addRelation(ctx, alice, "admin", sys);

    // Should still work regardless of insertion order
    expect(await zbar.can(ctx, alice, "manage", dev)).toBe(true);
  });

  test("validation: rejects invalid subject type for userset relation", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const dev = { type: "device" as const, id: "dev1" };
    const grp = { type: "group" as const, id: "grp1" };

    // device is not a valid subject for "admin" on group
    // (only user, system, and group are allowed)
    await expect(
      zbar.addRelation(ctx, dev, "admin" as any, grp),
    ).rejects.toThrow("Subject type 'device' is not a valid subject");
  });

  test("validation: accepts valid userset subject types", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys = { type: "system" as const, id: "sys1" };
    const grpA = { type: "group" as const, id: "a" };
    const grpB = { type: "group" as const, id: "b" };

    // All of these should be valid subjects for "admin" on group
    await expect(zbar.addRelation(ctx, alice, "admin", grpA)).resolves.toBeDefined();
    await expect(zbar.addRelation(ctx, sys, "admin", grpA)).resolves.toBeDefined();
    await expect(zbar.addRelation(ctx, grpB, "admin", grpA)).resolves.toBeDefined();
  });
});
