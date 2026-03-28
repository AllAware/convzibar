import { expect, test, describe } from "vitest";
import { parseSchemaToGraphConfig } from "../helpers";

describe("Schema Compiler Deduplication", () => {
  test("Basic deduplication: Distant inheritance pruned by local implication", () => {
    // Scenario:
    // User is an 'admin' on a system.
    // 'device' has a 'manager' role that distant-inherits from 'system.admin'.
    // 'device' has a 'viewer' role that distant-inherits from 'system.viewer'.
    // 'system.admin' locally inherits 'system.viewer'.
    // 'device.manager' locally inherits 'device.viewer'.
    // EXPECTATION: When a user becomes 'system.admin', they qualify for 'device.manager' and 'device.viewer'.
    // Because 'device.manager' implies 'device.viewer', only 'manager' should be emitted as a rule.

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

    // Let's find rules triggered by system.admin -> device.manager/viewer
    const adminTriggerRules = config.traversalRules.filter(
      (r) =>
        r.sourceObjectType === "device" &&
        r.sourceRelation === "system" &&
        r.targetRelation === "admin",
    );

    // Without deduplication, there would be TWO rules here: one for manager, one for viewer
    // (Because device.viewer inherits system.viewer, which includes system.admin)
    // WITH deduplication, there should be exactly ONE rule: derivedRelation = "manager".

    expect(adminTriggerRules).toHaveLength(1);
    expect(adminTriggerRules[0].derivedRelation).toBe("manager");
  });

  test("Condition compatibility: Strict rules do not dominate loose rules", () => {
    // Scenario:
    // 'device.manager' implies 'device.viewer'.
    // 'device.manager' requires a condition (e.g. 'isActive').
    // 'device.viewer' does NOT require a condition.
    // Both distant-inherit from 'system.admin'.
    // EXPECTATION: Because 'manager' has strict conditions, it MIGHT FAIL at read-time.
    // Therefore, it CANNOT safely dominate 'viewer', which has no conditions and would always pass.
    // Both rules must be emitted.

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

    // Both manager and viewer rules must exist because manager has a strict condition and viewer does not.
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
    // Scenario:
    // 'device.manager' implies 'device.viewer'.
    // 'device.manager' has NO condition.
    // 'device.viewer' HAS a condition.
    // Both distant-inherit from 'system.admin'.
    // EXPECTATION: 'manager' always grants 'viewer', unconditionally.
    // Therefore, 'manager' safely dominates 'viewer' (which is stricter).
    // Only 'manager' should be emitted.

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
    // Scenario:
    // 'device.manager' implies 'device.viewer'.
    // Both require the exact SAME condition ('isActive').
    // Both distant-inherit from 'system.admin'.
    // EXPECTATION: 'manager' safely dominates 'viewer' since conditions are equal.

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
    // Scenario:
    // 'device.manager' and 'device.auditor' both distant-inherit from 'system.admin'.
    // They do NOT imply each other locally.
    // EXPECTATION: Both rules must be emitted.

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
