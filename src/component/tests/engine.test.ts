import { expect, test, describe } from "vitest";
import { convexTest } from "convex-test";
import schema from "../schema.js";
import { api } from "../_generated/api.js";
import type { GraphConfig } from "../types.js";
import { register as registerWorkpool } from "@convex-dev/workpool/test";

const setup = () => {
  const t = convexTest(schema, import.meta.glob("../**/*.ts"));
  registerWorkpool(t, "workpool");
  return t;
};

// Config arg shared by every direct mutation call. The component registers the
// compiled config the first time a hash is seen (idempotent), so passing both
// `configHash` and `graphConfig` on each call is safe.
const cfg = (graphConfig: GraphConfig) => ({
  configHash: "test-cfg",
  graphConfig,
});

// Inspect effective rows for (subject, relations, object) via the collapsed
// forward query.
const checkFast = (
  runner: any,
  a: { subject: any; relations: string[]; object: any },
) =>
  runner.query(api.queries.effectiveForward, {
    subjects: [a.subject],
    relations: a.relations,
    objectPoints: [`${a.object.type}:${a.object.id}`],
  });

describe("ReBAC Core Engine (v3)", () => {
  test("direct relationships are correctly inserted into relationships and effectiveRelationships", async () => {
    const t = setup();

    // Simplest possible graph with no traversals
    const graphConfig: GraphConfig = {
      traversalRules: [],
    };

    const user = { type: "user", id: "user1" };
    const org = { type: "org", id: "org1" };
    const relation = "owner";

    // 1. Add direct relation
    await t.mutation(api.mutations.addRelation, {
      subject: user,
      relation,
      object: org,
      ...cfg(graphConfig),
    });

    // 2. Query relationships to ensure it exists
    const rels = await checkFast(t, {
      subject: user,
      relations: [relation],
      object: org,
    });

    expect(rels.length).toBe(1);
    expect(rels[0].relation).toBe(relation);
    expect(rels[0].paths.length).toBe(1);
  });

  test("cross-object derived relationships are correctly expanded", async () => {
    const t = setup();

    // Project editor includes parent_org admin
    // sourceObject: Project, sourceRelation: parent_org, targetRelation: admin, derivedRelation: editor
    const graphConfig: GraphConfig = {
      traversalRules: [
        {
          sourceObjectType: "project",
          sourceRelation: "parent_org",
          targetRelation: "admin",
          derivedRelation: "editor",
        },
      ],
    };

    const user = { type: "user", id: "user1" };
    const org = { type: "org", id: "org1" };
    const project = { type: "project", id: "proj1" };

    // 1. Link Project to Org
    await t.mutation(api.mutations.addRelation, {
      subject: org,
      relation: "parent_org",
      object: project,
      ...cfg(graphConfig),
    });

    // 2. Add user as admin to Org
    await t.mutation(api.mutations.addRelation, {
      subject: user,
      relation: "admin",
      object: org,
      ...cfg(graphConfig),
    });

    // 3. Query effective relationships on Project
    const rels = await checkFast(t, {
      subject: user,
      relations: ["editor"],
      object: project,
    });

    expect(rels.length).toBe(1);
    expect(rels[0].relation).toBe("editor");
    expect(rels[0].paths.length).toBe(1);
  });

  test("removeRelation cleans up derived relationships", async () => {
    const t = setup();
    const graphConfig: GraphConfig = {
      traversalRules: [
        {
          sourceObjectType: "project",
          sourceRelation: "parent_org",
          targetRelation: "admin",
          derivedRelation: "editor",
        },
      ],
    };

    const user = { type: "user", id: "user1" };
    const org = { type: "org", id: "org1" };
    const project = { type: "project", id: "proj1" };

    // Setup initial state
    await t.mutation(api.mutations.addRelation, {
      subject: org,
      relation: "parent_org",
      object: project,
      ...cfg(graphConfig),
    });

    await t.mutation(api.mutations.addRelation, {
      subject: user,
      relation: "admin",
      object: org,
      ...cfg(graphConfig),
    });

    // Verify it exists
    const relsBefore = await checkFast(t, {
      subject: user,
      relations: ["editor"],
      object: project,
    });
    expect(relsBefore.length).toBe(1);

    // Remove relation
    await t.mutation(api.mutations.removeRelation, {
      subject: user,
      relation: "admin",
      object: org,
      ...cfg(graphConfig),
    });

    // Verify it is gone
    const relsAfter = await checkFast(t, {
      subject: user,
      relations: ["editor"],
      object: project,
    });
    expect(relsAfter.length).toBe(0);
  });

  test("multiple paths to a document are tracked and surgically deleted", async () => {
    const t = setup();
    const graphConfig: GraphConfig = {
      traversalRules: [
        {
          sourceObjectType: "document",
          sourceRelation: "parent_project",
          targetRelation: "editor",
          derivedRelation: "viewer",
        },
      ],
    };

    const user = { type: "user", id: "u1" };
    const doc1 = { type: "document", id: "d1" };
    const doc2 = { type: "document", id: "d2" };

    const proj1 = { type: "project", id: "p1" };
    const proj2 = { type: "project", id: "p2" };
    const proj3 = { type: "project", id: "p3" };

    // Link doc1 to all 3 projects
    await t.mutation(api.mutations.addRelation, {
      subject: proj1,
      relation: "parent_project",
      object: doc1,
      ...cfg(graphConfig),
    });
    await t.mutation(api.mutations.addRelation, {
      subject: proj2,
      relation: "parent_project",
      object: doc1,
      ...cfg(graphConfig),
    });
    await t.mutation(api.mutations.addRelation, {
      subject: proj3,
      relation: "parent_project",
      object: doc1,
      ...cfg(graphConfig),
    });

    // Link doc2 to proj1 and proj2
    await t.mutation(api.mutations.addRelation, {
      subject: proj1,
      relation: "parent_project",
      object: doc2,
      ...cfg(graphConfig),
    });
    await t.mutation(api.mutations.addRelation, {
      subject: proj2,
      relation: "parent_project",
      object: doc2,
      ...cfg(graphConfig),
    });

    // Add user as editor to all 3 projects
    await t.mutation(api.mutations.addRelation, {
      subject: user,
      relation: "editor",
      object: proj1,
      ...cfg(graphConfig),
    });
    await t.mutation(api.mutations.addRelation, {
      subject: user,
      relation: "editor",
      object: proj2,
      ...cfg(graphConfig),
    });
    await t.mutation(api.mutations.addRelation, {
      subject: user,
      relation: "editor",
      object: proj3,
      ...cfg(graphConfig),
    });

    // Check paths for doc1
    let relsDoc1 = await checkFast(t, {
      subject: user,
      relations: ["viewer"],
      object: doc1,
    });
    expect(relsDoc1.length).toBe(1); // 1 effective relationship
    expect(relsDoc1[0].paths.length).toBe(3); // 3 paths (one per project)

    // Check paths for doc2
    let relsDoc2 = await checkFast(t, {
      subject: user,
      relations: ["viewer"],
      object: doc2,
    });
    expect(relsDoc2[0].paths.length).toBe(2);

    // 1. Delete user editor of proj2
    await t.mutation(api.mutations.removeRelation, {
      subject: user,
      relation: "editor",
      object: proj2,
      ...cfg(graphConfig),
    });

    relsDoc1 = await checkFast(t, {
      subject: user,
      relations: ["viewer"],
      object: doc1,
    });
    expect(relsDoc1[0].paths.length).toBe(2);

    relsDoc2 = await checkFast(t, {
      subject: user,
      relations: ["viewer"],
      object: doc2,
    });
    expect(relsDoc2[0].paths.length).toBe(1);

    // 2. Delete doc1 parent_project proj3
    await t.mutation(api.mutations.removeRelation, {
      subject: proj3,
      relation: "parent_project",
      object: doc1,
      ...cfg(graphConfig),
    });

    relsDoc1 = await checkFast(t, {
      subject: user,
      relations: ["viewer"],
      object: doc1,
    });
    expect(relsDoc1[0].paths.length).toBe(1);

    // 3. Delete user editor of proj1
    await t.mutation(api.mutations.removeRelation, {
      subject: user,
      relation: "editor",
      object: proj1,
      ...cfg(graphConfig),
    });

    relsDoc1 = await checkFast(t, {
      subject: user,
      relations: ["viewer"],
      object: doc1,
    });
    expect(relsDoc1.length).toBe(0); // The effective relationship should be completely deleted

    relsDoc2 = await checkFast(t, {
      subject: user,
      relations: ["viewer"],
      object: doc2,
    });
    expect(relsDoc2.length).toBe(0);
  });

  test("deep connections (3+ hops) are correctly expanded and cleaned up", async () => {
    const t = setup();
    const graphConfig: GraphConfig = {
      traversalRules: [
        {
          sourceObjectType: "document",
          sourceRelation: "parent_folder",
          targetRelation: "admin",
          derivedRelation: "admin",
        },
        {
          sourceObjectType: "folder",
          sourceRelation: "parent_project",
          targetRelation: "admin",
          derivedRelation: "admin",
        },
        {
          sourceObjectType: "project",
          sourceRelation: "parent_org",
          targetRelation: "admin",
          derivedRelation: "admin",
        },
      ],
    };

    const user = { type: "user", id: "u_deep" };
    const org = { type: "org", id: "org1" };
    const project = { type: "project", id: "proj1" };
    const folder = { type: "folder", id: "folder1" };
    const document = { type: "document", id: "doc1" };

    // 1. Build the chain from bottom up
    await t.mutation(api.mutations.addRelation, {
      subject: folder,
      relation: "parent_folder",
      object: document,
      ...cfg(graphConfig),
    });
    await t.mutation(api.mutations.addRelation, {
      subject: project,
      relation: "parent_project",
      object: folder,
      ...cfg(graphConfig),
    });
    await t.mutation(api.mutations.addRelation, {
      subject: org,
      relation: "parent_org",
      object: project,
      ...cfg(graphConfig),
    });

    // 2. Add the user at the very top (org admin)
    await t.mutation(api.mutations.addRelation, {
      subject: user,
      relation: "admin",
      object: org,
      ...cfg(graphConfig),
    });

    // 3. Verify user has admin on the document (3 hops away)
    let relsDoc = await checkFast(t, {
      subject: user,
      relations: ["admin"],
      object: document,
    });
    expect(relsDoc.length).toBe(1);
    expect(relsDoc[0].paths[0].baseIds.length).toBeGreaterThan(3); // Should have accumulated several tokens

    // Verify user has admin on the folder (2 hops away)
    let relsFolder = await checkFast(t, {
      subject: user,
      relations: ["admin"],
      object: folder,
    });
    expect(relsFolder.length).toBe(1);

    // Verify user has admin on the project (1 hop away)
    let relsProject = await checkFast(t, {
      subject: user,
      relations: ["admin"],
      object: project,
    });
    expect(relsProject.length).toBe(1);

    // 4. Break the chain in the middle (remove folder from project)
    await t.mutation(api.mutations.removeRelation, {
      subject: project,
      relation: "parent_project",
      object: folder,
      ...cfg(graphConfig),
    });

    // Document admin should be gone
    relsDoc = await checkFast(t, {
      subject: user,
      relations: ["admin"],
      object: document,
    });
    expect(relsDoc.length).toBe(0);

    // Folder admin should be gone
    relsFolder = await checkFast(t, {
      subject: user,
      relations: ["admin"],
      object: folder,
    });
    expect(relsFolder.length).toBe(0);

    // Project admin should STILL exist!
    relsProject = await checkFast(t, {
      subject: user,
      relations: ["admin"],
      object: project,
    });
    expect(relsProject.length).toBe(1);

    // 5. Re-link folder to project to restore the chain
    await t.mutation(api.mutations.addRelation, {
      subject: project,
      relation: "parent_project",
      object: folder,
      ...cfg(graphConfig),
    });

    relsDoc = await checkFast(t, {
      subject: user,
      relations: ["admin"],
      object: document,
    });
    expect(relsDoc.length).toBe(1); // Restored!

    // 6. Delete user from org
    await t.mutation(api.mutations.removeRelation, {
      subject: user,
      relation: "admin",
      object: org,
      ...cfg(graphConfig),
    });

    // Entire chain of derived access should collapse
    relsDoc = await checkFast(t, {
      subject: user,
      relations: ["admin"],
      object: document,
    });
    expect(relsDoc.length).toBe(0);

    relsProject = await checkFast(t, {
      subject: user,
      relations: ["admin"],
      object: project,
    });
    expect(relsProject.length).toBe(0);
  });

  test("cycle detection prevents infinite loops", async () => {
    const t = setup();

    const graphConfig: GraphConfig = {
      traversalRules: [
        {
          sourceObjectType: "node",
          sourceRelation: "link",
          targetRelation: "link",
          derivedRelation: "link",
        },
      ],
    };

    const n1 = { type: "node", id: "1" };
    const n2 = { type: "node", id: "2" };

    // If cycle detection doesn't work, deriving link -> link -> link will infinite loop
    await t.mutation(api.mutations.addRelation, {
      subject: n1,
      relation: "link",
      object: n2,
      ...cfg(graphConfig),
    });
    await t.mutation(api.mutations.addRelation, {
      subject: n2,
      relation: "link",
      object: n2,
      ...cfg(graphConfig),
    });
    await t.mutation(api.mutations.addRelation, {
      subject: n2,
      relation: "link",
      object: n1,
      ...cfg(graphConfig),
    });

    const rels = await checkFast(t, {
      subject: n1,
      relations: ["link"],
      object: n1,
    });

    expect(rels).toBeDefined();
  });

  test("maxWriteDepth halts deep derivations", async () => {
    const t = setup();

    const graphConfig: GraphConfig = {
      traversalRules: [
        {
          sourceObjectType: "node",
          sourceRelation: "next",
          targetRelation: "reachable",
          derivedRelation: "reachable",
        },
      ],
      maxWriteDepth: 2, // Severely limit depth
    };

    const n1 = { type: "node", id: "1" };
    const n2 = { type: "node", id: "2" };
    const n3 = { type: "node", id: "3" };
    const n4 = { type: "node", id: "4" };

    // Link them together with next
    await t.mutation(api.mutations.addRelation, {
      subject: n1,
      relation: "next",
      object: n2,
      ...cfg(graphConfig),
    });
    await t.mutation(api.mutations.addRelation, {
      subject: n2,
      relation: "next",
      object: n3,
      ...cfg(graphConfig),
    });
    await t.mutation(api.mutations.addRelation, {
      subject: n3,
      relation: "next",
      object: n4,
      ...cfg(graphConfig),
    });

    // Now trigger the cascade with a single write!
    await t.mutation(api.mutations.addRelation, {
      subject: n1,
      relation: "reachable",
      object: n2,
      ...cfg(graphConfig),
    });

    // Because maxWriteDepth is 2, the derivation should stop before n1 reaches n4
    const rels = await checkFast(t, {
      subject: n1,
      relations: ["reachable"],
      object: n4,
    });

    expect(rels.length).toBe(0); // Should not reach n4
  });

  test("asyncWrites correctly processes BFS via workpool", async () => {
    const t = setup();
    const graphConfig: GraphConfig = {
      traversalRules: [
        {
          sourceObjectType: "project",
          sourceRelation: "parent_org",
          targetRelation: "admin",
          derivedRelation: "editor",
        },
      ],
    };

    const user = { type: "user", id: "u_async" };
    const org = { type: "org", id: "org_async" };
    const project = { type: "project", id: "proj_async" };

    // Add relation with asyncWrites: true
    await t.mutation(api.mutations.addRelation, {
      subject: org,
      relation: "parent_org",
      object: project,
      ...cfg(graphConfig),
      asyncWrites: true,
    });

    await t.mutation(api.mutations.addRelation, {
      subject: user,
      relation: "admin",
      object: org,
      ...cfg(graphConfig),
      asyncWrites: true,
    });

    // Run workpool scheduled jobs
    for (let i = 0; i < 10; i++) {
      await t.finishInProgressScheduledFunctions();
      // Sleep a tiny bit to allow event loop
      await new Promise((r) => setTimeout(r, 50));
    }

    const rels = await checkFast(t, {
      subject: user,
      relations: ["editor"],
      object: project,
    });

    expect(rels.length).toBe(1);
    expect(rels[0].relation).toBe("editor");

    // Remove relation with asyncWrites: true
    await t.mutation(api.mutations.removeRelation, {
      subject: user,
      relation: "admin",
      object: org,
      ...cfg(graphConfig),
      asyncWrites: true,
    });

    for (let i = 0; i < 10; i++) {
      await t.finishInProgressScheduledFunctions();
      await new Promise((r) => setTimeout(r, 50));
    }

    const relsAfter = await checkFast(t, {
      subject: user,
      relations: ["editor"],
      object: project,
    });

    expect(relsAfter.length).toBe(0);
  });
});
