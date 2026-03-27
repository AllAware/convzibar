import { expect, test, describe } from "vitest";
import { Authz, createAuthSchema } from "../index.js";
import { convexTest } from "convex-test";
import schema from "../../component/schema.js";
import { api } from "../../component/_generated/api.js";
import { register as registerWorkpool } from "@convex-dev/workpool/test";

const setup = () => {
  const t = convexTest(schema, import.meta.glob("../../component/**/*.ts"));
  registerWorkpool(t, "workpool");
  return t;
};

const authSchema = createAuthSchema<any>()
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
    // Use an instance of Authz, but we have to mock `runQuery` and `runMutation` inside `can`
    // Actually, `convexTest` gives us `t.query` and `t.mutation`. We can wrap them in a pseudo context:
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const authz = new Authz(api, {
      schema: authSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const user = { type: "user" as const, id: "u1" };
    const org1 = { type: "org" as const, id: "org1" };
    const org2 = { type: "org" as const, id: "org2" };

    await authz.addRelation(ctx, user, "owner", org1); // Should grant view_dashboard via inheritance
    await authz.addRelation(ctx, user, "viewer", org2); // Direct viewer

    const results = await authz.listAccessibleObjects(
      ctx,
      user,
      "view_dashboard",
      "org",
    );

    expect(results.length).toBe(2);
    expect(results.map((r) => r.objectId).sort()).toEqual(["org1", "org2"]);
  });

  test("listUsersWithAccess with local inheritance", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const authz = new Authz(api, {
      schema: authSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const ownerUser = { type: "user", id: "u_owner" } as const;
    const adminUser = { type: "user", id: "u_admin" } as const;
    const org = { type: "org", id: "org1" } as const;

    await authz.addRelation(ctx, ownerUser, "owner", org);
    await authz.addRelation(ctx, adminUser, "admin", org);

    // Both should have edit_settings
    const results = await authz.listUsersWithAccess(ctx, org, "edit_settings");

    expect(results.length).toBe(2);
    expect(results.map((r) => r.userId).sort()).toEqual(["u_admin", "u_owner"]);
  });

  test("bidirectional relationship auto-insertion", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const authz = new Authz(api, {
      schema: authSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const user = { type: "user", id: "u_owner" } as const;
    const org = { type: "org", id: "org1" } as const;

    await authz.addRelation(ctx, user, "owner", org);

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

    const authz = new Authz(api, {
      schema: authSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const user = { type: "user", id: "u_delete" } as const;
    const org = { type: "org", id: "org1" } as const;
    const project = { type: "project", id: "proj1" } as const;

    // user is owner of org (which gives viewer access to org, and editor access to proj if proj in org)
    await authz.addRelation(ctx, user, "owner", org);
    await authz.addRelation(ctx, project, "parent_org", org);

    const relsBefore = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["owner"],
      object: org,
    });
    expect(relsBefore.length).toBe(1);

    const res = await authz.deleteEntity(ctx, user);

    // relationshipsRemoved should be 2 (the owner relation, and the reverse owner_of_org relation)
    expect(res.relationshipsRemoved).toBe(2);
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

    const deepSchema = createAuthSchema<any>()
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

    const authz = new Authz(api, {
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
    await authz.addRelation(ctx, document, "parent_folder", folder);
    await authz.addRelation(ctx, folder, "parent_project", project);
    await authz.addRelation(ctx, project, "parent_org", org);

    // Give user viewer on Org
    await authz.addRelation(ctx, user, "viewer", org);

    // 1. Should NOT be able to read without condition context
    const canReadWithoutCtx = await authz.can(ctx, user, "read", document);
    expect(canReadWithoutCtx).toBe(false);

    // 2. Should be able to read WITH condition context
    const canReadWithCtx = await authz.can(ctx, user, "read", document, {
      approved: true,
    });
    expect(canReadWithCtx).toBe(true);

    // 3. List accessible objects (should return d1 when context matches)
    const accessibleDocs = await authz.listAccessibleObjects(
      ctx,
      user,
      "read",
      "document",
      { approved: true },
    );
    expect(accessibleDocs.length).toBe(1);
    expect(accessibleDocs[0].objectId).toBe("d1");

    // 4. Sever the graph by removing folder -> project
    await authz.removeRelation(ctx, folder, "parent_project", project);

    // Should NO LONGER be able to read even with context
    const canReadAfterDelete = await authz.can(ctx, user, "read", document, {
      approved: true,
    });
    expect(canReadAfterDelete).toBe(false);

    // 5. Re-link folder -> project, but this time with a hardcoded failing edge condition
    await authz.addRelation(ctx, folder, "parent_project", project, {
      condition: "isActive",
      conditionContext: { active: false },
    });

    // Even if we pass approved: true to the request context (for the target permission),
    // the edge condition itself will fail because it's hardcoded to active: false
    const canReadWithEdgeFalse = await authz.can(ctx, user, "read", document, {
      approved: true,
    });
    expect(canReadWithEdgeFalse).toBe(false);

    // 6. Fix the edge condition to be true
    await authz.removeRelation(ctx, folder, "parent_project", project);
    await authz.addRelation(ctx, folder, "parent_project", project, {
      condition: "isActive",
      conditionContext: { active: true },
    });

    // Now it should pass both the edge condition (active: true) AND the permission condition (approved: true)
    const canReadWithEdgeTrue = await authz.can(ctx, user, "read", document, {
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

    const testSchema = createAuthSchema<any>()
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

    const authz = new Authz(api, {
      schema: testSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const user = { type: "user", id: "u1" } as const;
    const document = { type: "document", id: "d1" } as const;
    const folder = { type: "folder", id: "f1" } as const;

    await authz.addRelation(ctx, document, "parent_folder", folder);
    await authz.addRelation(ctx, user, "viewer", folder);

    // Context without active: true -> fails
    let canView = await authz.can(ctx, user, "view", document);
    expect(canView).toBe(false);

    // Context with active: true -> passes
    canView = await authz.can(ctx, user, "view", document, { active: true });

    expect(canView).toBe(true);
  });

  test("auditLog is disabled when enableAuditLog is false", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const testSchema = createAuthSchema<any>()
      .entity("user")
      .entity("org", (e) => e.relation("owner", "user"))
      .build();

    const authz = new Authz(api, {
      schema: testSchema,
      tenantId: "t1",
      enableAuditLog: false,
      asyncWrites: false,
    });

    const user = { type: "user", id: "u1" } as const;
    const org = { type: "org", id: "o1" } as const;

    await authz.addRelation(ctx, user, "owner", org);

    const logs = await t.run(async (innerCtx) => {
      return await innerCtx.db.query("auditLog").collect();
    });

    expect(logs.length).toBe(0);

    const authzEnabled = new Authz(api, {
      schema: testSchema,
      tenantId: "t1",
      enableAuditLog: true,
      asyncWrites: false,
    });

    await authzEnabled.addRelation(
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
});
