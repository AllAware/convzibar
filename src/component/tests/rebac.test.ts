import { expect, test, describe } from "vitest";
import { convexTest } from "convex-test";
import schema from "../schema.js";
import { api } from "../_generated/api.js";
import type { GraphConfig } from "../types.js";

const setup = () => convexTest(schema, import.meta.glob("../**/*.ts"));

describe("ReBAC Core Engine (v3)", () => {
  test("direct relationships are correctly inserted into relationships and effectiveRelationships", async () => {
    const t = setup();

    // Simplest possible graph with no traversals
    const graphConfig: GraphConfig = {
      traversalRules: [],
      reverseEdges: {},
    };

    const user = { type: "user", id: "user1" };
    const org = { type: "org", id: "org1" };
    const relation = "owner";

    // 1. Add direct relation
    await t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: user,
      relation,
      object: org,
      graphConfig,
    });

    // 2. Query relationships to ensure it exists
    const rels = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: [relation],
      object: org,
    });

    expect(rels.length).toBe(1);
    expect(rels[0].relation).toBe(relation);
    expect(rels[0].paths.length).toBe(1);
    expect(rels[0].paths[0].isDirect).toBe(true);
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
      reverseEdges: {},
    };

    const user = { type: "user", id: "user1" };
    const org = { type: "org", id: "org1" };
    const project = { type: "project", id: "proj1" };

    // 1. Link Project to Org
    await t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: project,
      relation: "parent_org",
      object: org,
      graphConfig,
    });

    // 2. Add user as admin to Org
    await t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: user,
      relation: "admin",
      object: org,
      graphConfig,
    });

    // 3. Query effective relationships on Project
    const rels = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["editor"],
      object: project,
    });

    expect(rels.length).toBe(1);
    expect(rels[0].relation).toBe("editor");
    expect(rels[0].paths.length).toBe(1);
    expect(rels[0].paths[0].isDirect).toBe(false);
  });

  test("relationship conditions are successfully passed to paths", async () => {
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
      reverseEdges: {},
    };

    const user = { type: "user", id: "user1" };
    const org = { type: "org", id: "org1" };
    const project = { type: "project", id: "proj1" };

    // Link Project to Org
    await t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: project,
      relation: "parent_org",
      object: org,
      graphConfig,
    });

    // Add user as admin to Org WITH CONDITION
    await t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: user,
      relation: "admin",
      object: org,
      condition: {
        condition: "isBusinessHours",
        conditionContext: { timezone: "EST" },
      },
      graphConfig,
    });

    const rels = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["editor"],
      object: project,
    });

    expect(rels.length).toBe(1);
    expect(rels[0].paths[0].conditions).toBeDefined();
    expect(rels[0].paths[0].conditions?.length).toBe(1);
    expect(rels[0].paths[0].conditions?.[0].condition).toBe("isBusinessHours");
    expect(rels[0].paths[0].conditions?.[0].conditionContext.timezone).toBe(
      "EST",
    );
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
      reverseEdges: {},
    };

    const user = { type: "user", id: "user1" };
    const org = { type: "org", id: "org1" };
    const project = { type: "project", id: "proj1" };

    // Setup initial state
    await t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: project,
      relation: "parent_org",
      object: org,
      graphConfig,
    });

    await t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: user,
      relation: "admin",
      object: org,
      graphConfig,
    });

    // Verify it exists
    const relsBefore = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["editor"],
      object: project,
    });
    expect(relsBefore.length).toBe(1);

    // Remove relation
    await t.mutation(api.mutations.removeRelation, {
      tenantId: "t1",
      subject: user,
      relation: "admin",
      object: org,
      graphConfig,
    });

    // Verify it is gone
    const relsAfter = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["editor"],
      object: project,
    });
    expect(relsAfter.length).toBe(0);
  });

  test("multiple paths to a document with conditions and deletions", async () => {
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
      reverseEdges: {},
    };

    const user = { type: "user", id: "u1" };
    const doc1 = { type: "document", id: "d1" };
    const doc2 = { type: "document", id: "d2" };

    const proj1 = { type: "project", id: "p1" };
    const proj2 = { type: "project", id: "p2" };
    const proj3 = { type: "project", id: "p3" };

    // Link doc1 to all 3 projects
    await t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: doc1,
      relation: "parent_project",
      object: proj1,
      graphConfig,
    });
    await t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: doc1,
      relation: "parent_project",
      object: proj2,
      graphConfig,
    });
    await t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: doc1,
      relation: "parent_project",
      object: proj3,
      graphConfig,
    });

    // Link doc2 to proj1 and proj2
    await t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: doc2,
      relation: "parent_project",
      object: proj1,
      graphConfig,
    });
    await t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: doc2,
      relation: "parent_project",
      object: proj2,
      graphConfig,
    });

    // Add user as editor to all 3 projects with different conditions
    await t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: user,
      relation: "editor",
      object: proj1,
      condition: { condition: "cond1" },
      graphConfig,
    });
    await t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: user,
      relation: "editor",
      object: proj2,
      condition: { condition: "cond2" },
      graphConfig,
    });
    await t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: user,
      relation: "editor",
      object: proj3,
      condition: { condition: "cond3" },
      graphConfig,
    });

    // Check paths for doc1
    let relsDoc1 = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["viewer"],
      object: doc1,
    });
    expect(relsDoc1.length).toBe(1); // 1 effective relationship
    expect(relsDoc1[0].paths.length).toBe(3); // 3 paths

    // Extract conditions from paths
    const pathConditions = relsDoc1[0].paths
      .map((p: any) => p.conditions?.[0]?.condition)
      .sort();
    expect(pathConditions).toEqual(["cond1", "cond2", "cond3"]);

    // Check paths for doc2
    let relsDoc2 = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["viewer"],
      object: doc2,
    });
    expect(relsDoc2[0].paths.length).toBe(2);
    expect(
      relsDoc2[0].paths.map((p: any) => p.conditions?.[0]?.condition).sort(),
    ).toEqual(["cond1", "cond2"]);

    // 1. Delete user editor of proj2
    await t.mutation(api.mutations.removeRelation, {
      tenantId: "t1",
      subject: user,
      relation: "editor",
      object: proj2,
      graphConfig,
    });

    relsDoc1 = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["viewer"],
      object: doc1,
    });
    expect(relsDoc1[0].paths.length).toBe(2);
    expect(
      relsDoc1[0].paths.map((p: any) => p.conditions?.[0]?.condition).sort(),
    ).toEqual(["cond1", "cond3"]);

    relsDoc2 = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["viewer"],
      object: doc2,
    });
    expect(relsDoc2[0].paths.length).toBe(1);
    expect(relsDoc2[0].paths[0].conditions?.[0]?.condition).toBe("cond1");

    // 2. Delete doc1 parent_project proj3
    await t.mutation(api.mutations.removeRelation, {
      tenantId: "t1",
      subject: doc1,
      relation: "parent_project",
      object: proj3,
      graphConfig,
    });

    relsDoc1 = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["viewer"],
      object: doc1,
    });
    expect(relsDoc1[0].paths.length).toBe(1);
    expect(relsDoc1[0].paths[0].conditions?.[0]?.condition).toBe("cond1");

    // 3. Delete user editor of proj1
    await t.mutation(api.mutations.removeRelation, {
      tenantId: "t1",
      subject: user,
      relation: "editor",
      object: proj1,
      graphConfig,
    });

    relsDoc1 = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["viewer"],
      object: doc1,
    });
    expect(relsDoc1.length).toBe(0); // The effective relationship should be completely deleted

    relsDoc2 = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
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
      reverseEdges: {},
    };

    const user = { type: "user", id: "u_deep" };
    const org = { type: "org", id: "org1" };
    const project = { type: "project", id: "proj1" };
    const folder = { type: "folder", id: "folder1" };
    const document = { type: "document", id: "doc1" };

    // 1. Build the chain from bottom up
    await t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: document,
      relation: "parent_folder",
      object: folder,
      graphConfig,
    });
    await t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: folder,
      relation: "parent_project",
      object: project,
      graphConfig,
    });
    await t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: project,
      relation: "parent_org",
      object: org,
      graphConfig,
    });

    // 2. Add the user at the very top (org admin)
    await t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: user,
      relation: "admin",
      object: org,
      graphConfig,
    });

    // 3. Verify user has admin on the document (3 hops away)
    let relsDoc = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["admin"],
      object: document,
    });
    expect(relsDoc.length).toBe(1);
    expect(relsDoc[0].paths[0].isDirect).toBe(false);
    expect(relsDoc[0].paths[0].tokens.length).toBeGreaterThan(3); // Should have accumulated several tokens

    // Verify user has admin on the folder (2 hops away)
    let relsFolder = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["admin"],
      object: folder,
    });
    expect(relsFolder.length).toBe(1);

    // Verify user has admin on the project (1 hop away)
    let relsProject = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["admin"],
      object: project,
    });
    expect(relsProject.length).toBe(1);

    // 4. Break the chain in the middle (remove folder from project)
    await t.mutation(api.mutations.removeRelation, {
      tenantId: "t1",
      subject: folder,
      relation: "parent_project",
      object: project,
      graphConfig,
    });

    // Document admin should be gone
    relsDoc = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["admin"],
      object: document,
    });
    expect(relsDoc.length).toBe(0);

    // Folder admin should be gone
    relsFolder = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["admin"],
      object: folder,
    });
    expect(relsFolder.length).toBe(0);

    // Project admin should STILL exist!
    relsProject = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["admin"],
      object: project,
    });
    expect(relsProject.length).toBe(1);

    // 5. Re-link folder to project to restore the chain
    await t.mutation(api.mutations.addRelation, {
      tenantId: "t1",
      subject: folder,
      relation: "parent_project",
      object: project,
      graphConfig,
    });

    relsDoc = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["admin"],
      object: document,
    });
    expect(relsDoc.length).toBe(1); // Restored!

    // 6. Delete user from org
    await t.mutation(api.mutations.removeRelation, {
      tenantId: "t1",
      subject: user,
      relation: "admin",
      object: org,
      graphConfig,
    });

    // Entire chain of derived access should collapse
    relsDoc = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["admin"],
      object: document,
    });
    expect(relsDoc.length).toBe(0);

    relsProject = await t.query(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      relations: ["admin"],
      object: project,
    });
    expect(relsProject.length).toBe(0);
  });
});
