import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../../component/schema.js";
import { api } from "../../component/_generated/api.js";
import { createZbarSchema, Zbar } from "../index.js";

const modules = import.meta.glob("../../component/**/*.ts");

const TENANT_A = "tenant-acme";
const TENANT_B = "tenant-globex";

const zbarSchema = createZbarSchema<any>()
  .entity("user")
  .entity("org", (e) =>
    e
      .relation("owner", "user")
      .relation("admin", "user", "owner")
      .relation("viewer", "user", "admin")
      .permission("edit_settings", "admin")
      .permission("view_dashboard", "viewer"),
  )
  .entity("project", (e) =>
    e
      .relation("parent_org", "org")
      .relation("editor", "user", "parent_org.admin")
      .permission("edit", "editor"),
  )
  .build();

describe("Cross-tenant ReBAC isolation", () => {
  test("relation in tenant A is not visible in tenant B", async () => {
    const t = convexTest(schema, modules);
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbarA = new Zbar(api, {
      schema: zbarSchema,
      tenantId: TENANT_A,
      asyncWrites: false,
    });

    const zbarB = new Zbar(api, {
      schema: zbarSchema,
      tenantId: TENANT_B,
      asyncWrites: false,
    });

    const user = { type: "user" as const, id: "u1" };
    const org = { type: "org" as const, id: "org1" };

    // Add relation in Tenant A
    await zbarA.addRelation(ctx, user, "owner", org);

    // Verify relation exists in Tenant A
    const hasInA = await zbarA.hasRelationship(ctx, user, "owner", org);
    expect(hasInA).toBe(true);

    // Verify relation DOES NOT exist in Tenant B
    const hasInB = await zbarB.hasRelationship(ctx, user, "owner", org);
    expect(hasInB).toBe(false);
  });

  test("permission check in tenant A does not leak to tenant B", async () => {
    const t = convexTest(schema, modules);
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbarA = new Zbar(api, {
      schema: zbarSchema,
      tenantId: TENANT_A,
      asyncWrites: false,
    });

    const zbarB = new Zbar(api, {
      schema: zbarSchema,
      tenantId: TENANT_B,
      asyncWrites: false,
    });

    const user = { type: "user" as const, id: "u1" };
    const org = { type: "org" as const, id: "org1" };

    // Grant owner in Tenant A
    await zbarA.addRelation(ctx, user, "owner", org);

    // Verify permission exists in Tenant A via inheritance (owner -> admin -> edit_settings)
    const canEditInA = await zbarA.can(ctx, user, "edit_settings", org);
    expect(canEditInA).toBe(true);

    // Verify permission DOES NOT exist in Tenant B
    const canEditInB = await zbarB.can(ctx, user, "edit_settings", org);
    expect(canEditInB).toBe(false);
  });

  test("listAccessibleObjects is isolated by tenant", async () => {
    const t = convexTest(schema, modules);
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbarA = new Zbar(api, {
      schema: zbarSchema,
      tenantId: TENANT_A,
      asyncWrites: false,
    });

    const zbarB = new Zbar(api, {
      schema: zbarSchema,
      tenantId: TENANT_B,
      asyncWrites: false,
    });

    const user = { type: "user" as const, id: "u1" };
    const org1 = { type: "org" as const, id: "org1" };
    const org2 = { type: "org" as const, id: "org2" };

    // Add relations in Tenant A
    await zbarA.addRelation(ctx, user, "viewer", org1);

    // Add relation in Tenant B
    await zbarB.addRelation(ctx, user, "viewer", org2);

    // Verify accessible objects in Tenant A
    const accessibleA = await zbarA.listAccessibleObjects(
      ctx,
      user,
      "view_dashboard",
      "org",
    );
    expect(accessibleA.length).toBe(1);
    expect(accessibleA[0].objectId).toBe("org1");

    // Verify accessible objects in Tenant B
    const accessibleB = await zbarB.listAccessibleObjects(
      ctx,
      user,
      "view_dashboard",
      "org",
    );
    expect(accessibleB.length).toBe(1);
    expect(accessibleB[0].objectId).toBe("org2");
  });

  test("listSubjectsWithAccess is isolated by tenant", async () => {
    const t = convexTest(schema, modules);
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbarA = new Zbar(api, {
      schema: zbarSchema,
      tenantId: TENANT_A,
      asyncWrites: false,
    });

    const zbarB = new Zbar(api, {
      schema: zbarSchema,
      tenantId: TENANT_B,
      asyncWrites: false,
    });

    const user1 = { type: "user" as const, id: "u1" };
    const user2 = { type: "user" as const, id: "u2" };
    const org = { type: "org" as const, id: "org_shared" };

    // user1 has access in Tenant A
    await zbarA.addRelation(ctx, user1, "admin", org);

    // user2 has access in Tenant B
    await zbarB.addRelation(ctx, user2, "admin", org);

    // Verify users with access in Tenant A
    const usersA = await zbarA.listSubjectsWithAccess(
      ctx,
      "user",
      "edit_settings",
      org,
    );
    expect(usersA.length).toBe(1);
    expect(usersA[0].subjectId).toBe("u1");

    // Verify users with access in Tenant B
    const usersB = await zbarB.listSubjectsWithAccess(
      ctx,
      "user",
      "edit_settings",
      org,
    );
    expect(usersB.length).toBe(1);
    expect(usersB[0].subjectId).toBe("u2");
  });
});
