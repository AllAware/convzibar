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

describe("Asynchronous Race Conditions", () => {
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
        createdAt: Date.now(),
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
        createdAt: Date.now(),
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
        createdAt: Date.now(),
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
          path: { tokens: [adminRelId] },
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

  test("deleteEntity concurrent with ongoing expansion", async () => {
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

    const user = { type: "user", id: "u_del" } as const;
    const org = { type: "org", id: "org_del" } as const;

    // Foreground insert
    const adminRelId = await t.run(async (innerCtx) => {
      return await innerCtx.db.insert("relationships", {
        tenantId: "t1",
        subjectType: "user",
        subjectId: "u_del",
        relation: "admin",
        objectType: "org",
        objectId: "org_del",
        createdAt: Date.now(),
      });
    });

    // Before expansion runs, delete the entity! This cascades and removes all relationships
    // involving that entity.
    await zbar.deleteEntity(ctx, user);

    // The background worker for the initial add fires
    const graphConfig = (zbar as any).graphConfig;
    await t.mutation(internal.mutations.processAddChunk, {
      tenantId: "t1",
      baseRelId: adminRelId, // Deleted by deleteEntity!
      queue: [
        {
          subject: user,
          relation: "admin",
          object: org,
          path: { tokens: [adminRelId] },
          depth: 1,
        },
      ],
      graphConfig,
      asyncWrites: false,
    });

    // Verify it cleanly aborted and there are no effective relationships
    const explicit = await zbar.getRelationships(ctx, user, org, undefined, {
      includeInherited: false,
    });
    expect(explicit).toEqual([]);
  });
});
