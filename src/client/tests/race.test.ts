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

const zbarSchema = createZbarSchema()
  .entity("user")
  .entity("org", (e) =>
    e
      .relation("owner", "user")
      .relation("admin", "user", "owner")
      .relation("viewer", "user", "admin"),
  )
  .entity("project", (e) =>
    e
      .relation("parent_org", "org")
      .relation("editor", "user", "parent_org.admin"),
  )
  .build();

const executeNextMockTask = async (t: any) => {
  const task = await t.mutation(internal.mutations.popMockWorkpool);
  if (!task) return false;

  if (task.mutationName === "processAddChunk") {
    await t.mutation(internal.mutations.processAddChunk, task.args);
  } else if (task.mutationName === "processRemoveChunk") {
    await t.mutation(internal.mutations.processRemoveChunk, task.args);
  } else {
    throw new Error(`Unknown mock task: ${task.mutationName}`);
  }
  return true;
};

const drainMockWorkpool = async (t: any) => {
  let executed = true;
  while (executed) {
    executed = await executeNextMockTask(t);
  }
};

describe("Asynchronous Race Conditions", () => {
  test("mockWorkpool: setRelation followed by synchronous delete leaves no orphans", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: zbarSchema,
      asyncWrites: true,
    });

    // Enable the mock workpool interceptor
    (zbar as any).graphConfig.mockWorkpool = true;

    const user = { type: "user", id: "u_mock" } as const;
    const org = { type: "org", id: "org_mock" } as const;

    await zbar.addRelation(ctx, user, "viewer", org);
    await drainMockWorkpool(t);

    expect(
      (await zbar.listDirect().object(org).subject(user).collect(ctx)).map(
        (r) => r.relation,
      ),
    ).toEqual(["viewer"]);

    // setRelation to "owner" drops "viewer" and adds "owner"; the add chunks
    // are trapped in the mock table.
    await zbar.setRelation(ctx, user, "owner", org);

    // Synchronously delete the newly inserted "owner" before any mock task runs.
    const zbarSync = new Zbar(api, {
      schema: zbarSchema,
      asyncWrites: false,
    });
    await zbarSync.removeRelation(ctx, user, "owner", org);

    // Now run the trapped tasks: the "owner" add chunk sees its base gone,
    // aborts expansion, but STILL fires the batched "viewer" cleanup.
    await drainMockWorkpool(t);

    const explicit = await zbar.listDirect().object(org).subject(user).collect(ctx);
    expect(explicit).toEqual([]);
  });

  test("manual orchestration of background race condition (updateRelation)", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: zbarSchema,
      asyncWrites: false,
    });

    const user = { type: "user", id: "u_manual" } as const;
    const org = { type: "org", id: "org_manual" } as const;

    // Initial setup (also registers the compiled config with the component).
    await zbar.addRelation(ctx, user, "viewer", org);
    expect(await zbar.hasRelationship(ctx, user, "viewer", org)).toBe(true);
    const configHash = (zbar as any).configHash as string;

    // Foreground step 1: delete the viewer base relation.
    const viewerRel = await t.run(async (innerCtx) => {
      const rel = await innerCtx.db.query("relationships").first();
      if (!rel) throw new Error("No relation found");
      await innerCtx.db.delete(rel._id);
      return rel;
    });

    const onCompletePayload = {
      action: "enqueueRemoveChunk",
      args: {
        queue: [
          {
            subject: user,
            relation: "viewer",
            object: org,
            removedRelationId: viewerRel._id,
          },
        ],
      },
    };

    // Foreground step 2: insert the admin base relation.
    const adminRelId = await t.run(async (innerCtx) => {
      return await innerCtx.db.insert("relationships", {
        subjectType: "user",
        subjectId: "u_manual",
        relation: "admin",
        objectType: "org",
        objectId: "org_manual",
      });
    });

    // THE RACE: a rapid subsequent update deletes the admin base row before
    // the background AddChunk processes it.
    await t.run(async (innerCtx) => {
      await innerCtx.db.delete(adminRelId);
    });

    // The aborted AddChunk must STILL fire onComplete (cleaning up viewer).
    await t.mutation(internal.mutations.processAddChunk, {
      baseRelId: adminRelId,
      queue: [],
      configHash,
      onComplete: onCompletePayload,
      asyncWrites: false,
    });

    const explicit = await zbar.listDirect().object(org).subject(user).collect(ctx);
    expect(explicit).toEqual([]);
  });

  test("manual orchestration of batched cleanup (setRelation)", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: zbarSchema,
      asyncWrites: false,
    });

    const user = { type: "user", id: "u_batch" } as const;
    const org = { type: "org", id: "org_batch" } as const;

    await zbar.addRelation(ctx, user, "viewer", org);
    await zbar.addRelation(ctx, user, "admin", org);
    const configHash = (zbar as any).configHash as string;

    let explicit = await zbar.listDirect().object(org).subject(user).collect(ctx);
    expect(explicit.map((r) => r.relation).sort()).toEqual(["admin", "viewer"]);

    const relationsToDrop = await t.run(async (innerCtx) => {
      const rels = await innerCtx.db.query("relationships").collect();
      for (const r of rels) {
        await innerCtx.db.delete(r._id);
      }
      return rels;
    });

    const onCompleteArgs = relationsToDrop.map((r: any) => ({
      queue: [
        {
          subject: user,
          relation: r.relation,
          object: org,
          removedRelationId: r._id,
        },
      ],
    }));

    const onCompletePayload = {
      action: "enqueueRemoveChunkBatch",
      args: onCompleteArgs,
    };

    const ownerRelId = await t.run(async (innerCtx) => {
      return await innerCtx.db.insert("relationships", {
        subjectType: "user",
        subjectId: "u_batch",
        relation: "owner",
        objectType: "org",
        objectId: "org_batch",
      });
    });

    await t.run(async (innerCtx) => {
      await innerCtx.db.delete(ownerRelId);
    });

    await t.mutation(internal.mutations.processAddChunk, {
      baseRelId: ownerRelId,
      queue: [],
      configHash,
      onComplete: onCompletePayload,
      asyncWrites: false,
    });

    explicit = await zbar.listDirect().object(org).subject(user).collect(ctx);
    expect(explicit).toEqual([]);
  });

  test("phantom-path prevention (Add + Immediate Remove)", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: zbarSchema,
      asyncWrites: false,
    });

    const user = { type: "user", id: "u_phantom" } as const;
    const org = { type: "org", id: "org_phantom" } as const;
    const proj = { type: "project", id: "proj_phantom" } as const;

    await zbar.addRelation(ctx, org, "parent_org", proj);
    const configHash = (zbar as any).configHash as string;

    const adminRelId = await t.run(async (innerCtx) => {
      return await innerCtx.db.insert("relationships", {
        subjectType: "user",
        subjectId: "u_phantom",
        relation: "admin",
        objectType: "org",
        objectId: "org_phantom",
      });
    });

    await t.run(async (innerCtx) => {
      await innerCtx.db.delete(adminRelId);
    });

    await t.mutation(internal.mutations.processAddChunk, {
      baseRelId: adminRelId,
      queue: [
        {
          subject: user,
          relation: "admin",
          object: org,
          path: { baseIds: [adminRelId] },
          depth: 1,
        },
      ],
      configHash,
      asyncWrites: false,
    });

    const isEditor = await zbar.hasRelationship(ctx, user, "editor", proj);
    expect(isEditor).toBe(false);
  });

  test("deep synchronous write cleanly chains synchronous chunks without failing", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const deepSchema = createZbarSchema()
      .entity("user")
      .entity("level1", (e) => e.relation("r", "user"))
      .entity("level2", (e) =>
        e.relation("parent", "level1").relation("r", "user", "parent.r"),
      )
      .entity("level3", (e) =>
        e.relation("parent", "level2").relation("r", "user", "parent.r"),
      )
      .entity("level4", (e) =>
        e.relation("parent", "level3").relation("r", "user", "parent.r"),
      )
      .entity("level5", (e) =>
        e.relation("parent", "level4").relation("r", "user", "parent.r"),
      )
      .build();

    const zbar = new Zbar(api, {
      schema: deepSchema,
      asyncWrites: false,
    });

    // Force multiple chunk splits.
    (zbar as any).graphConfig.maxChunkSize = 2;

    const user = { type: "user", id: "u_deep" } as const;
    const l1 = { type: "level1", id: "1" } as const;
    const l2 = { type: "level2", id: "2" } as const;
    const l3 = { type: "level3", id: "3" } as const;
    const l4 = { type: "level4", id: "4" } as const;
    const l5 = { type: "level5", id: "5" } as const;

    await zbar.addRelation(ctx, l4, "parent", l5);
    await zbar.addRelation(ctx, l3, "parent", l4);
    await zbar.addRelation(ctx, l2, "parent", l3);
    await zbar.addRelation(ctx, l1, "parent", l2);

    await zbar.addRelation(ctx, user, "r", l1);

    const hasDeepAccess = await zbar.hasRelationship(ctx, user, "r", l5);
    expect(hasDeepAccess).toBe(true);

    await zbar.removeRelation(ctx, user, "r", l1);

    const hasDeepAccessAfterRemove = await zbar.hasRelationship(ctx, user, "r", l5);
    expect(hasDeepAccessAfterRemove).toBe(false);
  });

  test("bug: toggling parallel paths causes memory leak in downstream derived relationships", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const deepSchema = createZbarSchema()
      .entity("user")
      .entity("org", (e) => e.relation("admin", "user"))
      .entity("project", (e) =>
        e.relation("parent", "org").relation("editor", "user", "parent.admin"),
      )
      .entity("document", (e) =>
        e
          .relation("parent", "project")
          .relation("writer", "user", "parent.editor"),
      )
      .build();

    const zbar = new Zbar(api, {
      schema: deepSchema,
      asyncWrites: false,
    });

    const user = { type: "user", id: "u_bloat" } as const;
    const org1 = { type: "org", id: "org_bloat1" } as const;
    const org2 = { type: "org", id: "org_bloat2" } as const;
    const proj = { type: "project", id: "proj_bloat" } as const;
    const doc = { type: "document", id: "doc_bloat" } as const;

    await zbar.addRelation(ctx, proj, "parent", doc);
    await zbar.addRelation(ctx, org1, "parent", proj);
    await zbar.addRelation(ctx, org2, "parent", proj);

    await zbar.addRelation(ctx, user, "admin", org2);

    for (let i = 0; i < 10; i++) {
      await zbar.addRelation(ctx, user, "admin", org1);
      await zbar.removeRelation(ctx, user, "admin", org1);
    }

    const writerEff = await t.run(async (innerCtx) => {
      return await innerCtx.db
        .query("effectiveRelationships")
        .filter((q: any) => q.eq(q.field("subjectKey"), "user:u_bloat"))
        .filter((q: any) => q.eq(q.field("relation"), "writer"))
        .filter((q: any) => q.eq(q.field("objectKey"), "document:doc_bloat"))
        .first();
    });

    expect(writerEff!.paths.length).toBe(1);
  });

  test("bug: processRemoveChunk leaves orphaned paths in derived relationships if parent is not fully deleted", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: zbarSchema,
      asyncWrites: false,
    });

    const user = { type: "user", id: "u_orphan" } as const;
    const org = { type: "org", id: "org_orphan" } as const;
    const proj = { type: "project", id: "proj_orphan" } as const;

    await zbar.addRelation(ctx, org, "parent_org", proj);

    // User is BOTH owner AND admin of Org explicitly. owner→admin→viewer, so
    // admin on Org has 2 lineage paths.
    await zbar.addRelation(ctx, user, "owner", org);
    await zbar.addRelation(ctx, user, "admin", org);

    expect(await zbar.hasRelationship(ctx, user, "editor", proj)).toBe(true);

    // Remove owner (admin drops from 2 paths to 1) then admin.
    await zbar.removeRelation(ctx, user, "owner", org);
    await zbar.removeRelation(ctx, user, "admin", org);

    const explicit = await zbar.listDirect().object(org).subject(user).collect(ctx);
    expect(explicit).toEqual([]);

    const hasEditor = await zbar.hasRelationship(ctx, user, "editor", proj);
    expect(hasEditor).toBe(false);
  });
});
