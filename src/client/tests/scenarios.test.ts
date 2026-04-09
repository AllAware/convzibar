import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../../component/schema.js";
import { api } from "../../component/_generated/api.js";
import { createZbarSchema, Zbar } from "../index.js";
import { register as registerWorkpool } from "@convex-dev/workpool/test";

const modules = import.meta.glob("../../component/**/*.ts");
const TENANT = "test-tenant";

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

// ============================================================================
// Scenario: Google Drive-style sharing (ReBAC + hierarchy propagation)
// ============================================================================

const driveSchema = createZbarSchema<any>()
  .entity("user")
  .entity("account", (e) =>
    e.relation("admin", "user").relation("member", "user", "admin"),
  )
  .entity("folder", (e) =>
    e
      .relation("parent", "account")
      .relation("editor", "user", "parent.admin")
      .relation("viewer", "user", "editor", "parent.member"),
  )
  .entity("file", (e) =>
    e
      .relation("parent_folder", "folder")
      .relation("parent_account", "account")
      .relation("editor", "user", "parent_folder.editor")
      .relation(
        "viewer",
        "user",
        "editor",
        "parent_folder.viewer",
        "parent_account.member",
      )
      .permission("read", "viewer")
      .permission("write", "editor"),
  )
  .build();

describe("Scenario: Google Drive-style sharing", () => {
  test("supports direct file access, folder inheritance, account admin, and account-wide sharing", async () => {
    const t = setup();
    const ctx = mkCtx(t);

    const zbar = new Zbar(api, {
      schema: driveSchema,
      tenantId: TENANT,
      asyncWrites: false,
    });

    const account = { type: "account" as const, id: "acme" };
    const folder = { type: "folder" as const, id: "finance" };
    const file = { type: "file" as const, id: "2023_report" };

    const john = { type: "user" as const, id: "john" };
    const jane = { type: "user" as const, id: "jane" };
    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };

    await zbar.addRelation(ctx, folder, "parent_folder", file);
    await zbar.addRelation(ctx, account, "parent", folder);
    await zbar.addRelation(ctx, account, "parent_account", file);

    await zbar.addRelation(ctx, john, "viewer", file);
    await zbar.addRelation(ctx, jane, "editor", folder);
    await zbar.addRelation(ctx, alice, "admin", account);
    await zbar.addRelation(ctx, bob, "member", account);

    expect(await zbar.can(ctx, john, "read", file)).toBe(true);
    expect(await zbar.can(ctx, john, "write", file)).toBe(false);
    expect(await zbar.can(ctx, jane, "write", file)).toBe(true);
    expect(await zbar.can(ctx, alice, "write", file)).toBe(true);
    expect(await zbar.can(ctx, bob, "read", file)).toBe(true);
    expect(await zbar.can(ctx, bob, "write", file)).toBe(false);
  });
});

// ============================================================================
// Scenario: IoT platform (User → System → Device with role hierarchy)
// ============================================================================

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

describe("Scenario: IoT platform (User → System → Device)", () => {
  test("full inheritance flow with listing and removal cascading", async () => {
    const t = setup();
    const ctx = mkCtx(t);

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

    // Setup the graph
    await zbar.addRelation(ctx, ownerUser, "owner", sys);
    await zbar.addRelation(ctx, adminUser, "admin", sys);
    await zbar.addRelation(ctx, viewerUser, "viewer", sys);
    await zbar.addRelation(ctx, sys, "owned_by", device1);
    await zbar.addRelation(ctx, sys, "owned_by", device2);

    // System-level permissions (local inheritance)
    expect(await zbar.can(ctx, ownerUser, "own", sys)).toBe(true);
    expect(await zbar.can(ctx, ownerUser, "manage", sys)).toBe(true);
    expect(await zbar.can(ctx, ownerUser, "view", sys)).toBe(true);

    expect(await zbar.can(ctx, adminUser, "own", sys)).toBe(false);
    expect(await zbar.can(ctx, adminUser, "manage", sys)).toBe(true);
    expect(await zbar.can(ctx, adminUser, "view", sys)).toBe(true);

    expect(await zbar.can(ctx, viewerUser, "own", sys)).toBe(false);
    expect(await zbar.can(ctx, viewerUser, "manage", sys)).toBe(false);
    expect(await zbar.can(ctx, viewerUser, "view", sys)).toBe(true);

    // Device-level permissions (distant inheritance)
    expect(await zbar.can(ctx, ownerUser, "manage", device1)).toBe(true);
    expect(await zbar.can(ctx, ownerUser, "view", device1)).toBe(true);
    expect(await zbar.can(ctx, adminUser, "manage", device1)).toBe(true);
    expect(await zbar.can(ctx, adminUser, "view", device1)).toBe(true);
    expect(await zbar.can(ctx, viewerUser, "manage", device1)).toBe(false);
    expect(await zbar.can(ctx, viewerUser, "view", device1)).toBe(true);
    expect(await zbar.can(ctx, noAccessUser, "view", device1)).toBe(false);
    expect(await zbar.can(ctx, noAccessUser, "manage", device1)).toBe(false);

    // Listing
    const devicesToManage = await zbar
      .list()
      .object("device")
      .permission("manage")
      .subject(adminUser)
      .collect(ctx);
    expect(devicesToManage.length).toBe(2);
    expect(devicesToManage.map((d) => d.objectId).sort()).toEqual(["d1", "d2"]);

    // Removal cascading
    await zbar.removeRelation(ctx, adminUser, "admin", sys);
    expect(await zbar.can(ctx, adminUser, "manage", sys)).toBe(false);
    expect(await zbar.can(ctx, adminUser, "manage", device1)).toBe(false);

    await zbar.removeRelation(ctx, sys, "owned_by", device2);
    expect(await zbar.can(ctx, ownerUser, "manage", device1)).toBe(true);
    expect(await zbar.can(ctx, ownerUser, "manage", device2)).toBe(false);

    await assertDbState(t, 3, 6);
  });
});
