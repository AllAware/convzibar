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

describe("Fluent listDirect() Query Builder", () => {
  test("object({type,id}) returns all direct relationships for that object", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, alice, "owner", org);
    await zbar.addRelation(ctx, bob, "viewer", org);

    const rels = await zbar.listDirect().object(org).collect(ctx);

    expect(rels.length).toBe(2);
    expect(
      rels.map((r) => `${r.subject.id}:${r.relation}`).sort(),
    ).toEqual(["alice:owner", "bob:viewer"]);
  });

  test("subject({type,id}) returns all direct relationships for that subject", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const org1 = { type: "org" as const, id: "org1" };
    const org2 = { type: "org" as const, id: "org2" };

    await zbar.addRelation(ctx, alice, "owner", org1);
    await zbar.addRelation(ctx, alice, "viewer", org2);

    const rels = await zbar.listDirect().subject(alice).collect(ctx);

    expect(rels.length).toBe(2);
    expect(
      rels.map((r) => `${r.object.id}:${r.relation}`).sort(),
    ).toEqual(["org1:owner", "org2:viewer"]);
  });

  test("object + subject returns direct relationships between the pair", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, alice, "owner", org);
    await zbar.addRelation(ctx, bob, "viewer", org);

    const rels = await zbar.listDirect().object(org).subject(alice).collect(ctx);

    expect(rels.length).toBe(1);
    expect(rels[0].relation).toBe("owner");
  });

  test(".relation() filters with inheritance", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const org = { type: "org" as const, id: "org1" };

    // owner inherits admin inherits viewer
    await zbar.addRelation(ctx, alice, "owner", org);
    await zbar.addRelation(ctx, bob, "viewer", org);

    // Filter by "viewer": should include alice (owner→admin→viewer) AND bob (viewer)
    const viewers = await zbar.listDirect().object(org).relation("viewer").collect(ctx);
    expect(viewers.length).toBe(2);
    expect(viewers.map((r) => r.subject.id).sort()).toEqual(["alice", "bob"]);

    // Filter by "admin": should include alice (owner→admin) but NOT bob (viewer doesn't inherit admin)
    const admins = await zbar.listDirect().object(org).relation("admin").collect(ctx);
    expect(admins.length).toBe(1);
    expect(admins[0].subject.id).toBe("alice");

    // Filter by "owner": should only include alice
    const owners = await zbar.listDirect().object(org).relation("owner").collect(ctx);
    expect(owners.length).toBe(1);
    expect(owners[0].subject.id).toBe("alice");
  });

  test(".permission() filters by permission-contributing relations", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, alice, "owner", org);
    await zbar.addRelation(ctx, bob, "viewer", org);

    // Permission "edit_settings" maps to admin (which includes owner)
    const editors = await zbar.listDirect().object(org).permission("edit_settings").collect(ctx);
    expect(editors.length).toBe(1);
    expect(editors[0].subject.id).toBe("alice");

    // Permission "view_dashboard" maps to viewer (which includes admin→owner)
    const dashViewers = await zbar
      .listDirect()
      .object(org)
      .permission("view_dashboard")
      .collect(ctx);
    expect(dashViewers.length).toBe(2);
  });

  test("object(type) filters by object type only", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const org1 = { type: "org" as const, id: "org1" };
    const org2 = { type: "org" as const, id: "org2" };

    await zbar.addRelation(ctx, alice, "owner", org1);
    await zbar.addRelation(ctx, alice, "viewer", org2);

    // Query by subject + object type (no specific id)
    const rels = await zbar
      .listDirect()
      .subject(alice)
      .object("org")
      .collect(ctx);

    expect(rels.length).toBe(2);
  });

  test("subject(type) filters by subject type only", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, alice, "owner", org);
    await zbar.addRelation(ctx, bob, "viewer", org);

    const rels = await zbar
      .listDirect()
      .object(org)
      .subject("user")
      .collect(ctx);

    expect(rels.length).toBe(2);
  });

  test("no object or subject returns empty", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    // Cast to any to bypass the type system — the builder safely
    // returns [] when neither object nor subject is provided.
    const result = await (zbar.listDirect() as any).collect(ctx);
    expect(result).toEqual([]);
  });

  test(".map() transforms results in parallel", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, alice, "owner", org);
    await zbar.addRelation(ctx, bob, "viewer", org);

    const summaries = await zbar
      .listDirect()
      .object(org)
      .map((r) => `${r.subject.id} is ${r.relation}`)
      .collect(ctx);

    expect(summaries.sort()).toEqual([
      "alice is owner",
      "bob is viewer",
    ]);
  });

  test(".map() works with async mapper", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, alice, "owner", org);

    const results = await zbar
      .listDirect()
      .object(org)
      .map(async (r) => {
        return { who: r.subject.id, role: r.relation };
      })
      .collect(ctx);

    expect(results).toEqual([{ who: "alice", role: "owner" }]);
  });

  test("result shape includes full subject and object", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();

    const alice = { type: "user" as const, id: "alice" };
    const org = { type: "org" as const, id: "org1" };

    await zbar.addRelation(ctx, alice, "owner", org);

    const [rel] = await zbar.listDirect().object(org).collect(ctx);

    expect(rel).toEqual({
      subject: { type: "user", id: "alice" },
      relation: "owner",
      object: { type: "org", id: "org1" },
    });
  });
});
