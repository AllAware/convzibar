import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../../component/schema.js";
import { api } from "../../component/_generated/api.js";
import { createZbarSchema, Zbar } from "../index.js";

const modules = import.meta.glob("../../component/**/*.ts");
const TENANT = "test-tenant";

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
      .relation("parent_account", "account") // account_global in permit.io
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
    const t = convexTest(schema, modules);
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: driveSchema,
      tenantId: TENANT,
      asyncWrites: false, // Ensure tests run synchronously
    });

    // Objects
    const account = { type: "account" as const, id: "acme" };
    const folder = { type: "folder" as const, id: "finance" };
    const file = { type: "file" as const, id: "2023_report" };

    // Users
    const john = { type: "user" as const, id: "john" }; // direct viewer on file
    const jane = { type: "user" as const, id: "jane" }; // editor on folder
    const alice = { type: "user" as const, id: "alice" }; // admin on account
    const bob = { type: "user" as const, id: "bob" }; // member on account (general access)

    // Relations setup
    // file -> folder (parent)
    await zbar.addRelation(ctx, file, "parent_folder", folder);

    // folder -> account (parent)
    await zbar.addRelation(ctx, folder, "parent", account);

    // file -> account (account_global) for everyone in account
    await zbar.addRelation(ctx, file, "parent_account", account);

    // Direct access and roles
    // John: direct viewer on file
    await zbar.addRelation(ctx, john, "viewer", file);

    // Jane: editor on folder
    await zbar.addRelation(ctx, jane, "editor", folder);

    // Alice: admin on account
    await zbar.addRelation(ctx, alice, "admin", account);

    // Bob: member on account (general access)
    await zbar.addRelation(ctx, bob, "member", account);

    // John: direct viewer on file
    const johnRead = await zbar.can(ctx, john, "read", file);
    expect(johnRead).toBe(true);

    const johnWrite = await zbar.can(ctx, john, "write", file);
    expect(johnWrite).toBe(false);

    // Jane: editor on folder -> inherits editor on file
    const janeWrite = await zbar.can(ctx, jane, "write", file);
    expect(janeWrite).toBe(true);

    // Alice: admin on account -> inherits editor on file
    const aliceWrite = await zbar.can(ctx, alice, "write", file);
    expect(aliceWrite).toBe(true);

    // Bob: member on account -> viewer via account_global
    const bobRead = await zbar.can(ctx, bob, "read", file);
    expect(bobRead).toBe(true);

    const bobWrite = await zbar.can(ctx, bob, "write", file);
    expect(bobWrite).toBe(false);
  });
});
