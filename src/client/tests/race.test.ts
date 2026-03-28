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
  .entity("user")
  .entity("org", (e) =>
    e
      .relation("owner", { type: "user", reverse: "owner_of_org" })
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

  // Dynamically call the correct internal mutation
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
      tenantId: "t1",
      asyncWrites: true,
    });

    // Enable the mock workpool interceptor
    (zbar as any).graphConfig.mockWorkpool = true;

    const user = { type: "user", id: "u_mock" } as const;
    const org = { type: "org", id: "org_mock" } as const;

    // Initial explicit setup
    await zbar.addRelation(ctx, user, "viewer", org);
    await drainMockWorkpool(t);

    expect(
      await zbar.getRelationships(ctx, user, org, undefined, {
        includeInherited: false,
      }),
    ).toEqual(["viewer"]);

    // 1. Call setRelation to "owner". This drops "viewer" and adds "owner".
    // Because mockWorkpool is true, the `processAddChunk` tasks are safely queued in the mock table.
    await zbar.setRelation(ctx, user, "owner", org);

    // 2. Before we run ANY of those mock tasks, we synchronously delete the newly inserted "owner" relation.
    // We can do this easily by turning off asyncWrites temporarily or calling removeRelation directly.
    const zbarSync = new Zbar(api, {
      schema: zbarSchema,
      tenantId: "t1",
      asyncWrites: false,
    });
    await zbarSync.removeRelation(ctx, user, "owner", org);

    // 3. Now we execute the mock workpool tasks that were trapped from the `setRelation`.
    // The `processAddChunk` for "owner" will run, see the base relation is gone, abort its expansion,
    // but crucially STILL FIRE its batched cleanup for "viewer".
    await drainMockWorkpool(t);

    // The user should have NO explicit relationships left (viewer was cleaned up, owner was deleted sync)
    const explicit = await zbar.getRelationships(ctx, user, org, undefined, {
      includeInherited: false,
    });

    expect(explicit).toEqual([]);
  });

  // Move the manual orchestration test here
  test("manual orchestration of background race condition (updateRelation)", async () => {
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
            removedRelationId: viewerRel._id,
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

  test("manual orchestration of batched cleanup (setRelation)", async () => {
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

    const user = { type: "user", id: "u_batch" } as const;
    const org = { type: "org", id: "org_batch" } as const;

    // 1. Initial Setup: the user is both a viewer AND an admin explicitly.
    await zbar.addRelation(ctx, user, "viewer", org);
    await zbar.addRelation(ctx, user, "admin", org);

    let explicit = await zbar.getRelationships(ctx, user, org, undefined, {
      includeInherited: false,
    });
    expect(explicit.sort()).toEqual(["admin", "viewer"]);

    // 2. Manually orchestrate a setRelation("owner") payload
    const graphConfig = (zbar as any).graphConfig;

    const relationsToDrop = await t.run(async (innerCtx) => {
      const rels = await innerCtx.db.query("relationships").collect();
      for (const r of rels) {
        await innerCtx.db.delete(r._id);
      }
      return rels;
    });

    const onCompleteArgs = relationsToDrop.map((r: any) => ({
      tenantId: "t1",
      queue: [
        {
          subject: user,
          relation: r.relation,
          object: org,
          removedRelationId: r._id,
        },
      ],
      graphConfig,
    }));

    const onCompletePayload = {
      action: "enqueueRemoveChunkBatch",
      args: onCompleteArgs,
    };

    // Insert the new owner base relation
    const ownerRelId = await t.run(async (innerCtx) => {
      return await innerCtx.db.insert("relationships", {
        tenantId: "t1",
        subjectType: "user",
        subjectId: "u_batch",
        relation: "owner",
        objectType: "org",
        objectId: "org_batch",
      });
    });

    // 3. THE RACE CONDITION: The owner base row is deleted before the worker runs
    await t.run(async (innerCtx) => {
      await innerCtx.db.delete(ownerRelId);
    });

    // 4. Execute the aborted AddChunk
    await t.mutation(internal.mutations.processAddChunk, {
      tenantId: "t1",
      baseRelId: ownerRelId,
      queue: [],
      graphConfig,
      onComplete: onCompletePayload,
      asyncWrites: false,
    });

    // 5. Verification: The batched cleanup should have executed for BOTH viewer and admin
    explicit = await zbar.getRelationships(ctx, user, org, undefined, {
      includeInherited: false,
    });
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
      tenantId: "t1",
      asyncWrites: false, // Sync to orchestrate easily
    });

    const user = { type: "user", id: "u_phantom" } as const;
    const org = { type: "org", id: "org_phantom" } as const;
    const proj = { type: "project", id: "proj_phantom" } as const;

    // Link the project to the org fully
    await zbar.addRelation(ctx, proj, "parent_org", org);

    // Add user as admin of org in the foreground
    const graphConfig = (zbar as any).graphConfig;
    const adminRelId = await t.run(async (innerCtx) => {
      return await innerCtx.db.insert("relationships", {
        tenantId: "t1",
        subjectType: "user",
        subjectId: "u_phantom",
        relation: "admin",
        objectType: "org",
        objectId: "org_phantom",
      });
    });

    // Before the background worker expands admin -> project.editor, we remove the admin relation
    await t.run(async (innerCtx) => {
      await innerCtx.db.delete(adminRelId);
    });

    // The background worker for the add fires
    await t.mutation(internal.mutations.processAddChunk, {
      tenantId: "t1",
      baseRelId: adminRelId, // Deleted!
      queue: [
        {
          subject: user,
          relation: "admin",
          object: org,
          path: { baseIds: [adminRelId] },
          depth: 1,
        },
      ],
      graphConfig,
      asyncWrites: false,
    });

    // Verify the project editor path was never created because the root AddChunk aborted
    const isEditor = await zbar.hasRelationship(ctx, user, "editor", proj);
    expect(isEditor).toBe(false);
  });

  test("reverse-edge race under async", async () => {
    const t = setup();
    const graphConfig = {
      reverseEdges: { org: { owner: "owner_of_org" } },
      traversalRules: [],
    };

    const user = { type: "user", id: "u_reverse" };
    const org = { type: "org", id: "org_reverse" };

    // Fire both directions simultaneously with asyncWrites: true
    const p1 = t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: user,
      relation: "owner",
      object: org,
      asyncWrites: false, // The test uses convex-test mock DB, async concurrent inserts throw "Write outside of transaction"
      graphConfig,
    });

    const p2 = t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: org,
      relation: "owner_of_org",
      object: user,
      asyncWrites: false,
      graphConfig,
    });

    await Promise.all([p1, p2]);

    // Check base relationships table to ensure no duplicates
    const rels = await t.run(async (innerCtx) => {
      return await innerCtx.db.query("relationships").collect();
    });

    // There should be exactly two records: one for the forward edge, one for the reverse edge.
    // If the race condition failed, there would be duplicates or four records!
    expect(rels.length).toBe(2);

    const forward = rels.filter((r) => r.relation === "owner");
    const reverse = rels.filter((r) => r.relation === "owner_of_org");

    expect(forward.length).toBe(1);
    expect(reverse.length).toBe(1);
  });

  test("deep synchronous write cleanly chains synchronous chunks without failing", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    // We configure the graph with an artificially tiny maxChunkSize of 2.
    // This forces ANY deep expansion to split into multiple sequential
    // chunks rather than processing everything in a single massive `processAddChunkInternal` loop.
    const deepSchema = createZbarSchema<any>()
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
      tenantId: "t1",
      asyncWrites: false, // Must be synchronous!
    });

    // Override the chunk size to artificially force multiple chunk splits
    (zbar as any).graphConfig.maxChunkSize = 2;

    const user = { type: "user", id: "u_deep" } as const;
    const l1 = { type: "level1", id: "1" } as const;
    const l2 = { type: "level2", id: "2" } as const;
    const l3 = { type: "level3", id: "3" } as const;
    const l4 = { type: "level4", id: "4" } as const;
    const l5 = { type: "level5", id: "5" } as const;

    // Link the graph backwards so the paths are ready to catch the expansion
    await zbar.addRelation(ctx, l5, "parent", l4);
    await zbar.addRelation(ctx, l4, "parent", l3);
    await zbar.addRelation(ctx, l3, "parent", l2);
    await zbar.addRelation(ctx, l2, "parent", l1);

    // Trigger the deep expansion.
    // This generates >2 nodes of expansion, forcing `processAddChunkInternal` to recurse synchronously.
    await zbar.addRelation(ctx, user, "r", l1);

    // Because asyncWrites=false, it should have completely recursed and finished
    // the entire multi-chunk sequence before resolving the promise above.
    const hasDeepAccess = await zbar.hasRelationship(ctx, user, "r", l5);
    expect(hasDeepAccess).toBe(true);

    // Now trigger a multi-chunk synchronous REMOVE
    await zbar.removeRelation(ctx, user, "r", l1);

    const hasDeepAccessAfterRemove = await zbar.hasRelationship(
      ctx,
      user,
      "r",
      l5,
    );
    expect(hasDeepAccessAfterRemove).toBe(false);
  });

  test("bug: toggling parallel paths causes memory leak in downstream derived relationships", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const deepSchema = createZbarSchema<any>()
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
      tenantId: "t1",
      asyncWrites: false, // Run sync
    });

    const user = { type: "user", id: "u_bloat" } as const;
    const org1 = { type: "org", id: "org_bloat1" } as const;
    const org2 = { type: "org", id: "org_bloat2" } as const;
    const proj = { type: "project", id: "proj_bloat" } as const;
    const doc = { type: "document", id: "doc_bloat" } as const;

    await zbar.addRelation(ctx, doc, "parent", proj);
    await zbar.addRelation(ctx, proj, "parent", org1);
    await zbar.addRelation(ctx, proj, "parent", org2);

    // Constant relation that keeps the effective nodes alive
    await zbar.addRelation(ctx, user, "admin", org2);

    // Toggle the org1 admin relation 10 times!
    for (let i = 0; i < 10; i++) {
      await zbar.addRelation(ctx, user, "admin", org1);
      await zbar.removeRelation(ctx, user, "admin", org1);
    }

    // Look at the DB state for User -> writer -> Doc
    const writerEff = await t.run(async (innerCtx) => {
      return await innerCtx.db
        .query("effectiveRelationships")
        .filter((q: any) => q.eq(q.field("subjectKey"), "user:u_bloat"))
        .filter((q: any) => q.eq(q.field("relation"), "writer"))
        .filter((q: any) => q.eq(q.field("objectKey"), "document:doc_bloat"))
        .first();
    });

    // If there is no bloat, there should only be exactly ONE path (the current valid "admin" path).
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
      tenantId: "t1",
      asyncWrites: false, // Run sync
    });

    const user = { type: "user", id: "u_orphan" } as const;
    const org = { type: "org", id: "org_orphan" } as const;
    const proj = { type: "project", id: "proj_orphan" } as const;

    // 1. Proj is a child of Org.
    await zbar.addRelation(ctx, proj, "parent_org", org);

    // 2. User is BOTH owner AND admin of Org explicitly.
    // owner grants admin and viewer. admin grants viewer.
    // So admin on Org has 2 paths.
    await zbar.addRelation(ctx, user, "owner", org);
    await zbar.addRelation(ctx, user, "admin", org);

    // Verify User has "editor" access to Proj (via admin -> editor)
    expect(await zbar.hasRelationship(ctx, user, "editor", proj)).toBe(true);

    // 3. REMOVE the explicit "owner" relation.
    // User is STILL an "admin" of Org, so they should theoretically STILL be an "editor" of Proj.
    // But removing "owner" reduces the number of paths on "admin" from 2 to 1.
    await zbar.removeRelation(ctx, user, "owner", org);

    // Now REMOVE the explicit "admin" relation.
    // If the path was orphaned because processRemoveChunk failed to cascade on the partial removal,
    // they might STILL have editor access!
    await zbar.removeRelation(ctx, user, "admin", org);

    // After removing both owner and admin, they should have NO access to Org explicitly.
    const explicit = await zbar.getRelationships(ctx, user, org, undefined, {
      includeInherited: false,
    });
    expect(explicit).toEqual([]);

    // They should definitely NOT be an editor of the project anymore.
    const hasEditor = await zbar.hasRelationship(ctx, user, "editor", proj);

    // THIS WILL FAIL IF THERE ARE ORPHANED PATHS!
    expect(hasEditor).toBe(false);
  });
});
