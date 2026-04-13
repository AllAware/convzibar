import { expect, test, describe } from "vitest";
import { Zbar, createZbarSchema } from "../index.js";
import { convexTest } from "convex-test";
import schema from "../../component/schema.js";
import { api } from "../../component/_generated/api.js";
import { register as registerWorkpool } from "@convex-dev/workpool/test";
import { v } from "convex/values";

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
// Schema with edge properties
// ============================================================================

const propsSchema = createZbarSchema<any>()
  .entity("user")
  .entity("org", (e) =>
    e
      .relation("owner", "user")
      .relation("admin", "user", "owner")
      .relation("viewer", "user", "admin")
      .properties("admin", {
        role_title: v.string(),
        priority: v.number(),
      })
      .properties("viewer", {
        expires_at: v.optional(v.string()),
        read_only: v.boolean(),
      })
      .permission("edit_settings", "admin")
      .permission("view_dashboard", "viewer"),
  )
  .entity("project", (e) =>
    e
      .relation("parent_org", "org")
      .relation("editor", "user", "parent_org.admin")
      .properties("editor", {
        weight: v.number(),
        note: v.optional(v.string()),
      })
      .permission("edit", "editor"),
  )
  .build();

const mkZbar = () =>
  new Zbar(api, {
    schema: propsSchema,
    tenantId: "t1",
    asyncWrites: false,
  });

// ============================================================================
// Tests
// ============================================================================

describe("Edge Properties", () => {
  test("addRelation stores properties on the edge", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const user = { type: "user" as const, id: "u1" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, user, "admin", org, {
      properties: { role_title: "CTO", priority: 1 },
    });

    // Verify stored in DB
    const rows = await t.run(async (innerCtx: any) =>
      innerCtx.db.query("relationships").collect(),
    );
    const adminRow = rows.find(
      (r: any) => r.relation === "admin" && r.subjectId === "u1",
    );
    expect(adminRow).toBeDefined();
    expect(adminRow.properties).toEqual({ role_title: "CTO", priority: 1 });
  });

  test("addRelation without properties stores undefined", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const user = { type: "user" as const, id: "u1" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, user, "owner", org);

    const rows = await t.run(async (innerCtx: any) =>
      innerCtx.db.query("relationships").collect(),
    );
    expect(rows[0].properties).toBeUndefined();
  });

  test("listDirect returns properties on edges", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, alice, "admin", org, {
      properties: { role_title: "CTO", priority: 1 },
    });
    await zbar.addRelation(ctx, bob, "viewer", org, {
      properties: { read_only: true, expires_at: "2025-12-31" },
    });

    const results = await zbar
      .listDirect()
      .object(org)
      .collect(ctx);

    const aliceRel = results.find(
      (r) => r.subject.id === "alice" && r.relation === "admin",
    );
    expect(aliceRel).toBeDefined();
    expect(aliceRel!.properties).toEqual({ role_title: "CTO", priority: 1 });

    const bobRel = results.find(
      (r) => r.subject.id === "bob" && r.relation === "viewer",
    );
    expect(bobRel).toBeDefined();
    expect(bobRel!.properties).toEqual({
      read_only: true,
      expires_at: "2025-12-31",
    });
  });

  test("listDirect with relation filter returns properties", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const user = { type: "user" as const, id: "u1" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, user, "admin", org, {
      properties: { role_title: "Admin", priority: 5 },
    });

    const admins = await zbar
      .listDirect()
      .object(org)
      .relation("admin")
      .collect(ctx);

    expect(admins).toHaveLength(1);
    expect(admins[0].properties).toEqual({ role_title: "Admin", priority: 5 });
  });

  test("listDirect with subject+object returns properties", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const user = { type: "user" as const, id: "u1" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, user, "admin", org, {
      properties: { role_title: "Lead", priority: 10 },
    });

    const rels = await zbar
      .listDirect()
      .object(org)
      .subject(user)
      .collect(ctx);

    expect(rels).toHaveLength(1);
    expect(rels[0].properties).toEqual({ role_title: "Lead", priority: 10 });
  });

  test("properties with optional fields can omit optional values", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const user = { type: "user" as const, id: "u1" };
    const org = { type: "org" as const, id: "org1" };

    // viewer has { expires_at: v.optional(v.string()), read_only: v.boolean() }
    // expires_at is optional, so we can omit it
    await zbar.addRelation(ctx, user, "viewer", org, {
      properties: { read_only: false },
    });

    const rels = await zbar
      .listDirect()
      .object(org)
      .collect(ctx);

    expect(rels[0].properties).toEqual({ read_only: false });
  });

  test("properties validation rejects missing required fields", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const user = { type: "user" as const, id: "u1" };
    const org = { type: "org" as const, id: "org1" };

    // admin requires { role_title: v.string(), priority: v.number() }
    // Missing priority should throw
    await expect(
      zbar.addRelation(ctx, user, "admin", org, {
        properties: { role_title: "Admin" } as any,
      }),
    ).rejects.toThrow(/Missing required property 'priority'/);
  });

  test("properties validation rejects unknown fields", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const user = { type: "user" as const, id: "u1" };
    const org = { type: "org" as const, id: "org1" };

    await expect(
      zbar.addRelation(ctx, user, "admin", org, {
        properties: {
          role_title: "Admin",
          priority: 1,
          unknown_field: true,
        } as any,
      }),
    ).rejects.toThrow(/Unknown property 'unknown_field'/);
  });

  test("properties validation rejects properties on relations with no schema", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const user = { type: "user" as const, id: "u1" };
    const org = { type: "org" as const, id: "org1" };

    // "owner" has no properties defined
    await expect(
      zbar.addRelation(ctx, user, "owner", org, {
        properties: { foo: "bar" } as any,
      }),
    ).rejects.toThrow(/No properties defined for relation 'owner'/);
  });

  test("updateRelation preserves properties on the new relation", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const user = { type: "user" as const, id: "u1" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, user, "viewer", org, {
      properties: { read_only: true },
    });

    // Update to admin with new properties
    await zbar.updateRelation(ctx, user, "viewer", "admin", org, {
      properties: { role_title: "Promoted", priority: 3 },
    });

    const rels = await zbar
      .listDirect()
      .object(org)
      .subject(user)
      .collect(ctx);

    expect(rels).toHaveLength(1);
    expect(rels[0].relation).toBe("admin");
    expect(rels[0].properties).toEqual({ role_title: "Promoted", priority: 3 });
  });

  test("setRelation stores properties on the new relation", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const user = { type: "user" as const, id: "u1" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, user, "viewer", org, {
      properties: { read_only: true },
    });
    await zbar.addRelation(ctx, user, "admin", org, {
      properties: { role_title: "Old", priority: 0 },
    });

    // setRelation replaces all with owner (which has no properties)
    await zbar.setRelation(ctx, user, "owner", org);

    const rels = await zbar
      .listDirect()
      .object(org)
      .subject(user)
      .collect(ctx);

    expect(rels).toHaveLength(1);
    expect(rels[0].relation).toBe("owner");
    expect(rels[0].properties).toBeUndefined();
  });

  test("permission checks still work with properties on edges", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const user = { type: "user" as const, id: "u1" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, user, "admin", org, {
      properties: { role_title: "Admin", priority: 1 },
    });

    // admin can edit_settings
    expect(await zbar.can(ctx, user, "edit_settings", org)).toBe(true);
    // admin inherits viewer, so can view_dashboard
    expect(await zbar.can(ctx, user, "view_dashboard", org)).toBe(true);
  });

  test("properties survive through graph expansion (project editor via org admin)", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const user = { type: "user" as const, id: "u1" };
    const org = { type: "org" as const, id: "org1" };
    const project = { type: "project" as const, id: "p1" };

    // Give user admin on org with properties
    await zbar.addRelation(ctx, user, "admin", org, {
      properties: { role_title: "CTO", priority: 1 },
    });

    // Link project to org
    await zbar.addRelation(ctx, org, "parent_org", project);

    // User should be an effective editor of the project
    expect(await zbar.can(ctx, user, "edit", project)).toBe(true);

    // Direct relationships on the org still have properties
    const orgRels = await zbar
      .listDirect()
      .object(org)
      .relation("admin")
      .collect(ctx);
    expect(orgRels[0].properties).toEqual({ role_title: "CTO", priority: 1 });
  });

  test("listDirect().map() receives properties", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const user = { type: "user" as const, id: "u1" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, user, "admin", org, {
      properties: { role_title: "CTO", priority: 1 },
    });

    const titles = await zbar
      .listDirect()
      .object(org)
      .relation("admin")
      .map((r) => (r.properties as any)?.role_title)
      .collect(ctx);

    expect(titles).toEqual(["CTO"]);
  });

  test("edges without properties return undefined in listDirect results", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const user = { type: "user" as const, id: "u1" };
    const org = { type: "org" as const, id: "org1" };

    // owner has no properties defined
    await zbar.addRelation(ctx, user, "owner", org);

    const rels = await zbar
      .listDirect()
      .object(org)
      .collect(ctx);

    expect(rels[0].properties).toBeUndefined();
  });

  test("multiple edges with different properties coexist", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const charlie = { type: "user" as const, id: "charlie" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, alice, "admin", org, {
      properties: { role_title: "CEO", priority: 1 },
    });
    await zbar.addRelation(ctx, bob, "admin", org, {
      properties: { role_title: "CTO", priority: 2 },
    });
    await zbar.addRelation(ctx, charlie, "viewer", org, {
      properties: { read_only: true },
    });

    const admins = await zbar
      .listDirect()
      .object(org)
      .relation("admin")
      .collect(ctx);

    expect(admins).toHaveLength(2);
    const aliceAdmin = admins.find((r) => r.subject.id === "alice");
    const bobAdmin = admins.find((r) => r.subject.id === "bob");
    expect(aliceAdmin!.properties).toEqual({ role_title: "CEO", priority: 1 });
    expect(bobAdmin!.properties).toEqual({ role_title: "CTO", priority: 2 });
  });
});
