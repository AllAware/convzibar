import { expect, test, describe } from "vitest";
import { Zbar, createZbarSchema } from "../index.js";
import { convexTest } from "convex-test";
import schema from "../../component/schema.js";
import { api, internal } from "../../component/_generated/api.js";
import { register as registerWorkpool } from "@convex-dev/workpool/test";

const setup = () => {
  const t = convexTest(schema, import.meta.glob("../../component/**/*.ts"));
  registerWorkpool(t, "workpool");
  return t;
};

const zbarSchema = createZbarSchema<any>()
  .condition("isBusinessHours", (ctx, policyCtx) => {
    return policyCtx.data?.timezone === "EST";
  })
  .condition("hasPaidPlan", (ctx, policyCtx) => {
    return policyCtx.subject.id === "user_paid";
  })
  .entity("user")
  .entity("org", (e) =>
    e
      .relation("owner", { type: "user", reverse: "owner_of_org" })
      .relation("admin", "user", "owner")
      .relation("viewer", "user", "admin")
      .permission("edit_settings", "admin")
      .permission("view_dashboard", "viewer")
      .permission("audit", { relation: "admin", condition: "hasPaidPlan" }),
  )
  .entity("project", (e) =>
    e
      .relation("parent_org", "org")
      .relation("editor", "user", "parent_org.admin")
      .permission("edit", "editor"),
  )
  .build();

describe("Client API & Read-Time Inference", () => {
  test(".can() infers local inheritance", async () => {
    const t = setup();
    // Use an instance of Zbar, but we have to mock `runQuery` and `runMutation` inside `can`
    // Actually, `convexTest` gives us `t.query` and `t.mutation`. We can wrap them in a pseudo context:
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: zbarSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const user = { type: "user" as const, id: "u1" };
    const org1 = { type: "org" as const, id: "org1" };
    const org2 = { type: "org" as const, id: "org2" };

    await zbar.addRelation(ctx, user, "owner", org1); // Should grant view_dashboard via inheritance
    await zbar.addRelation(ctx, user, "viewer", org2); // Direct viewer

    const results = await zbar.listAccessibleObjects(
      ctx,
      user,
      "view_dashboard",
      "org",
    );

    expect(results.length).toBe(2);
    expect(results.map((r) => r.objectId).sort()).toEqual(["org1", "org2"]);
  });

  test(".can() infers distant inheritance", async () => {
    const t = setup();
    // Use an instance of Zbar, but we have to mock `runQuery` and `runMutation` inside `can`
    // Actually, `convexTest` gives us `t.query` and `t.mutation`. We can wrap them in a pseudo context:
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: zbarSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const user = { type: "user" as const, id: "u1" };
    const org1 = { type: "org" as const, id: "org1" };
    const org2 = { type: "org" as const, id: "org2" };
    const proj1 = { type: "project" as const, id: "proj1" };

    await zbar.addRelation(ctx, user, "owner", org1); // Should grant view_dashboard via inheritance
    await zbar.addRelation(ctx, user, "viewer", org1);
    await zbar.addRelation(ctx, proj1, "parent_org", org1);

    const results = await zbar.listAccessibleObjects(
      ctx,
      user,
      "edit",
      "project",
    );

    expect(results.length).toBe(1);
    expect(results.map((r) => r.objectId).sort()).toEqual(["proj1"]);
  });

  test("listUsersWithAccess with local inheritance", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: zbarSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const ownerUser = { type: "user", id: "u_owner" } as const;
    const adminUser = { type: "user", id: "u_admin" } as const;
    const org = { type: "org", id: "org1" } as const;

    await zbar.addRelation(ctx, ownerUser, "owner", org);
    await zbar.addRelation(ctx, adminUser, "admin", org);

    // Both should have edit_settings
    const results = await zbar.listUsersWithAccess(ctx, org, "edit_settings");

    expect(results.length).toBe(2);
    expect(results.map((r) => r.userId).sort()).toEqual(["u_admin", "u_owner"]);
  });

  test("bidirectional relationship auto-insertion", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: zbarSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const user = { type: "user", id: "u_owner" } as const;
    const org = { type: "org", id: "org1" } as const;

    await zbar.addRelation(ctx, user, "owner", org);

    // Verify reverse edge was added: (org, "owner_of_org", user)
    const rels = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: org,
      relations: ["owner_of_org"],
      object: user,
    });

    expect(rels.length).toBe(1);
    expect(rels[0].relation).toBe("owner_of_org");
  });

  test("deleteEntity removes all associated relationships", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: zbarSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const user = { type: "user", id: "u_delete" } as const;
    const org = { type: "org", id: "org1" } as const;
    const project = { type: "project", id: "proj1" } as const;

    // user is owner of org (which gives viewer access to org, and editor access to proj if proj in org)
    await zbar.addRelation(ctx, user, "owner", org);
    await zbar.addRelation(ctx, project, "parent_org", org);

    const relsBefore = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["owner"],
      object: org,
    });
    expect(relsBefore.length).toBe(1);

    const res = await zbar.deleteEntity(ctx, user);

    // relationshipsRemoved should be 1 (because the single removeRelationInternal call removes both the forward and reverse edge under the hood)
    expect(res.relationshipsRemoved).toBe(1);
    // effective relationships will also be cleared
    expect(res.effectiveRelationshipsRemoved).toBeGreaterThan(0);

    const relsAfter = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["owner"],
      object: org,
    });
    expect(relsAfter.length).toBe(0);
  });

  test("deeply nested conditional read-time inference and deletions", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const deepSchema = createZbarSchema<any>()
      .condition("isApproved", (ctx, policy) => policy.data?.approved === true)
      .condition("isActive", (ctx, policy) => policy.data?.active === true)
      .entity("user")
      .entity("org", (e) => e.relation("viewer", "user"))
      .entity("project", (e) =>
        e
          .relation("parent_org", "org")
          .relation("viewer", "user", "parent_org.viewer"),
      )
      .entity("folder", (e) =>
        e
          .relation("parent_project", "project")
          .relation("viewer", "user", "parent_project.viewer"),
      )
      .entity("document", (e) =>
        e
          .relation("parent_folder", "folder")
          .relation("viewer", "user", "parent_folder.viewer")
          .permission("read", { relation: "viewer", condition: "isApproved" }),
      )
      .build();

    const zbar = new Zbar(api, {
      schema: deepSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const user = { type: "user", id: "u_nested" } as const;
    const org = { type: "org", id: "o1" } as const;
    const project = { type: "project", id: "p1" } as const;
    const folder = { type: "folder", id: "f1" } as const;
    const document = { type: "document", id: "d1" } as const;

    // Link graph: Document -> Folder -> Project -> Org
    await zbar.addRelation(ctx, document, "parent_folder", folder);
    await zbar.addRelation(ctx, folder, "parent_project", project);
    await zbar.addRelation(ctx, project, "parent_org", org);

    // Give user viewer on Org
    await zbar.addRelation(ctx, user, "viewer", org);

    // 1. Should NOT be able to read without condition context
    const canReadWithoutCtx = await zbar.can(ctx, user, "read", document);
    expect(canReadWithoutCtx).toBe(false);

    // 2. Should be able to read WITH condition context
    const canReadWithCtx = await zbar.can(ctx, user, "read", document, {
      approved: true,
    });
    expect(canReadWithCtx).toBe(true);

    // 3. List accessible objects (should return d1 when context matches)
    const accessibleDocs = await zbar.listAccessibleObjects(
      ctx,
      user,
      "read",
      "document",
      { approved: true },
    );
    expect(accessibleDocs.length).toBe(1);
    expect(accessibleDocs[0].objectId).toBe("d1");

    // 4. Sever the graph by removing folder -> project
    await zbar.removeRelation(ctx, folder, "parent_project", project);

    // Should NO LONGER be able to read even with context
    const canReadAfterDelete = await zbar.can(ctx, user, "read", document, {
      approved: true,
    });
    expect(canReadAfterDelete).toBe(false);

    // 5. Re-link folder -> project, but this time with a hardcoded failing edge condition
    await zbar.addRelation(ctx, folder, "parent_project", project, {
      condition: "isActive",
      conditionContext: { active: false },
    });

    // Even if we pass approved: true to the request context (for the target permission),
    // the edge condition itself will fail because it's hardcoded to active: false
    const canReadWithEdgeFalse = await zbar.can(ctx, user, "read", document, {
      approved: true,
    });
    expect(canReadWithEdgeFalse).toBe(false);

    // 6. Fix the edge condition to be true
    await zbar.removeRelation(ctx, folder, "parent_project", project);
    await zbar.addRelation(ctx, folder, "parent_project", project, {
      condition: "isActive",
      conditionContext: { active: true },
    });

    // Now it should pass both the edge condition (active: true) AND the permission condition (approved: true)
    const canReadWithEdgeTrue = await zbar.can(ctx, user, "read", document, {
      approved: true,
    });
    expect(canReadWithEdgeTrue).toBe(true);
  });

  test("conditional relation in schema evaluated at read-time", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const testSchema = createZbarSchema<any>()
      .condition("isActive", (ctx, policy) => policy.data?.active === true)
      .entity("user")
      .entity("folder", (e) => e.relation("viewer", "user"))
      .entity("document", (e) =>
        e
          .relation("parent_folder", "folder")
          .relation("viewer", "user", {
            relation: "parent_folder.viewer",
            condition: "isActive",
          })
          .permission("view", "viewer"),
      )
      .build();

    const zbar = new Zbar(api, {
      schema: testSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const user = { type: "user", id: "u1" } as const;
    const document = { type: "document", id: "d1" } as const;
    const folder = { type: "folder", id: "f1" } as const;

    await zbar.addRelation(ctx, document, "parent_folder", folder);
    await zbar.addRelation(ctx, user, "viewer", folder);

    // Context without active: true -> fails
    let canView = await zbar.can(ctx, user, "view", document);
    expect(canView).toBe(false);

    // Context with active: true -> passes
    canView = await zbar.can(ctx, user, "view", document, { active: true });

    expect(canView).toBe(true);
  });

  test("auditLog is disabled when enableAuditLog is false", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const testSchema = createZbarSchema<any>()
      .entity("user")
      .entity("org", (e) => e.relation("owner", "user"))
      .build();

    const zbar = new Zbar(api, {
      schema: testSchema,
      tenantId: "t1",
      enableAuditLog: false,
      asyncWrites: false,
    });

    const user = { type: "user", id: "u1" } as const;
    const org = { type: "org", id: "o1" } as const;

    await zbar.addRelation(ctx, user, "owner", org);

    const logs = await t.run(async (innerCtx) => {
      return await innerCtx.db.query("auditLog").collect();
    });

    expect(logs.length).toBe(0);

    const zbarEnabled = new Zbar(api, {
      schema: testSchema,
      tenantId: "t1",
      enableAuditLog: true,
      asyncWrites: false,
    });

    await zbarEnabled.addRelation(
      ctx,
      { type: "user", id: "u2" },
      "owner",
      org,
    );
    const logsAfter = await t.run(async (innerCtx) => {
      return await innerCtx.db.query("auditLog").collect();
    });

    expect(logsAfter.length).toBeGreaterThan(0);
  });

  test("hasRelationship respects inheritance and conditions", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: zbarSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const ownerUser = { type: "user", id: "u_owner" } as const;
    const adminUser = { type: "user", id: "u_admin" } as const;
    const org = { type: "org", id: "org1" } as const;

    await zbar.addRelation(ctx, ownerUser, "owner", org);
    await zbar.addRelation(ctx, adminUser, "admin", org);

    // Owner should have "viewer" because owner -> admin -> viewer
    const ownerHasViewer = await zbar.hasRelationship(
      ctx,
      ownerUser,
      "viewer",
      org,
    );
    expect(ownerHasViewer).toBe(true);

    // Admin should have "viewer"
    const adminHasViewer = await zbar.hasRelationship(
      ctx,
      adminUser,
      "viewer",
      org,
    );
    expect(adminHasViewer).toBe(true);

    // Admin should NOT have "owner"
    const adminHasOwner = await zbar.hasRelationship(
      ctx,
      adminUser,
      "owner",
      org,
    );
    expect(adminHasOwner).toBe(false);
  });

  test("getRelationships returns all relationships for a subject and object", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: zbarSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const ownerUser = { type: "user", id: "u_owner" } as const;
    const org = { type: "org", id: "org1" } as const;

    await zbar.addRelation(ctx, ownerUser, "owner", org);

    // Should ONLY return owner by default (includeInherited is false)
    const explicitRels = await zbar.getRelationships(ctx, ownerUser, org);
    expect(explicitRels.length).toBe(1);
    expect(explicitRels).toEqual(["owner"]);

    // Should return owner, admin, and viewer because of inheritance!
    const rels = await zbar.getRelationships(ctx, ownerUser, org, undefined, {
      includeInherited: true,
    });

    expect(rels.length).toBe(3);
    expect(rels.sort()).toEqual(["admin", "owner", "viewer"]);
  });

  test("updateRelation swaps relationships via Add-before-Remove", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: zbarSchema,
      tenantId: "t1",
      asyncWrites: false, // forces synchronous execution so we can immediately assert
    });

    const user = { type: "user", id: "u_update" } as const;
    const org = { type: "org", id: "org1" } as const;

    // Start with viewer
    await zbar.addRelation(ctx, user, "viewer", org);

    expect(await zbar.hasRelationship(ctx, user, "viewer", org)).toBe(true);
    expect(await zbar.hasRelationship(ctx, user, "admin", org)).toBe(false);

    // Update to admin
    await zbar.updateRelation(ctx, user, "viewer", "admin", org);

    // Should now be admin
    expect(await zbar.hasRelationship(ctx, user, "admin", org)).toBe(true);
    // Since admin inherits viewer, they should still technically have viewer access
    expect(await zbar.hasRelationship(ctx, user, "viewer", org)).toBe(true);

    // However, if we check explicitly (includeInherited: false), viewer should be GONE
    const explicit = await zbar.getRelationships(ctx, user, org, undefined, {
      includeInherited: false,
    });
    expect(explicit).toEqual(["admin"]);
  });

  test("setRelation replaces all existing relationships with a single new one", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: zbarSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const user = { type: "user", id: "u_set" } as const;
    const org = { type: "org", id: "org1" } as const;

    // Start with explicitly BOTH viewer and admin
    await zbar.addRelation(ctx, user, "viewer", org);
    await zbar.addRelation(ctx, user, "admin", org);

    let explicit = await zbar.getRelationships(ctx, user, org, undefined, {
      includeInherited: false,
    });
    expect(explicit.sort()).toEqual(["admin", "viewer"]);

    // Override with JUST owner
    await zbar.setRelation(ctx, user, "owner", org);

    // The explicit relationships should ONLY be "owner" now
    explicit = await zbar.getRelationships(ctx, user, org, undefined, {
      includeInherited: false,
    });
    expect(explicit).toEqual(["owner"]);

    // But due to inheritance, they still have admin and viewer powers
    const all = await zbar.getRelationships(ctx, user, org, undefined, {
      includeInherited: true,
    });
    expect(all.sort()).toEqual(["admin", "owner", "viewer"]);
  });

  test("manual orchestration of background race condition", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: zbarSchema,
      tenantId: "t1",
      asyncWrites: false, // Run sync initially
    });

    const user = { type: "user", id: "u_manual" } as const;
    const org = { type: "org", id: "org_manual" } as const;

    // 1. Initial Setup: the user is a viewer.
    // This fully commits the viewer token to both `relationships` and `effectiveRelationships`.
    await zbar.addRelation(ctx, user, "viewer", org);

    expect(await zbar.hasRelationship(ctx, user, "viewer", org)).toBe(true);

    // 2. We will manually orchestrate the exact background payload that `updateRelation` generates
    // when upgrading "viewer" -> "admin".
    const graphConfig = (zbar as any).graphConfig;

    // Foreground step 1: delete the viewer base relation
    const viewerRel = await t.run(async (innerCtx) => {
      const rel = await innerCtx.db.query("relationships").first();
      if (!rel) throw new Error("No relation found");
      await innerCtx.db.delete(rel._id);
      return rel;
    });

    const onCompletePayload = {
      action: "enqueueRemoveChunk",
      args: {
        tenantId: "t1",
        queue: [
          {
            subject: user,
            relation: "viewer",
            object: org,
            removedRelationId: viewerRel!._id,
          },
        ],
        graphConfig,
      },
    };

    // Foreground step 2: insert the admin base relation
    const adminRelId = await t.run(async (innerCtx) => {
      return await innerCtx.db.insert("relationships", {
        tenantId: "t1",
        subjectType: "user",
        subjectId: "u_manual",
        relation: "admin",
        objectType: "org",
        objectId: "org_manual",
      });
    });

    // 3. THE RACE CONDITION: Before the background worker can process the `admin` AddChunk,
    // a rapid subsequent update (admin -> owner) deletes the `admin` base row!
    await t.run(async (innerCtx) => {
      await innerCtx.db.delete(adminRelId);
    });

    // 4. Now, the background worker for the original `admin` AddChunk finally executes.
    // It will look for `adminRelId`, realize it's missing (deleted by the race), and ABORT its expansion.
    // We are testing to ensure it STILL executes `onCompletePayload` (cleaning up viewer) despite aborting.
    await t.mutation(internal.mutations.processAddChunk, {
      tenantId: "t1",
      baseRelId: adminRelId, // The deleted ID!
      queue: [], // Queue doesn't matter, it aborts on baseRelId
      graphConfig,
      onComplete: onCompletePayload,
      asyncWrites: false, // Force it to run the fallback synchronously
    });

    // 5. Verification: Even though the `admin` worker aborted, the "viewer" cleanup should have cascaded!
    const explicit = await zbar.getRelationships(ctx, user, org, undefined, {
      includeInherited: false,
    });

    // Viewer should be completely scrubbed from effectiveRelationships!
    expect(explicit).toEqual([]);
  });

  test("resolvePermissionRelations correctly parses object-based conditional aliases", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const testSchema = createZbarSchema<any>()
      .condition("isPaid", (ctx, policy) => policy.data?.paid === true)
      .entity("user")
      .entity("org", (e) =>
        e
          .relation("admin", "user")
          .relation("viewer", "user", {
            relation: "admin",
            condition: "isPaid",
          })
          .permission("view", "viewer"),
      )
      .build();

    const zbar = new Zbar(api, {
      schema: testSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const user = { type: "user" as const, id: "u_cond_alias" };
    const org = { type: "org" as const, id: "org_cond_alias" };

    await zbar.addRelation(ctx, user, "admin", org);

    // Should not be able to view without isPaid condition
    let canView = await zbar.can(ctx, user, "view", org);
    expect(canView).toBe(false);

    // Should be able to view WITH isPaid condition
    canView = await zbar.can(ctx, user, "view", org, { paid: true });
    expect(canView).toBe(true);
  });

  test("removeRelation deletes reverse edges", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: zbarSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const user = { type: "user" as const, id: "u_rev_delete" };
    const org = { type: "org" as const, id: "org_rev_delete" };

    // 1. Add relation, which creates a reverse edge
    await zbar.addRelation(ctx, user, "owner", org);

    // Verify reverse edge was added
    const relsBefore = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: org,
      relations: ["owner_of_org"],
      object: user,
    });
    expect(relsBefore.length).toBe(1);

    // Check actual relationship table for reverse edge
    const baseRelsBefore = await t.run(async (innerCtx) => {
      return await innerCtx.db
        .query("relationships")
        .withIndex("by_tenant_subject_relation_object", (q: any) =>
          q
            .eq("tenantId", "t1")
            .eq("subjectType", "org")
            .eq("subjectId", "org_rev_delete")
            .eq("relation", "owner_of_org")
            .eq("objectType", "user")
            .eq("objectId", "u_rev_delete"),
        )
        .unique();
    });
    expect(baseRelsBefore).not.toBeNull();

    // 2. Remove relation
    await zbar.removeRelation(ctx, user, "owner", org);

    // Verify reverse edge was removed from effective relationships
    const relsAfter = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: org,
      relations: ["owner_of_org"],
      object: user,
    });
    expect(relsAfter.length).toBe(0);

    // Check actual relationship table to ensure reverse edge is deleted
    const baseRelsAfter = await t.run(async (innerCtx) => {
      return await innerCtx.db
        .query("relationships")
        .withIndex("by_tenant_subject_relation_object", (q: any) =>
          q
            .eq("tenantId", "t1")
            .eq("subjectType", "org")
            .eq("subjectId", "org_rev_delete")
            .eq("relation", "owner_of_org")
            .eq("objectType", "user")
            .eq("objectId", "u_rev_delete"),
        )
        .unique();
    });
    expect(baseRelsAfter).toBeNull();
  });
});
