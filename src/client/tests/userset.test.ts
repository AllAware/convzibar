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

const mkCtx = (t: any) =>
  ({
    runQuery: t.query.bind(t),
    runMutation: t.mutation.bind(t),
  }) as any;

// ============================================================================
// Self-Referential Group Hierarchy (group#admin userset)
// ============================================================================

const groupSchema = createZbarSchema()
  .entity("user")
  .entity("group", (e) =>
    e
      .relation("admin", "user", "group#admin")
      .relation("member", "user", "admin", "group#member")
      .permission("manage", "admin")
      .permission("view", "member"),
  )
  .build();

describe("Userset: Self-Referential Group Hierarchy", () => {
  test("group admins inherit through group-as-admin", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, { schema: groupSchema, asyncWrites: false });

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const groupA = { type: "group" as const, id: "a" };
    const groupB = { type: "group" as const, id: "b" };

    await zbar.addRelation(ctx, alice, "admin", groupA);
    await zbar.addRelation(ctx, groupA, "admin", groupB);

    expect(await zbar.can(ctx, alice, "manage", groupB)).toBe(true);
    expect(await zbar.can(ctx, bob, "manage", groupB)).toBe(false);
  });

  test("adding user after group link propagates correctly", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, { schema: groupSchema, asyncWrites: false });

    const alice = { type: "user" as const, id: "alice" };
    const groupA = { type: "group" as const, id: "a" };
    const groupB = { type: "group" as const, id: "b" };

    await zbar.addRelation(ctx, groupA, "admin", groupB);
    await zbar.addRelation(ctx, alice, "admin", groupA);

    expect(await zbar.can(ctx, alice, "manage", groupB)).toBe(true);
  });

  test("three-level group hierarchy: A -> B -> C", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, { schema: groupSchema, asyncWrites: false });

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const groupA = { type: "group" as const, id: "a" };
    const groupB = { type: "group" as const, id: "b" };
    const groupC = { type: "group" as const, id: "c" };

    await zbar.addRelation(ctx, alice, "admin", groupA);
    await zbar.addRelation(ctx, groupA, "admin", groupB);
    await zbar.addRelation(ctx, groupB, "admin", groupC);
    await zbar.addRelation(ctx, bob, "admin", groupC);

    expect(await zbar.can(ctx, alice, "manage", groupA)).toBe(true);
    expect(await zbar.can(ctx, alice, "manage", groupB)).toBe(true);
    expect(await zbar.can(ctx, alice, "manage", groupC)).toBe(true);

    expect(await zbar.can(ctx, bob, "manage", groupA)).toBe(false);
    expect(await zbar.can(ctx, bob, "manage", groupB)).toBe(false);
    expect(await zbar.can(ctx, bob, "manage", groupC)).toBe(true);
  });

  test("removing group link cascades removal", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, { schema: groupSchema, asyncWrites: false });

    const alice = { type: "user" as const, id: "alice" };
    const groupA = { type: "group" as const, id: "a" };
    const groupB = { type: "group" as const, id: "b" };

    await zbar.addRelation(ctx, alice, "admin", groupA);
    await zbar.addRelation(ctx, groupA, "admin", groupB);
    expect(await zbar.can(ctx, alice, "manage", groupB)).toBe(true);

    await zbar.removeRelation(ctx, groupA, "admin", groupB);
    expect(await zbar.can(ctx, alice, "manage", groupB)).toBe(false);
    expect(await zbar.can(ctx, alice, "manage", groupA)).toBe(true);
  });

  test("removing user from parent group cascades through hierarchy", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, { schema: groupSchema, asyncWrites: false });

    const alice = { type: "user" as const, id: "alice" };
    const groupA = { type: "group" as const, id: "a" };
    const groupB = { type: "group" as const, id: "b" };

    await zbar.addRelation(ctx, alice, "admin", groupA);
    await zbar.addRelation(ctx, groupA, "admin", groupB);
    expect(await zbar.can(ctx, alice, "manage", groupB)).toBe(true);

    await zbar.removeRelation(ctx, alice, "admin", groupA);
    expect(await zbar.can(ctx, alice, "manage", groupA)).toBe(false);
    expect(await zbar.can(ctx, alice, "manage", groupB)).toBe(false);
  });

  test("member relation inherits through group userset", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, { schema: groupSchema, asyncWrites: false });

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const groupA = { type: "group" as const, id: "a" };
    const groupB = { type: "group" as const, id: "b" };

    await zbar.addRelation(ctx, alice, "member", groupA);
    await zbar.addRelation(ctx, bob, "admin", groupA);
    await zbar.addRelation(ctx, groupA, "member", groupB);

    expect(await zbar.can(ctx, alice, "view", groupB)).toBe(true);
    expect(await zbar.can(ctx, alice, "manage", groupB)).toBe(false);
    expect(await zbar.can(ctx, bob, "view", groupB)).toBe(true);
  });
});

// ============================================================================
// Cross-Entity Userset (Group as Folder Editor)
// ============================================================================

const folderSchema = createZbarSchema()
  .entity("user")
  .entity("group", (e) =>
    e.relation("admin", "user").relation("member", "user", "admin"),
  )
  .entity("folder", (e) =>
    e
      .relation("editor", "user", "group#member")
      .relation("viewer", "user", "editor")
      .permission("write", "editor")
      .permission("read", "viewer"),
  )
  .build();

describe("Userset: Cross-Entity (Group as Folder Editor)", () => {
  test("group members become folder editors via userset", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, { schema: folderSchema, asyncWrites: false });

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const devTeam = { type: "group" as const, id: "dev" };
    const docs = { type: "folder" as const, id: "docs" };

    await zbar.addRelation(ctx, alice, "member", devTeam);
    await zbar.addRelation(ctx, bob, "member", devTeam);
    await zbar.addRelation(ctx, devTeam, "editor", docs);

    expect(await zbar.can(ctx, alice, "write", docs)).toBe(true);
    expect(await zbar.can(ctx, bob, "write", docs)).toBe(true);
    expect(await zbar.can(ctx, alice, "read", docs)).toBe(true);
  });

  test("adding member to group after folder link propagates", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, { schema: folderSchema, asyncWrites: false });

    const alice = { type: "user" as const, id: "alice" };
    const devTeam = { type: "group" as const, id: "dev" };
    const docs = { type: "folder" as const, id: "docs" };

    await zbar.addRelation(ctx, devTeam, "editor", docs);
    await zbar.addRelation(ctx, alice, "member", devTeam);

    expect(await zbar.can(ctx, alice, "write", docs)).toBe(true);
  });

  test("removing group from folder removes member access", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, { schema: folderSchema, asyncWrites: false });

    const alice = { type: "user" as const, id: "alice" };
    const devTeam = { type: "group" as const, id: "dev" };
    const docs = { type: "folder" as const, id: "docs" };

    await zbar.addRelation(ctx, alice, "member", devTeam);
    await zbar.addRelation(ctx, devTeam, "editor", docs);
    expect(await zbar.can(ctx, alice, "write", docs)).toBe(true);

    await zbar.removeRelation(ctx, devTeam, "editor", docs);
    expect(await zbar.can(ctx, alice, "write", docs)).toBe(false);
  });

  test("group admin inherits member userset on folder", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, { schema: folderSchema, asyncWrites: false });

    const alice = { type: "user" as const, id: "alice" };
    const devTeam = { type: "group" as const, id: "dev" };
    const docs = { type: "folder" as const, id: "docs" };

    await zbar.addRelation(ctx, alice, "admin", devTeam);
    await zbar.addRelation(ctx, devTeam, "editor", docs);

    expect(await zbar.can(ctx, alice, "write", docs)).toBe(true);
  });
});

// ============================================================================
// IoT Hierarchy: system → group → device (userset chains)
// ============================================================================

const iotSchema = createZbarSchema()
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

describe("Userset: IoT Hierarchy (system → group → device)", () => {
  const mkZbar = () =>
    new Zbar(api, { schema: iotSchema, asyncWrites: false });

  test("system admin becomes group admin via system#admin userset", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };

    await zbar.addRelation(ctx, alice, "admin", sys);
    await zbar.addRelation(ctx, sys, "admin", grp);

    expect(await zbar.can(ctx, alice, "manage", grp)).toBe(true);
  });

  test("system owner inherits admin, which inherits into group admin via userset", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };

    await zbar.addRelation(ctx, alice, "owner", sys);
    await zbar.addRelation(ctx, sys, "admin", grp);

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

    expect(await zbar.can(ctx, alice, "manage", grp)).toBe(false);
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
    await zbar.addRelation(ctx, sys, "viewer", grp);
    await zbar.addRelation(ctx, grp, "viewer", dev);

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
    await zbar.addRelation(ctx, sys, "admin", grpA);
    await zbar.addRelation(ctx, grpA, "viewer", grpB);
    await zbar.addRelation(ctx, grpB, "viewer", dev);

    expect(await zbar.can(ctx, alice, "view", dev)).toBe(true);
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

    await zbar.addRelation(ctx, alice, "viewer", sys);
    await zbar.addRelation(ctx, sys, "admin", grp);
    await zbar.addRelation(ctx, grp, "admin", dev);

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

    await zbar.removeRelation(ctx, alice, "admin", sys);

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

    await zbar.removeRelation(ctx, sys, "admin", grp);

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

    await zbar.addRelation(ctx, alice, "admin", sys1);
    await zbar.addRelation(ctx, sys1, "admin", grp1);
    await zbar.addRelation(ctx, grp1, "admin", dev1);

    await zbar.addRelation(ctx, bob, "admin", sys2);
    await zbar.addRelation(ctx, sys2, "admin", grp2);
    await zbar.addRelation(ctx, grp2, "admin", dev2);

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

    await zbar.addRelation(ctx, grp, "admin", dev);
    await zbar.addRelation(ctx, sys, "admin", grp);
    await zbar.addRelation(ctx, alice, "admin", sys);

    expect(await zbar.can(ctx, alice, "manage", dev)).toBe(true);
  });

  test("validation: rejects invalid subject type for userset relation", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const dev = { type: "device" as const, id: "dev1" };
    const grp = { type: "group" as const, id: "grp1" };

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

    await expect(zbar.addRelation(ctx, alice, "admin", grpA)).resolves.toBeDefined();
    await expect(zbar.addRelation(ctx, sys, "admin", grpA)).resolves.toBeDefined();
    await expect(zbar.addRelation(ctx, grpB, "admin", grpA)).resolves.toBeDefined();
  });
});
