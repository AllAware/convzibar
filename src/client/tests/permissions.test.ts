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

const zbarSchema = createZbarSchema()
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

const mkCtx = (t: any) =>
  ({
    runQuery: t.query.bind(t),
    runMutation: t.mutation.bind(t),
  }) as any;

const mkZbar = () =>
  new Zbar(api, {
    schema: zbarSchema,
    asyncWrites: false,
  });

describe("Permission Checks & Inference", () => {
  test(".can() infers local inheritance", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const user = { type: "user" as const, id: "u1" };
    const org1 = { type: "org" as const, id: "org1" };
    const org2 = { type: "org" as const, id: "org2" };

    await zbar.addRelation(ctx, user, "owner", org1);
    await zbar.addRelation(ctx, user, "viewer", org2);

    const results = await zbar
      .list()
      .object("org")
      .permission("view_dashboard")
      .subject(user)
      .collect(ctx);

    expect(results.length).toBe(2);
    expect(results.map((r) => r.objectId).sort()).toEqual(["org1", "org2"]);

    await assertDbState(t, 2, 2);
  });

  test(".can() infers distant inheritance", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const user = { type: "user" as const, id: "u1" };
    const org1 = { type: "org" as const, id: "org1" };
    const proj1 = { type: "project" as const, id: "proj1" };

    await zbar.addRelation(ctx, user, "owner", org1);
    await zbar.addRelation(ctx, user, "viewer", org1);
    await zbar.addRelation(ctx, org1, "parent_org", proj1);

    const results = await zbar
      .list()
      .object("project")
      .permission("edit")
      .subject(user)
      .collect(ctx);

    expect(results.length).toBe(1);
    expect(results.map((r) => r.objectId).sort()).toEqual(["proj1"]);

    const effectiveRelationships = await t.run(
      async (innerCtx) =>
        await innerCtx.db.query("effectiveRelationships").collect(),
    );

    const editorEffs = effectiveRelationships.filter(
      (eff) => eff.relation === "editor",
    );
    expect(editorEffs.length).toBe(1);
    expect(editorEffs[0].subjectKey).toBe("user:u1");
    expect(editorEffs[0].objectKey).toBe("project:proj1");

    await assertDbState(t, 3, 4);
  });

  test("list subjects with local inheritance", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const ownerUser = { type: "user", id: "u_owner" } as const;
    const adminUser = { type: "user", id: "u_admin" } as const;
    const org = { type: "org", id: "org1" } as const;

    await zbar.addRelation(ctx, ownerUser, "owner", org);
    await zbar.addRelation(ctx, adminUser, "admin", org);

    const results = await zbar
      .list()
      .object(org)
      .permission("edit_settings")
      .subject("user")
      .collect(ctx);

    expect(results.length).toBe(2);
    expect(results.map((r) => r.subjectId).sort()).toEqual([
      "u_admin",
      "u_owner",
    ]);

    await assertDbState(t, 2, 2);
  });

  test("hasRelationship respects inheritance", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const ownerUser = { type: "user", id: "u_owner" } as const;
    const adminUser = { type: "user", id: "u_admin" } as const;
    const org = { type: "org", id: "org1" } as const;

    await zbar.addRelation(ctx, ownerUser, "owner", org);
    await zbar.addRelation(ctx, adminUser, "admin", org);

    expect(await zbar.hasRelationship(ctx, ownerUser, "viewer", org)).toBe(true);
    expect(await zbar.hasRelationship(ctx, adminUser, "viewer", org)).toBe(true);
    expect(await zbar.hasRelationship(ctx, adminUser, "owner", org)).toBe(false);

    await assertDbState(t, 2, 2);
  });

  test("deeply nested read-time inference and deletions", async () => {
    const t = setup();
    const ctx = mkCtx(t);

    const deepSchema = createZbarSchema()
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
          .permission("read", "viewer"),
      )
      .build();

    const zbar = new Zbar(api, {
      schema: deepSchema,
      asyncWrites: false,
    });

    const user = { type: "user", id: "u_nested" } as const;
    const org = { type: "org", id: "o1" } as const;
    const project = { type: "project", id: "p1" } as const;
    const folder = { type: "folder", id: "f1" } as const;
    const document = { type: "document", id: "d1" } as const;

    await zbar.addRelation(ctx, folder, "parent_folder", document);
    await zbar.addRelation(ctx, project, "parent_project", folder);
    await zbar.addRelation(ctx, org, "parent_org", project);
    await zbar.addRelation(ctx, user, "viewer", org);

    expect(await zbar.can(ctx, user, "read", document)).toBe(true);

    const accessibleDocs = await zbar
      .list()
      .object("document")
      .permission("read")
      .subject(user)
      .collect(ctx);
    expect(accessibleDocs.length).toBe(1);
    expect(accessibleDocs[0].objectId).toBe("d1");

    // Sever the graph — the nested inference chain must break.
    await zbar.removeRelation(ctx, project, "parent_project", folder);
    expect(await zbar.can(ctx, user, "read", document)).toBe(false);

    // Re-link — access is restored once the chain is whole again.
    await zbar.addRelation(ctx, project, "parent_project", folder);
    expect(await zbar.can(ctx, user, "read", document)).toBe(true);

    await assertDbState(t, 4, 7);
  });
});

describe("Validation", () => {
  test("validateRelationParameter rejects invalid relation name", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const user = { type: "user" as const, id: "u1" };
    const org = { type: "org" as const, id: "org1" };

    await expect(
      zbar.addRelation(ctx, user, "nonexistent" as any, org),
    ).rejects.toThrow("Relation 'nonexistent' is not defined for object type 'org'");
  });

  test("validateRelationParameter rejects invalid subject type", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const project = { type: "project" as const, id: "proj1" };
    const org = { type: "org" as const, id: "org1" };

    await expect(
      zbar.addRelation(ctx, project, "owner" as any, org),
    ).rejects.toThrow("Subject type 'project' is not a valid subject");
  });
});
