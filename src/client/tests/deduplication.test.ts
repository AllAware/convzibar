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

// We define a schema that explicitly specifies inheritance both at the org level
// and at the distant project level to trigger traversal rule optimization deduplication.
const dedupSchema = createZbarSchema<any>()
  .entity("user")
  .entity("org", (e) =>
    e
      .relation("admin", "user")
      .relation("manager", "user", "admin")
      .relation("viewer", "user", "manager"),
  )
  .entity("project", (e) =>
    e
      .relation("parent_org", "org")
      .relation("admin", "user", "parent_org.admin")
      .relation("manager", "user", "parent_org.manager", "admin")
      .relation("viewer", "user", "parent_org.viewer", "manager")
      .permission("delete_project", "admin")
      .permission("edit_project", "manager")
      .permission("view_project", "viewer"),
  )
  .build();

describe("Schema Compiler Deduplication Integration", () => {
  test("granting admin triggers correct graph expansion with deduplication (minimal row)", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: dedupSchema,
      tenantId: "t1",
      asyncWrites: false, // Ensures all background tasks sync within the test execution
    });

    const user = { type: "user" as const, id: "u1" };
    const org = { type: "org" as const, id: "org1" };
    const project = { type: "project" as const, id: "proj1" };

    // Set up project graph
    await zbar.addRelation(ctx, org, "parent_org", project);

    // Granting admin to user in the org triggers distant rule evaluation
    // Since admin inherits manager and viewer locally on the project, the schema
    // compiler should prune the manager and viewer derivations to save database space.
    await zbar.addRelation(ctx, user, "admin", org);

    // 1. Check distant permissions via optimized graph traversals
    // Deduplication guarantees that manager and viewer rows weren't fully materialized,
    // but the graph resolution must work seamlessly for all actions.
    expect(await zbar.can(ctx, user, "delete_project", project)).toBe(true);
    expect(await zbar.can(ctx, user, "edit_project", project)).toBe(true);
    expect(await zbar.can(ctx, user, "view_project", project)).toBe(true);

    // 2. Verify that ONLY the dominant 'admin' row was propagated (the minimal row)
    const allRels = await ctx.runQuery(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      object: project,
      relations: ["admin", "manager", "viewer"],
    });

    // This expects the database to have efficiently stored ONLY "admin"
    expect(allRels).toHaveLength(1);
    expect(allRels[0].relation).toBe("admin");

    // 3. No direct (base) relationship between user and project exists —
    // the access is entirely through the distant materialisation.
    const directRels = await zbar.listDirect()
      .object(project)
      .subject(user)
      .collect(ctx);
    expect(directRels).toEqual([]);

    // Verify exactly 2 bases (org -> parent_org -> project, user -> admin -> org)
    // and 2 base effective + 1 distant materialization (admin) = 3
    await assertDbState(t, 2, 3);
  });
});
