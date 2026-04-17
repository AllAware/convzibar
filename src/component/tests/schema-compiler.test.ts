import { expect, test, describe } from "vitest";
import { Zbar, createZbarSchema } from "../../client/index.js";
import { convexTest } from "convex-test";
import schema from "../schema.js";
import { api } from "../_generated/api.js";
import { parseSchemaToGraphConfig } from "../helpers";
import { register as registerWorkpool } from "@convex-dev/workpool/test";

// ============================================================================
// Unit Tests: parseSchemaToGraphConfig deduplication logic
// ============================================================================

describe("Schema Compiler Deduplication (Unit)", () => {
  test("Basic deduplication: Distant inheritance pruned by local implication", () => {
    const schema = {
      entities: {
        system: {
          relations: {
            admin: ["viewer"],
            viewer: [],
          },
        },
        device: {
          relations: {
            system: [{ type: "system" }],
            manager: ["system.admin"],
            viewer: ["manager", "system.viewer"],
          },
        },
      },
    };

    const config = parseSchemaToGraphConfig(schema);

    const adminTriggerRules = config.traversalRules.filter(
      (r) =>
        r.sourceObjectType === "device" &&
        r.sourceRelation === "system" &&
        r.targetRelation === "admin",
    );

    expect(adminTriggerRules).toHaveLength(1);
    expect(adminTriggerRules[0].derivedRelation).toBe("manager");
  });

  test("Condition compatibility: Strict rules do not dominate loose rules", () => {
    const schema = {
      entities: {
        system: {
          relations: {
            admin: [],
          },
        },
        device: {
          relations: {
            system: [{ type: "system" }],
            manager: [{ relation: "system.admin", condition: "isActive" }],
            viewer: ["manager", "system.admin"],
          },
        },
      },
    };

    const config = parseSchemaToGraphConfig(schema);

    const adminTriggerRules = config.traversalRules.filter(
      (r) =>
        r.sourceObjectType === "device" &&
        r.sourceRelation === "system" &&
        r.targetRelation === "admin",
    );

    expect(adminTriggerRules).toHaveLength(2);

    const managerRule = adminTriggerRules.find(
      (r) => r.derivedRelation === "manager",
    );
    const viewerRule = adminTriggerRules.find(
      (r) => r.derivedRelation === "viewer",
    );

    expect(managerRule).toBeDefined();
    expect(managerRule?.conditions).toEqual(["isActive"]);

    expect(viewerRule).toBeDefined();
    expect(viewerRule?.conditions).toBeUndefined();
  });

  test("Condition compatibility: Loose rules CAN dominate strict rules", () => {
    const schema = {
      entities: {
        system: {
          relations: {
            admin: [],
          },
        },
        device: {
          relations: {
            system: [{ type: "system" }],
            manager: ["system.admin"],
            viewer: [
              "manager",
              { relation: "system.admin", condition: "isGuest" },
            ],
          },
        },
      },
    };

    const config = parseSchemaToGraphConfig(schema);

    const adminTriggerRules = config.traversalRules.filter(
      (r) =>
        r.sourceObjectType === "device" &&
        r.sourceRelation === "system" &&
        r.targetRelation === "admin",
    );

    expect(adminTriggerRules).toHaveLength(1);
    expect(adminTriggerRules[0].derivedRelation).toBe("manager");
    expect(adminTriggerRules[0].conditions).toBeUndefined();
  });

  test("Condition compatibility: Equal conditions can dominate", () => {
    const schema = {
      entities: {
        system: {
          relations: {
            admin: [],
          },
        },
        device: {
          relations: {
            system: [{ type: "system" }],
            manager: [{ relation: "system.admin", condition: "isActive" }],
            viewer: [
              "manager",
              { relation: "system.admin", condition: "isActive" },
            ],
          },
        },
      },
    };

    const config = parseSchemaToGraphConfig(schema);

    const adminTriggerRules = config.traversalRules.filter(
      (r) =>
        r.sourceObjectType === "device" &&
        r.sourceRelation === "system" &&
        r.targetRelation === "admin",
    );

    expect(adminTriggerRules).toHaveLength(1);
    expect(adminTriggerRules[0].derivedRelation).toBe("manager");
    expect(adminTriggerRules[0].conditions).toEqual(["isActive"]);
  });

  test("Non-domination: Independent relations are not pruned", () => {
    const schema = {
      entities: {
        system: {
          relations: {
            admin: [],
          },
        },
        device: {
          relations: {
            system: [{ type: "system" }],
            manager: ["system.admin"],
            auditor: ["system.admin"],
          },
        },
      },
    };

    const config = parseSchemaToGraphConfig(schema);

    const adminTriggerRules = config.traversalRules.filter(
      (r) =>
        r.sourceObjectType === "device" &&
        r.sourceRelation === "system" &&
        r.targetRelation === "admin",
    );

    expect(adminTriggerRules).toHaveLength(2);
    expect(adminTriggerRules.some((r) => r.derivedRelation === "manager")).toBe(
      true,
    );
    expect(adminTriggerRules.some((r) => r.derivedRelation === "auditor")).toBe(
      true,
    );
  });
});

// ============================================================================
// Integration Tests: Deduplication through Zbar client
// ============================================================================

const setup = () => {
  const t = convexTest(schema, import.meta.glob("../**/*.ts"));
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

describe("Schema Compiler Deduplication (Integration)", () => {
  test("granting admin triggers correct graph expansion with deduplication (minimal row)", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: dedupSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const user = { type: "user" as const, id: "u1" };
    const org = { type: "org" as const, id: "org1" };
    const project = { type: "project" as const, id: "proj1" };

    await zbar.addRelation(ctx, org, "parent_org", project);
    await zbar.addRelation(ctx, user, "admin", org);

    // All permissions should work via the deduplicated admin rule
    expect(await zbar.can(ctx, user, "delete_project", project)).toBe(true);
    expect(await zbar.can(ctx, user, "edit_project", project)).toBe(true);
    expect(await zbar.can(ctx, user, "view_project", project)).toBe(true);

    // Only the dominant 'admin' row was propagated
    const allRels = await ctx.runQuery(api.queries.checkPermissionFast, {
      tenantId: "t1",
      subject: user,
      object: project,
      relations: ["admin", "manager", "viewer"],
    });

    expect(allRels).toHaveLength(1);
    expect(allRels[0].relation).toBe("admin");

    // No direct relationship between user and project
    const directRels = await zbar.listDirect()
      .object(project)
      .subject(user)
      .collect(ctx);
    expect(directRels).toEqual([]);

    // 2 bases + 1 distant materialization (admin) = 3
    await assertDbState(t, 2, 3);
  });
});

describe("Read-time cycle detection", () => {
  test("accepts an acyclic RT chain", () => {
    const schema = {
      entities: {
        user: { relations: {} },
        system: {
          relations: { member: [{ type: "user" }] },
        },
        org: {
          relations: { owner: [{ type: "system" }] },
          readTimeRelations: [{ derivedRelation: "viewer", dotPath: "owner.member" }],
        },
      },
    } as any;
    expect(() => parseSchemaToGraphConfig(schema)).not.toThrow();
  });

  test("rejects a direct self-cycle (A#x → A#x)", () => {
    const schema = {
      entities: {
        a: {
          relations: { self: [{ type: "a" }] },
          readTimeRelations: [{ derivedRelation: "viewer", dotPath: "self.viewer" }],
        },
      },
    } as any;
    expect(() => parseSchemaToGraphConfig(schema)).toThrow(
      /cycle/i,
    );
  });

  test("rejects a two-entity cycle (A → B → A)", () => {
    const schema = {
      entities: {
        a: {
          relations: { to_b: [{ type: "b" }] },
          readTimeRelations: [{ derivedRelation: "x", dotPath: "to_b.y" }],
        },
        b: {
          relations: { to_a: [{ type: "a" }] },
          readTimeRelations: [{ derivedRelation: "y", dotPath: "to_a.x" }],
        },
      },
    } as any;
    expect(() => parseSchemaToGraphConfig(schema)).toThrow(
      /cycle/i,
    );
  });
});

// ============================================================================
// Userset read-time paths.
//
// `.readTimeRelation('viewer', 'group#viewer')` on `device` means: at read
// time, any `group` written to `device.viewer` is expanded via the group's
// `viewer` relation. It produces the same Compose shape as a dot-path RT
// but sourced from the derived relation itself rather than a structural
// navigation relation.
// ============================================================================

describe("Userset read-time relations", () => {
  test("compiles to the expected ReadTimePath", () => {
    const schema = {
      entities: {
        user: { relations: {} },
        group: { relations: { viewer: [{ type: "user" }] } },
        device: {
          relations: { viewer: ["user", { type: "group" }] },
          readTimeRelations: [
            { derivedRelation: "viewer", dotPath: "group#viewer" },
          ],
        },
      },
    } as any;

    const config = parseSchemaToGraphConfig(schema);
    expect(config.readTimePaths).toEqual([
      {
        objectType: "device",
        derivedRelation: "viewer",
        sourceRelation: "viewer",
        targetRelation: "viewer",
        sourceTypes: ["group"],
      },
    ]);
  });

  test("produces no traversal rules — the whole point is to skip materialisation", () => {
    const schema = {
      entities: {
        user: { relations: {} },
        group: { relations: { viewer: [{ type: "user" }] } },
        device: {
          relations: { viewer: [{ type: "group" }] },
          readTimeRelations: [
            { derivedRelation: "viewer", dotPath: "group#viewer" },
          ],
        },
      },
    } as any;

    const config = parseSchemaToGraphConfig(schema);
    // No userset rewrite → BFS generates no traversal rules for this
    // declaration. Base-edge writes remain, but the fan-out is avoided.
    expect(config.traversalRules).toEqual([]);
  });

  test("throws when the derived relation does not declare the userset type as a target", () => {
    const schema = {
      entities: {
        user: { relations: {} },
        group: { relations: { viewer: [{ type: "user" }] } },
        device: {
          // viewer only accepts 'user' — adding a group to viewer is
          // impossible, so the 'group#viewer' RT declaration is dead weight.
          relations: { viewer: ["user"] },
          readTimeRelations: [
            { derivedRelation: "viewer", dotPath: "group#viewer" },
          ],
        },
      },
    } as any;

    expect(() => parseSchemaToGraphConfig(schema)).toThrow(
      /declare 'group' as a typed target/i,
    );
  });

  test("cycle detection follows userset edges (A#x → B#y → A#x)", () => {
    const schema = {
      entities: {
        a: {
          relations: { x: [{ type: "b" }] },
          readTimeRelations: [{ derivedRelation: "x", dotPath: "b#y" }],
        },
        b: {
          relations: { y: [{ type: "a" }] },
          readTimeRelations: [{ derivedRelation: "y", dotPath: "a#x" }],
        },
      },
    } as any;
    expect(() => parseSchemaToGraphConfig(schema)).toThrow(/cycle/i);
  });
});
