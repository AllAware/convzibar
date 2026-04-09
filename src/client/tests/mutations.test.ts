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

const mkCtx = (t: any) =>
  ({
    runQuery: t.query.bind(t),
    runMutation: t.mutation.bind(t),
  }) as any;

const mkZbar = () =>
  new Zbar(api, {
    schema: zbarSchema,
    tenantId: "t1",
    asyncWrites: false,
  });

describe("Mutation Operations", () => {
  test("deleteEntity removes all associated relationships", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const user = { type: "user", id: "u_delete" } as const;
    const org = { type: "org", id: "org1" } as const;
    const project = { type: "project", id: "proj1" } as const;

    await zbar.addRelation(ctx, user, "owner", org);
    await zbar.addRelation(ctx, org, "parent_org", project);

    const relsBefore = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["owner"],
      object: org,
    });
    expect(relsBefore.length).toBe(1);

    const res = await zbar.deleteEntity(ctx, user);

    expect(res.relationshipsRemoved).toBe(1);
    expect(res.effectiveRelationshipsRemoved).toBeGreaterThan(0);

    const relsAfter = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["owner"],
      object: org,
    });
    expect(relsAfter.length).toBe(0);

    const relationships = await t.run(
      async (innerCtx) => await innerCtx.db.query("relationships").collect(),
    );
    const effectiveRelationships = await t.run(
      async (innerCtx) =>
        await innerCtx.db.query("effectiveRelationships").collect(),
    );

    expect(relationships.length).toBe(1);
    expect(relationships[0].relation).toBe("parent_org");
    expect(effectiveRelationships.length).toBe(1);
    expect(effectiveRelationships[0].relation).toBe("parent_org");
  });

  test("updateRelation swaps relationships via Add-before-Remove", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const user = { type: "user", id: "u_update" } as const;
    const org = { type: "org", id: "org1" } as const;

    await zbar.addRelation(ctx, user, "viewer", org);

    expect(await zbar.hasRelationship(ctx, user, "viewer", org)).toBe(true);
    expect(await zbar.hasRelationship(ctx, user, "admin", org)).toBe(false);

    await zbar.updateRelation(ctx, user, "viewer", "admin", org);

    expect(await zbar.hasRelationship(ctx, user, "admin", org)).toBe(true);
    expect(await zbar.hasRelationship(ctx, user, "viewer", org)).toBe(true);

    const explicit = await zbar.listDirect()
      .object(org)
      .subject(user)
      .collect(ctx);
    expect(explicit.map((r) => r.relation)).toEqual(["admin"]);

    await assertDbState(t, 1, 1);
  });

  test("setRelation replaces all existing relationships with a single new one", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const user = { type: "user", id: "u_set" } as const;
    const org = { type: "org", id: "org1" } as const;

    await zbar.addRelation(ctx, user, "viewer", org);
    await zbar.addRelation(ctx, user, "admin", org);

    let explicit = await zbar.listDirect()
      .object(org)
      .subject(user)
      .collect(ctx);
    expect(explicit.map((r) => r.relation).sort()).toEqual(["admin", "viewer"]);

    await zbar.setRelation(ctx, user, "owner", org);

    explicit = await zbar.listDirect()
      .object(org)
      .subject(user)
      .collect(ctx);
    expect(explicit.map((r) => r.relation)).toEqual(["owner"]);

    const all = await zbar.listDirect()
      .object(org)
      .subject(user)
      .relation("viewer")
      .collect(ctx);
    expect(all.map((r) => r.relation)).toEqual(["owner"]);

    await assertDbState(t, 1, 1);
  });

  test("auditLog is disabled when enableAuditLog is false", async () => {
    const t = setup();
    const ctx = mkCtx(t);

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

    await assertDbState(t, 2, 2);
  });
});
