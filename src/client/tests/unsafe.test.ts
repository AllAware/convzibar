import { expect, test, describe } from "vitest";
import { Zbar, createZbarSchema } from "../index.js";
import { ZbarUnsafe } from "../unsafe.js";
import { convexTest } from "convex-test";
import schema from "../../component/schema.js";
import { api } from "../../component/_generated/api.js";
import { register as registerWorkpool } from "@convex-dev/workpool/test";

// ============================================================================
// Test Setup
// ============================================================================

const setup = () => {
  const t = convexTest(schema, import.meta.glob("../../component/**/*.ts"));
  registerWorkpool(t, "workpool");
  return t;
};

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

function createClients(tenantId = "t1") {
  const zbar = new Zbar(api, {
    schema: zbarSchema,
    tenantId,
    asyncWrites: false,
  });
  const unsafe = new ZbarUnsafe(api, {
    schema: zbarSchema,
    tenantId,
    asyncWrites: false,
  });
  return { zbar, unsafe };
}

function makeCtx(t: any) {
  return {
    runQuery: t.query.bind(t),
    runMutation: t.mutation.bind(t),
  } as any;
}

// ============================================================================
// Step 1: Read Primitives
// ============================================================================

describe("ZbarUnsafe: Read Primitives", () => {
  test("scanRelationships returns all relationships for a tenant", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { zbar, unsafe } = createClients();

    await zbar.addRelation(ctx, { type: "user", id: "u1" }, "owner", {
      type: "org",
      id: "org1",
    });
    await zbar.addRelation(ctx, { type: "user", id: "u2" }, "viewer", {
      type: "org",
      id: "org1",
    });

    const result = await unsafe.scanRelationships(ctx);

    expect(result.rows.length).toBe(2);
    expect(result.isDone).toBe(true);
    expect(result.rows[0]).toMatchObject({
      subjectType: "user",
      relation: expect.stringMatching(/owner|viewer/),
      objectType: "org",
      objectId: "org1",
    });
  });

  test("scanRelationships filters by objectType", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { zbar, unsafe } = createClients();

    await zbar.addRelation(ctx, { type: "user", id: "u1" }, "owner", {
      type: "org",
      id: "org1",
    });
    await zbar.addRelation(
      ctx,
      { type: "org", id: "org1" },
      "parent_org",
      { type: "project", id: "p1" },
    );

    const orgOnly = await unsafe.scanRelationships(ctx, {
      objectType: "org",
    });
    expect(orgOnly.rows.length).toBe(1);
    expect(orgOnly.rows[0].relation).toBe("owner");

    const projectOnly = await unsafe.scanRelationships(ctx, {
      objectType: "project",
    });
    expect(projectOnly.rows.length).toBe(1);
    expect(projectOnly.rows[0].relation).toBe("parent_org");
  });

  test("scanRelationships filters by subject", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { zbar, unsafe } = createClients();

    await zbar.addRelation(ctx, { type: "user", id: "u1" }, "owner", {
      type: "org",
      id: "org1",
    });
    await zbar.addRelation(ctx, { type: "user", id: "u2" }, "viewer", {
      type: "org",
      id: "org1",
    });

    const result = await unsafe.scanRelationships(ctx, {
      subjectType: "user",
      subjectId: "u1",
    });
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].subjectId).toBe("u1");
  });

  test("scanRelationships paginates with cursor", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { zbar, unsafe } = createClients();

    // Create 5 relationships
    for (let i = 0; i < 5; i++) {
      await zbar.addRelation(ctx, { type: "user", id: `u${i}` }, "viewer", {
        type: "org",
        id: "org1",
      });
    }

    // Page 1
    const page1 = await unsafe.scanRelationships(ctx, undefined, { limit: 2 });
    expect(page1.rows.length).toBe(2);
    expect(page1.isDone).toBe(false);
    expect(page1.cursor).toBeDefined();

    // Page 2
    const page2 = await unsafe.scanRelationships(ctx, undefined, {
      cursor: page1.cursor,
      limit: 2,
    });
    expect(page2.rows.length).toBe(2);
    expect(page2.isDone).toBe(false);

    // Page 3
    const page3 = await unsafe.scanRelationships(ctx, undefined, {
      cursor: page2.cursor,
      limit: 2,
    });
    expect(page3.rows.length).toBe(1);
    expect(page3.isDone).toBe(true);
  });

  test("countRelationships counts all and filtered", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { zbar, unsafe } = createClients();

    await zbar.addRelation(ctx, { type: "user", id: "u1" }, "owner", {
      type: "org",
      id: "org1",
    });
    await zbar.addRelation(ctx, { type: "user", id: "u2" }, "viewer", {
      type: "org",
      id: "org1",
    });
    await zbar.addRelation(
      ctx,
      { type: "org", id: "org1" },
      "parent_org",
      { type: "project", id: "p1" },
    );

    expect(await unsafe.countRelationships(ctx)).toBe(3);
    expect(
      await unsafe.countRelationships(ctx, { objectType: "org" }),
    ).toBe(2);
    expect(
      await unsafe.countRelationships(ctx, { relation: "parent_org" }),
    ).toBe(1);
    expect(
      await unsafe.countRelationships(ctx, { subjectType: "user" }),
    ).toBe(2);
  });
});

// ============================================================================
// Step 2: Raw Write Primitives
// ============================================================================

describe("ZbarUnsafe: Raw Write Primitives", () => {
  test("insertRelationship creates a raw tuple without expansion", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { unsafe } = createClients();

    const id = await unsafe.insertRelationship(ctx, {
      subjectType: "user",
      subjectId: "u1",
      relation: "owner",
      objectType: "org",
      objectId: "org1",
    });

    expect(id).toBeDefined();

    // Should exist in base relationships
    const scan = await unsafe.scanRelationships(ctx);
    expect(scan.rows.length).toBe(1);

    // Should NOT have effective relationships (no expansion)
    const effectiveRels = await t.run(async (innerCtx: any) =>
      innerCtx.db.query("effectiveRelationships").collect(),
    );
    expect(effectiveRels.length).toBe(0);
  });

  test("patchRelationship modifies fields in-place", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { zbar, unsafe } = createClients();

    await zbar.addRelation(ctx, { type: "user", id: "u1" }, "viewer", {
      type: "org",
      id: "org1",
    });

    const scan = await unsafe.scanRelationships(ctx);
    const relId = scan.rows[0]._id;

    await unsafe.patchRelationship(ctx, relId, {
      relation: "admin",
    });

    const after = await unsafe.scanRelationships(ctx);
    expect(after.rows[0].relation).toBe("admin");
    expect(after.rows[0].subjectId).toBe("u1"); // untouched
  });

  test("patchRelationship can rename entity types", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { unsafe } = createClients();

    await unsafe.insertRelationship(ctx, {
      subjectType: "user",
      subjectId: "u1",
      relation: "member",
      objectType: "team",
      objectId: "t1",
    });

    const scan = await unsafe.scanRelationships(ctx);
    await unsafe.patchRelationship(ctx, scan.rows[0]._id, {
      objectType: "workspace",
    });

    const after = await unsafe.scanRelationships(ctx);
    expect(after.rows[0].objectType).toBe("workspace");
  });

  test("deleteRelationship removes a raw tuple without cascade", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { zbar, unsafe } = createClients();

    await zbar.addRelation(ctx, { type: "user", id: "u1" }, "owner", {
      type: "org",
      id: "org1",
    });

    // Verify effective relationships exist
    const effBefore = await t.run(async (innerCtx: any) =>
      innerCtx.db.query("effectiveRelationships").collect(),
    );
    expect(effBefore.length).toBeGreaterThan(0);

    const scan = await unsafe.scanRelationships(ctx);
    await unsafe.deleteRelationship(ctx, scan.rows[0]._id);

    // Base relationship gone
    const after = await unsafe.scanRelationships(ctx);
    expect(after.rows.length).toBe(0);

    // Effective relationships still exist (no cascade)
    const effAfter = await t.run(async (innerCtx: any) =>
      innerCtx.db.query("effectiveRelationships").collect(),
    );
    expect(effAfter.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Step 3: Effective Relationship Control
// ============================================================================

describe("ZbarUnsafe: Effective Relationship Control", () => {
  test("clearEffectiveRelationships removes all effective rels", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { zbar, unsafe } = createClients();

    await zbar.addRelation(ctx, { type: "user", id: "u1" }, "owner", {
      type: "org",
      id: "org1",
    });
    await zbar.addRelation(ctx, { type: "user", id: "u2" }, "viewer", {
      type: "org",
      id: "org1",
    });

    const effBefore = await t.run(async (innerCtx: any) =>
      innerCtx.db.query("effectiveRelationships").collect(),
    );
    expect(effBefore.length).toBeGreaterThan(0);

    const result = await unsafe.clearEffectiveRelationships(ctx);
    expect(result.removed).toBe(effBefore.length);

    const effAfter = await t.run(async (innerCtx: any) =>
      innerCtx.db.query("effectiveRelationships").collect(),
    );
    expect(effAfter.length).toBe(0);

    // Base relationships still intact
    const scan = await unsafe.scanRelationships(ctx);
    expect(scan.rows.length).toBe(2);
  });

  test("clearEffectiveRelationships with filter removes selectively", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { zbar, unsafe } = createClients();

    await zbar.addRelation(ctx, { type: "user", id: "u1" }, "owner", {
      type: "org",
      id: "org1",
    });
    await zbar.addRelation(
      ctx,
      { type: "org", id: "org1" },
      "parent_org",
      { type: "project", id: "p1" },
    );

    const effBefore = await t.run(async (innerCtx: any) =>
      innerCtx.db.query("effectiveRelationships").collect(),
    );

    // Only clear effective rels for "project" objects
    await unsafe.clearEffectiveRelationships(ctx, { objectType: "project" });

    const effAfter = await t.run(async (innerCtx: any) =>
      innerCtx.db.query("effectiveRelationships").collect(),
    );

    // Some should remain (org-level), some removed (project-level)
    expect(effAfter.length).toBeLessThan(effBefore.length);
    expect(effAfter.length).toBeGreaterThan(0);

    // Remaining should all be org-related
    for (const eff of effAfter) {
      expect(eff.objectKey).toMatch(/^org:/);
    }
  });

  test("rebuildEffectiveRelationships reconstructs from base tuples", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { zbar, unsafe } = createClients();

    // Build up some relationships
    await zbar.addRelation(ctx, { type: "user", id: "u1" }, "owner", {
      type: "org",
      id: "org1",
    });
    await zbar.addRelation(
      ctx,
      { type: "org", id: "org1" },
      "parent_org",
      { type: "project", id: "p1" },
    );

    // Capture the effective state for comparison
    const effBefore = await t.run(async (innerCtx: any) =>
      innerCtx.db.query("effectiveRelationships").collect(),
    );
    expect(effBefore.length).toBeGreaterThan(0);

    // Verify the standard client works
    const canEditBefore = await zbar.can(
      ctx,
      { type: "user", id: "u1" },
      "edit",
      { type: "project", id: "p1" },
    );
    expect(canEditBefore).toBe(true);

    // Rebuild
    const result = await unsafe.rebuildEffectiveRelationships(ctx);
    expect(result.removed).toBe(effBefore.length);
    expect(result.rebuilt).toBeGreaterThan(0);

    // Verify the standard client still works identically
    const canEditAfter = await zbar.can(
      ctx,
      { type: "user", id: "u1" },
      "edit",
      { type: "project", id: "p1" },
    );
    expect(canEditAfter).toBe(true);

    // Verify effective relationships were rebuilt
    const effAfter = await t.run(async (innerCtx: any) =>
      innerCtx.db.query("effectiveRelationships").collect(),
    );
    expect(effAfter.length).toBe(effBefore.length);
  });

  test("rebuildEffectiveRelationships after manual patch restores correctness", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { zbar, unsafe } = createClients();

    // Set up: u1 is owner of org1, org1 is parent of project p1
    await zbar.addRelation(ctx, { type: "user", id: "u1" }, "owner", {
      type: "org",
      id: "org1",
    });
    await zbar.addRelation(
      ctx,
      { type: "org", id: "org1" },
      "parent_org",
      { type: "project", id: "p1" },
    );

    // u1 can edit p1 via owner → admin → editor chain
    expect(
      await zbar.can(
        ctx,
        { type: "user", id: "u1" },
        "edit",
        { type: "project", id: "p1" },
      ),
    ).toBe(true);

    // Manually downgrade u1 from owner to viewer (bypassing normal API)
    const scan = await unsafe.scanRelationships(ctx, {
      subjectType: "user",
      subjectId: "u1",
      relation: "owner",
    });
    await unsafe.patchRelationship(ctx, scan.rows[0]._id, {
      relation: "viewer",
    });

    // Effective rels are now stale — u1 still appears to have edit access
    expect(
      await zbar.can(
        ctx,
        { type: "user", id: "u1" },
        "edit",
        { type: "project", id: "p1" },
      ),
    ).toBe(true); // stale!

    // Rebuild fixes it
    await unsafe.rebuildEffectiveRelationships(ctx);

    // Now u1 should NOT have edit access (viewer doesn't grant edit on project)
    expect(
      await zbar.can(
        ctx,
        { type: "user", id: "u1" },
        "edit",
        { type: "project", id: "p1" },
      ),
    ).toBe(false);

    // But u1 should still have view_dashboard on org (viewer includes that)
    expect(
      await zbar.can(
        ctx,
        { type: "user", id: "u1" },
        "view_dashboard",
        { type: "org", id: "org1" },
      ),
    ).toBe(true);
  });
});

// ============================================================================
// Step 4: Bulk Transform
// ============================================================================

describe("ZbarUnsafe: Bulk Transform", () => {
  test("transformRelationships with patch renames relations", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { zbar, unsafe } = createClients();

    await zbar.addRelation(ctx, { type: "user", id: "u1" }, "viewer", {
      type: "org",
      id: "org1",
    });
    await zbar.addRelation(ctx, { type: "user", id: "u2" }, "viewer", {
      type: "org",
      id: "org2",
    });

    const result = await unsafe.transformRelationships(
      ctx,
      { relation: "viewer" },
      (row) => ({ patch: { relation: "reader" } }),
    );

    expect(result.patched).toBe(2);
    expect(result.deleted).toBe(0);

    const scan = await unsafe.scanRelationships(ctx);
    expect(scan.rows.every((r) => r.relation === "reader")).toBe(true);
  });

  test("transformRelationships with delete removes matching rows", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { zbar, unsafe } = createClients();

    await zbar.addRelation(ctx, { type: "user", id: "u1" }, "owner", {
      type: "org",
      id: "org1",
    });
    await zbar.addRelation(ctx, { type: "user", id: "u2" }, "viewer", {
      type: "org",
      id: "org1",
    });

    const result = await unsafe.transformRelationships(
      ctx,
      { objectType: "org" },
      (row) => (row.relation === "viewer" ? { delete: true } : null),
    );

    expect(result.deleted).toBe(1);
    expect(result.skipped).toBe(1);

    const scan = await unsafe.scanRelationships(ctx);
    expect(scan.rows.length).toBe(1);
    expect(scan.rows[0].relation).toBe("owner");
  });

  test("transformRelationships with replace splits a relationship", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { unsafe } = createClients();

    // Insert a direct user→doc relationship
    await unsafe.insertRelationship(ctx, {
      subjectType: "user",
      subjectId: "u1",
      relation: "editor",
      objectType: "doc",
      objectId: "d1",
    });

    // Split into user→team + team→doc (add intermediate entity)
    const result = await unsafe.transformRelationships(
      ctx,
      { objectType: "doc" },
      (row) => ({
        replace: [
          {
            subjectType: row.subjectType,
            subjectId: row.subjectId,
            relation: "member",
            objectType: "team",
            objectId: "team1",
          },
          {
            subjectType: "team",
            subjectId: "team1",
            relation: row.relation,
            objectType: row.objectType,
            objectId: row.objectId,
          },
        ],
      }),
    );

    expect(result.deleted).toBe(1);
    expect(result.inserted).toBe(2);

    const scan = await unsafe.scanRelationships(ctx);
    expect(scan.rows.length).toBe(2);

    const relations = scan.rows.map((r) => `${r.subjectType}:${r.relation}:${r.objectType}`).sort();
    expect(relations).toEqual(["team:editor:doc", "user:member:team"]);
  });

  test("transformRelationships with null skips rows", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { zbar, unsafe } = createClients();

    await zbar.addRelation(ctx, { type: "user", id: "u1" }, "owner", {
      type: "org",
      id: "org1",
    });

    const result = await unsafe.transformRelationships(
      ctx,
      { objectType: "org" },
      () => null,
    );

    expect(result.skipped).toBe(1);
    expect(result.patched).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.inserted).toBe(0);
  });

  test("transformRelationships conditional logic per row", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { zbar, unsafe } = createClients();

    await zbar.addRelation(ctx, { type: "user", id: "u1" }, "owner", {
      type: "org",
      id: "org1",
    });
    await zbar.addRelation(ctx, { type: "user", id: "u2" }, "admin", {
      type: "org",
      id: "org1",
    });
    await zbar.addRelation(ctx, { type: "user", id: "u3" }, "viewer", {
      type: "org",
      id: "org1",
    });

    const result = await unsafe.transformRelationships(
      ctx,
      { objectType: "org" },
      (row) => {
        if (row.relation === "owner") return { patch: { relation: "superadmin" } };
        if (row.relation === "viewer") return { delete: true };
        return null; // keep admin as-is
      },
    );

    expect(result.patched).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.skipped).toBe(1);

    const scan = await unsafe.scanRelationships(ctx);
    expect(scan.rows.length).toBe(2);
    const relations = scan.rows.map((r) => r.relation).sort();
    expect(relations).toEqual(["admin", "superadmin"]);
  });
});

// ============================================================================
// Step 5: Convenience Helpers
// ============================================================================

describe("ZbarUnsafe: Convenience Helpers", () => {
  test("renameRelation renames all matching base relationships", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { zbar, unsafe } = createClients();

    await zbar.addRelation(ctx, { type: "user", id: "u1" }, "viewer", {
      type: "org",
      id: "org1",
    });
    await zbar.addRelation(ctx, { type: "user", id: "u2" }, "viewer", {
      type: "org",
      id: "org2",
    });
    await zbar.addRelation(ctx, { type: "user", id: "u3" }, "owner", {
      type: "org",
      id: "org1",
    });

    const result = await unsafe.renameRelation(ctx, "org", "viewer", "reader");

    expect(result.updated).toBe(2);

    const scan = await unsafe.scanRelationships(ctx, { relation: "reader" });
    expect(scan.rows.length).toBe(2);

    // Owner untouched
    const owners = await unsafe.scanRelationships(ctx, { relation: "owner" });
    expect(owners.rows.length).toBe(1);
  });

  test("renameEntityType renames both subject and object references", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { zbar, unsafe } = createClients();

    await zbar.addRelation(ctx, { type: "user", id: "u1" }, "owner", {
      type: "org",
      id: "org1",
    });
    await zbar.addRelation(
      ctx,
      { type: "org", id: "org1" },
      "parent_org",
      { type: "project", id: "p1" },
    );

    // Rename "org" to "workspace"
    const result = await unsafe.renameEntityType(ctx, "org", "workspace");

    expect(result.updated).toBeGreaterThanOrEqual(2);

    const scan = await unsafe.scanRelationships(ctx);
    // Check that "org" no longer appears
    for (const row of scan.rows) {
      expect(row.subjectType).not.toBe("org");
      expect(row.objectType).not.toBe("org");
    }

    // The owner relationship should now be user → workspace
    const ownerRels = scan.rows.filter((r) => r.relation === "owner");
    expect(ownerRels.length).toBe(1);
    expect(ownerRels[0].objectType).toBe("workspace");
    expect(ownerRels[0].subjectType).toBe("user");

    // The parent_org relationship should now be workspace → project
    const parentRels = scan.rows.filter((r) => r.relation === "parent_org");
    expect(parentRels.length).toBe(1);
    expect(parentRels[0].subjectType).toBe("workspace");
    expect(parentRels[0].objectType).toBe("project");
  });

  test("renameRelation + rebuild restores full functionality", async () => {
    const t = setup();
    const ctx = makeCtx(t);

    // Start with the standard schema
    const { zbar, unsafe } = createClients();

    await zbar.addRelation(ctx, { type: "user", id: "u1" }, "owner", {
      type: "org",
      id: "org1",
    });

    // Verify the owner can view dashboard
    expect(
      await zbar.can(
        ctx,
        { type: "user", id: "u1" },
        "view_dashboard",
        { type: "org", id: "org1" },
      ),
    ).toBe(true);

    // Rename "owner" to "superadmin" in the base tuples
    await unsafe.renameRelation(ctx, "org", "owner", "superadmin");

    // Now create a new schema that uses "superadmin" instead of "owner"
    const newSchema = createZbarSchema<any>()
      .entity("user")
      .entity("org", (e) =>
        e
          .relation("superadmin", "user")
          .relation("admin", "user", "superadmin")
          .relation("viewer", "user", "admin")
          .permission("edit_settings", "admin")
          .permission("view_dashboard", "viewer"),
      )
      .build();

    const newUnsafe = new ZbarUnsafe(api, {
      schema: newSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    // Rebuild with the new schema's graph config
    await newUnsafe.rebuildEffectiveRelationships(ctx);

    // Create a new standard client with the new schema
    const newZbar = new Zbar(api, {
      schema: newSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    // The superadmin should now grant view_dashboard via the new inheritance chain
    expect(
      await newZbar.can(
        ctx,
        { type: "user", id: "u1" },
        "view_dashboard",
        { type: "org", id: "org1" },
      ),
    ).toBe(true);
  });
});

// ============================================================================
// End-to-End Migration Scenarios
// ============================================================================

describe("ZbarUnsafe: End-to-End Migration Scenarios", () => {
  test("full migration: rename entity type + rebuild", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { zbar, unsafe } = createClients();

    // Seed data
    await zbar.addRelation(ctx, { type: "user", id: "u1" }, "owner", {
      type: "org",
      id: "org1",
    });
    await zbar.addRelation(ctx, { type: "user", id: "u2" }, "viewer", {
      type: "org",
      id: "org1",
    });
    await zbar.addRelation(
      ctx,
      { type: "org", id: "org1" },
      "parent_org",
      { type: "project", id: "p1" },
    );

    // Step 1: Rename "org" → "workspace" in base tuples
    await unsafe.renameEntityType(ctx, "org", "workspace");

    // Also rename the relation "parent_org" → "parent_workspace"
    await unsafe.renameRelation(ctx, "project", "parent_org", "parent_workspace");

    // Step 2: Define new schema
    const newSchema = createZbarSchema<any>()
      .entity("user")
      .entity("workspace", (e) =>
        e
          .relation("owner", "user")
          .relation("admin", "user", "owner")
          .relation("viewer", "user", "admin")
          .permission("edit_settings", "admin")
          .permission("view_dashboard", "viewer"),
      )
      .entity("project", (e) =>
        e
          .relation("parent_workspace", "workspace")
          .relation("editor", "user", "parent_workspace.admin")
          .permission("edit", "editor"),
      )
      .build();

    const newUnsafe = new ZbarUnsafe(api, {
      schema: newSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    // Step 3: Rebuild effective relationships
    await newUnsafe.rebuildEffectiveRelationships(ctx);

    // Step 4: Verify with new client
    const newZbar = new Zbar(api, {
      schema: newSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    // u1 (owner → admin) should have edit on project
    expect(
      await newZbar.can(
        ctx,
        { type: "user", id: "u1" },
        "edit",
        { type: "project", id: "p1" },
      ),
    ).toBe(true);

    // u2 (viewer only) should NOT have edit on project
    expect(
      await newZbar.can(
        ctx,
        { type: "user", id: "u2" },
        "edit",
        { type: "project", id: "p1" },
      ),
    ).toBe(false);

    // u2 should still have view_dashboard on workspace
    expect(
      await newZbar.can(
        ctx,
        { type: "user", id: "u2" },
        "view_dashboard",
        { type: "workspace", id: "org1" },
      ),
    ).toBe(true);
  });

  test("full migration: add intermediate entity via transform + rebuild", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { unsafe } = createClients();

    // Start with direct user → doc relationships
    await unsafe.insertRelationship(ctx, {
      subjectType: "user",
      subjectId: "u1",
      relation: "editor",
      objectType: "doc",
      objectId: "d1",
    });
    await unsafe.insertRelationship(ctx, {
      subjectType: "user",
      subjectId: "u2",
      relation: "editor",
      objectType: "doc",
      objectId: "d1",
    });

    // Transform: split direct user→doc into user→team + team→doc
    const result = await unsafe.transformRelationships(
      ctx,
      { objectType: "doc" },
      (row) => ({
        replace: [
          {
            subjectType: row.subjectType,
            subjectId: row.subjectId,
            relation: "member",
            objectType: "team",
            objectId: "team1",
          },
          {
            subjectType: "team",
            subjectId: "team1",
            relation: "editor",
            objectType: "doc",
            objectId: row.objectId,
          },
        ],
      }),
    );

    expect(result.deleted).toBe(2);
    expect(result.inserted).toBe(4);

    // Verify the new structure
    const scan = await unsafe.scanRelationships(ctx);

    const memberRels = scan.rows.filter((r) => r.relation === "member");
    const editorRels = scan.rows.filter((r) => r.relation === "editor");

    // Both users are now members of team1
    expect(memberRels.length).toBe(2);
    expect(memberRels.every((r) => r.objectType === "team")).toBe(true);

    // There should be one or two team→doc editor rels (may be deduplicated in transform)
    expect(editorRels.length).toBeGreaterThanOrEqual(1);
    expect(editorRels.every((r) => r.subjectType === "team")).toBe(true);
  });

  test("full migration: delete an entity type", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const { zbar, unsafe } = createClients();

    await zbar.addRelation(ctx, { type: "user", id: "u1" }, "owner", {
      type: "org",
      id: "org1",
    });
    await zbar.addRelation(
      ctx,
      { type: "org", id: "org1" },
      "parent_org",
      { type: "project", id: "p1" },
    );

    // Delete all relationships involving "project" type
    const resultObj = await unsafe.transformRelationships(
      ctx,
      { objectType: "project" },
      () => ({ delete: true }),
    );
    const resultSubj = await unsafe.transformRelationships(
      ctx,
      { subjectType: "project" },
      () => ({ delete: true }),
    );

    expect(resultObj.deleted + resultSubj.deleted).toBeGreaterThanOrEqual(1);

    // Only org relationships should remain
    const scan = await unsafe.scanRelationships(ctx);
    for (const row of scan.rows) {
      expect(row.objectType).not.toBe("project");
      expect(row.subjectType).not.toBe("project");
    }
  });
});

// ============================================================================
// Effective Reverse Edges in Rebuild
// ============================================================================

describe("ZbarUnsafe: Rebuild preserves effective reverse edges", () => {
  const revSchema = createZbarSchema<any>()
    .entity("user")
    .entity("system", (e) =>
      e
        .relation("viewer", "user")
        .relation("user_member", "viewer")
        .relation("contact_member"),
    )
    .entity("contact", (e) =>
      e.relation("owner", { type: "system", reverse: "contact_member" }),
    )
    .extend("user", (e) => e.relation("primary_contact", "contact"))
    .extend("system", (e) =>
      e.relation("contact_member", "user_member.primary_contact"),
    )
    .build();

  test("derived contact_member edges and their reverse survive rebuild", async () => {
    const t = setup();
    const ctx = makeCtx(t);
    const zbar = new Zbar(api, {
      schema: revSchema,
      tenantId: "t1",
      asyncWrites: false,
    });
    const unsafe = new ZbarUnsafe(api, {
      schema: revSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    await zbar.addRelation(
      ctx,
      { type: "user", id: "alice" },
      "viewer",
      { type: "system", id: "sys1" },
    );
    await zbar.addRelation(
      ctx,
      { type: "contact", id: "c_alice" },
      "primary_contact",
      { type: "user", id: "alice" },
    );

    const effBefore = await t.run(async (innerCtx: any) =>
      innerCtx.db.query("effectiveRelationships").collect(),
    );
    const memberBefore = effBefore.filter(
      (e: any) =>
        e.relation === "contact_member" &&
        e.subjectKey === "contact:c_alice" &&
        e.objectKey === "system:sys1",
    );
    const reverseBefore = effBefore.filter(
      (e: any) =>
        e.relation === "owner" &&
        e.subjectKey === "system:sys1" &&
        e.objectKey === "contact:c_alice",
    );
    expect(memberBefore.length).toBe(1);
    expect(reverseBefore.length).toBe(1);

    await unsafe.rebuildEffectiveRelationships(ctx);

    const effAfter = await t.run(async (innerCtx: any) =>
      innerCtx.db.query("effectiveRelationships").collect(),
    );
    const memberAfter = effAfter.filter(
      (e: any) =>
        e.relation === "contact_member" &&
        e.subjectKey === "contact:c_alice" &&
        e.objectKey === "system:sys1",
    );
    const reverseAfter = effAfter.filter(
      (e: any) =>
        e.relation === "owner" &&
        e.subjectKey === "system:sys1" &&
        e.objectKey === "contact:c_alice",
    );
    expect(memberAfter.length).toBe(1);
    expect(reverseAfter.length).toBe(1);
  });
});
