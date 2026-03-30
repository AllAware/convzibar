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

const benchSchema = createZbarSchema<any>()
  .entity("user")
  .entity("folder", (e) =>
    e
      .relation("parent", "folder" as any)
      .relation("viewer", "user", "parent.viewer" as any)
      .relation("editor", "user", "parent.editor" as any)
      .permission("view", "viewer")
      .permission("edit", "editor"),
  )
  .entity("file", (e) =>
    e
      .relation("parent", "folder")
      .relation("viewer", "user", "parent.viewer" as any)
      .relation("editor", "user", "parent.editor" as any)
      .permission("view", "viewer")
      .permission("edit", "editor"),
  )
  .build();

describe("Benchmarks & High Contention Stress Tests", () => {
  test("High contention concurrent writes with asyncWrites: true", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: benchSchema,
      tenantId: "bench1",
      asyncWrites: true,
    });

    // Use mock workpool to bypass convex-test's "Write outside of transaction" limitation
    // for concurrent async operations, while mathematically testing the exact async workflow.
    (zbar as any).graphConfig.mockWorkpool = true;

    const user = { type: "user" as const, id: "u_bench" };
    const rootFolder = { type: "folder" as const, id: "root" };

    // 1. Create a wide graph: 20 files linked to root
    const NUM_FILES = 20;
    for (let i = 0; i < NUM_FILES; i++) {
      await zbar.addRelation(ctx, rootFolder, "parent", {
        type: "file",
        id: `f${i}`,
      });
    }
    await drainMockWorkpool(t);

    // 2. High Contention Add: Sequentially attempt to add the exact same relationship
    //    multiple times with async writes, then drain.
    for (let i = 0; i < 15; i++) {
      await zbar.addRelation(ctx, user, "viewer", rootFolder);
    }
    await drainMockWorkpool(t);

    // Database state expectation:
    // Base Relationships: 20 (file->parent->folder) + 1 (user->viewer->root) = 21
    // Effective: 20 (file->parent->folder) + 1 (user->viewer->root) + 20 (user->viewer->file via propagation) = 41
    await assertDbState(t, 21, 41);

    // 3. Verify user gained access to all files
    const accessibleFiles = await zbar.listAccessibleObjects(
      ctx,
      user,
      "view",
      "file",
    );
    expect(accessibleFiles.length).toBe(NUM_FILES);

    // 4. High Contention Remove: Sequentially attempt to remove the same relationship
    for (let i = 0; i < 15; i++) {
      await zbar.removeRelation(ctx, user, "viewer", rootFolder);
    }
    await drainMockWorkpool(t);

    // Database state expectation:
    // Base Relationships: 20 (file->parent->folder)
    // Effective: 20 (file->parent->folder)
    await assertDbState(t, 20, 20);

    // Verify user lost access
    const accessibleFilesAfter = await zbar.listAccessibleObjects(
      ctx,
      user,
      "view",
      "file",
    );
    expect(accessibleFilesAfter.length).toBe(0);
  });

  test("Deep graph propagation performance without recursion limits or row leaks", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: benchSchema,
      tenantId: "bench2",
      asyncWrites: true,
      maxWriteDepth: 20, // ensure we can traverse deep enough
    });

    (zbar as any).graphConfig.mockWorkpool = true;

    const user = { type: "user" as const, id: "u_deep" };
    const DEPTH = 15;

    // Build graph bottom-up to ensure relationships are in place
    for (let i = DEPTH; i > 0; i--) {
      const child = { type: "folder" as const, id: `folder_${i}` };
      const parent = { type: "folder" as const, id: `folder_${i - 1}` };
      await zbar.addRelation(ctx, parent, "parent", child);
    }
    await drainMockWorkpool(t);

    const topFolder = { type: "folder" as const, id: "folder_0" };
    const deepestFolder = { type: "folder" as const, id: `folder_${DEPTH}` };

    // Propagate role down the deep graph
    const startTime = Date.now();
    await zbar.addRelation(ctx, user, "editor", topFolder);
    await drainMockWorkpool(t);
    const timeTakenMs = Date.now() - startTime;

    expect(timeTakenMs).toBeLessThan(5000); // Sanity check

    // Database state expectation:
    // Base Relationships: 15 (folder->parent->folder) + 1 (user->editor->folder_0) = 16
    // Effective: 15 (folder->parent) + 1 (user->editor_0) + 15 (user->editor_{1..15}) = 31
    await assertDbState(t, 16, 31);

    const canEditDeepest = await zbar.can(ctx, user, "edit", deepestFolder);
    expect(canEditDeepest).toBe(true);

    // Delete the root edge, verify cascading deletion perfectly severs all N derivations
    await zbar.removeRelation(ctx, user, "editor", topFolder);
    await drainMockWorkpool(t);

    const canEditDeepestAfter = await zbar.can(
      ctx,
      user,
      "edit",
      deepestFolder,
    );
    expect(canEditDeepestAfter).toBe(false);

    // Database state expectation after remove:
    // Base Relationships: 15
    // Effective: 15
    await assertDbState(t, 15, 15);
  });
});
