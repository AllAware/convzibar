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
const mkCtx = (t: any) =>
  ({ runQuery: t.query.bind(t), runMutation: t.mutation.bind(t) }) as any;

// A derived path can collect the SAME condition from more than one segment
// (here: the base `admin` edge carries `once`, and the schema rule for
// `editor` also carries `once`). combinePath used to concatenate without
// dedup, so the materialised path baked `once` twice. validatePath threads a
// mutable context through condition evaluation, so a "middleware" condition
// that mutates context behaves DIFFERENTLY on its second run — flipping the
// result. `once` passes the first time and denies the second, so the
// duplicated path wrongly DENIES access that the single-occurrence path grants.
describe("combinePath condition de-duplication", () => {
  const mkSchema = () =>
    createZbarSchema<any>()
      // Passes the first time (and marks context); denies if it runs again.
      .condition("once", (_ctx, { data }: any) => {
        if (data.seen) return false;
        return { seen: true };
      })
      .entity("user")
      .entity("org", (e) => e.relation("admin", "user"))
      .entity("project", (e) =>
        e
          .relation("parent_org", { type: "org" })
          .relation("editor", { relation: "parent_org.admin", condition: "once" })
          .permission("edit", "editor"),
      )
      .build();

  test("a condition baked twice on a derived path evaluates once (deny→allow)", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, {
      schema: mkSchema(),
      tenantId: "t1",
      asyncWrites: false,
    });

    const user = { type: "user" as const, id: "u1" };
    const org = { type: "org" as const, id: "org1" };
    const project = { type: "project" as const, id: "proj1" };

    await zbar.addRelation(ctx, org, "parent_org", project);
    // Base edge ALSO carries `once`, so the derived editor path collects it
    // from both the base edge and the rule.
    await zbar.addRelation(ctx, user, "admin", org, { condition: "once" });

    // Structural: the materialised editor path must bake `once` exactly once.
    const editorPaths = await t.run(async (inner: any) => {
      const rows = await inner.db.query("effectiveRelationships").collect();
      const row = rows.find(
        (r: any) =>
          r.subjectKey === "user:u1" &&
          r.relation === "editor" &&
          r.objectKey === "project:proj1",
      );
      return row?.paths ?? [];
    });
    expect(editorPaths).toHaveLength(1);
    const onceCount = (editorPaths[0].conditions ?? []).filter(
      (c: any) => c.condition === "once",
    ).length;
    expect(onceCount).toBe(1);

    // Behavioural: evaluating `once` only once means it passes (grants edit).
    // With the duplicate it would run twice and the second run denies.
    expect(await zbar.can(ctx, user, "edit", project)).toBe(true);
  });
});
