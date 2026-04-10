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

const mkCtx = (t: any) =>
  ({
    runQuery: t.query.bind(t),
    runMutation: t.mutation.bind(t),
  }) as any;

// ============================================================================
// Schema: IoT notification system with reverse edges
// ============================================================================

const notificationSchema = createZbarSchema<any>()
  .entity("user")
  .entity("system", (e) =>
    e
      .relation("owner", "user")
      .relation("admin", "user", "owner")
      .relation("viewer", "user", "admin")
      // Placeholder — populated by group.owner's { reverse: 'has_group' }.
      .relation("has_group")
  )
  .entity("group", (e) =>
    e
      // reverse: system → parent → group auto-creates group → has_group → system.
      // 'has_group' is type-checked against system's declared relations.
      .relation("parent", { type: "system", reverse: "has_group" })
      // Placeholders for device/contact membership.
      .relation("device_member")
      .relation("contact_member")
      .relation("admin", "user", "parent.admin")
      .relation("viewer", "user", "admin", "parent.viewer")
  )
  // group is now defined — wire up forward references on system
  .extend("system", (e) =>
    e
      .relation("device_member", "has_group.device_member")
      .relation("contact_member", "has_group.contact_member")
  )
  .entity("device", (e) =>
    e
      // reverse: group → container → device auto-creates device → device_member → group.
      // 'device_member' is type-checked against group's declared relations.
      .relation("container", { type: "group", reverse: "device_member" })
      .relation("admin", "user", "system#admin", "container.admin")
      .relation("viewer", "user", "admin", "system#viewer", "container.viewer")
  )
  .entity("contact", (e) =>
    e
      // reverse: group → container → contact auto-creates contact → contact_member → group.
      // 'contact_member' is type-checked against group's declared relations.
      .relation("container", { type: "group", reverse: "contact_member" })
  )
  .entity("notification_rule", (e) =>
    e
      // group#device_member → when group is source, expand to all devices in that group
      // system#device_member → when system is source, expand to all devices in that system
      .relation("source", "device", "group#device_member", "system#device_member")
      .relation("recipient", "contact", "group#contact_member", "system#contact_member")
  )
  .build();

// ============================================================================
// Tests
// ============================================================================

describe("Reverse Edge: Schema auto-injection", () => {
  test("placeholder relations are declared on target entities", () => {
    const entities = notificationSchema.entities as any;

    // These exist as relation keys (declared as placeholders)
    expect("has_group" in entities.system.relations).toBe(true);
    expect("device_member" in entities.group.relations).toBe(true);
    expect("contact_member" in entities.group.relations).toBe(true);
  });

  test("explicit traversals on placeholders are preserved", () => {
    const entities = notificationSchema.entities as any;

    // system.device_member was declared with 'has_group.device_member' traversal.
    expect(entities.system.relations.device_member).toBe(
      "has_group.device_member",
    );

    expect(entities.system.relations.contact_member).toBe(
      "has_group.contact_member",
    );
  });
});

describe("Reverse Edge: Auto-insertion and removal", () => {
  test("adding container relation auto-inserts reverse device_member", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, {
      schema: notificationSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const group = { type: "group" as const, id: "grp1" };
    const device = { type: "device" as const, id: "dev1" };

    // Add device to group via container relation
    await zbar.addRelation(ctx, group, "container", device);

    // Verify: forward edge (group → container → device)
    const forward = await zbar.listDirect()
      .object(device)
      .subject(group)
      .collect(ctx);
    expect(forward.length).toBe(1);
    expect(forward[0].relation).toBe("container");

    // Verify: reverse edge (device → device_member → group) was auto-created
    const reverse = await zbar.listDirect()
      .object(group)
      .subject(device)
      .collect(ctx);
    expect(reverse.length).toBe(1);
    expect(reverse[0].relation).toBe("device_member");

    // 2 base relationships (forward + reverse), 2 effective
    await assertDbState(t, 2, 2);
  });

  test("removing container relation auto-removes reverse device_member", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, {
      schema: notificationSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const group = { type: "group" as const, id: "grp1" };
    const device = { type: "device" as const, id: "dev1" };

    await zbar.addRelation(ctx, group, "container", device);
    await assertDbState(t, 2, 2);

    // Remove the forward edge
    await zbar.removeRelation(ctx, group, "container", device);

    // Both forward and reverse should be gone
    await assertDbState(t, 0, 0);
  });
});

describe("Reverse Edge: Notification source expansion via userset", () => {
  test("device as direct source of notification_rule", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, {
      schema: notificationSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const device = { type: "device" as const, id: "dev1" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    // Device is directly a source
    await zbar.addRelation(ctx, device, "source", rule);

    // Query: what rules is this device a source of?
    const rules = await zbar.list()
      .object("notification_rule")
      .relation("source")
      .subject(device)
      .collect(ctx);

    expect(rules.length).toBe(1);
    expect(rules[0].objectId).toBe("rule1");
  });

  test("group as source expands to all member devices via userset", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, {
      schema: notificationSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const group = { type: "group" as const, id: "grp1" };
    const dev1 = { type: "device" as const, id: "dev1" };
    const dev2 = { type: "device" as const, id: "dev2" };
    const dev3 = { type: "device" as const, id: "dev3" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    // Add devices to group (reverse edges auto-created)
    await zbar.addRelation(ctx, group, "container", dev1);
    await zbar.addRelation(ctx, group, "container", dev2);
    await zbar.addRelation(ctx, group, "container", dev3);

    // Make the GROUP a source of the notification rule
    await zbar.addRelation(ctx, group, "source", rule);

    // Each device should be an effective source via group#device_member userset
    const dev1Rules = await zbar.list()
      .object("notification_rule")
      .relation("source")
      .subject(dev1)
      .collect(ctx);
    expect(dev1Rules.length).toBe(1);

    const dev2Rules = await zbar.list()
      .object("notification_rule")
      .relation("source")
      .subject(dev2)
      .collect(ctx);
    expect(dev2Rules.length).toBe(1);

    const dev3Rules = await zbar.list()
      .object("notification_rule")
      .relation("source")
      .subject(dev3)
      .collect(ctx);
    expect(dev3Rules.length).toBe(1);

    // Also verify: list all devices that are sources of rule1
    const allSources = await zbar.list()
      .object(rule)
      .relation("source")
      .subject("device")
      .collect(ctx);
    expect(allSources.map(s => s.subjectId).sort()).toEqual(["dev1", "dev2", "dev3"]);
  });

  test("system as source expands to all member devices via chained reverse + traversal", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, {
      schema: notificationSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const sys = { type: "system" as const, id: "sys1" };
    const group = { type: "group" as const, id: "grp1" };
    const dev1 = { type: "device" as const, id: "dev1" };
    const dev2 = { type: "device" as const, id: "dev2" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    // Chain: system → parent → group, group → container → device
    // Reverse edges auto-create: group → has_group → system, device → device_member → group
    // Traversal auto-propagates: device → device_member → system (via has_group.device_member)
    await zbar.addRelation(ctx, sys, "parent", group);
    await zbar.addRelation(ctx, group, "container", dev1);
    await zbar.addRelation(ctx, group, "container", dev2);

    // Verify devices are effective device_members of the system (2-hop propagation)
    const sysMembers = await zbar.list()
      .object(sys)
      .relation("device_member")
      .subject("device")
      .collect(ctx);
    expect(sysMembers.map(s => s.subjectId).sort()).toEqual(["dev1", "dev2"]);

    // Make the SYSTEM a source of the notification rule
    await zbar.addRelation(ctx, sys, "source", rule);

    // Each device should be an effective source via system#device_member userset
    const allSources = await zbar.list()
      .object(rule)
      .relation("source")
      .subject("device")
      .collect(ctx);
    expect(allSources.map(s => s.subjectId).sort()).toEqual(["dev1", "dev2"]);
  });

  test("mixed: direct device + group source + system source (chained)", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, {
      schema: notificationSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const sys = { type: "system" as const, id: "sys1" };
    const grpA = { type: "group" as const, id: "grpA" };
    const grpB = { type: "group" as const, id: "grpB" };
    const devDirect = { type: "device" as const, id: "dev_direct" };
    const devGroupA = { type: "device" as const, id: "dev_groupA" };
    const devGroupB = { type: "device" as const, id: "dev_groupB" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    // Setup hierarchy: system → grpA → devGroupA, system → grpB → devGroupB
    await zbar.addRelation(ctx, sys, "parent", grpA);
    await zbar.addRelation(ctx, sys, "parent", grpB);
    await zbar.addRelation(ctx, grpA, "container", devGroupA);
    await zbar.addRelation(ctx, grpB, "container", devGroupB);

    // Configure notification sources
    await zbar.addRelation(ctx, devDirect, "source", rule); // direct
    await zbar.addRelation(ctx, grpA, "source", rule);      // group expands to devGroupA
    await zbar.addRelation(ctx, sys, "source", rule);        // system expands to devGroupA + devGroupB

    // All three devices should be effective sources
    // devGroupA appears via both group and system, but is deduplicated
    const allSources = await zbar.list()
      .object(rule)
      .relation("source")
      .subject("device")
      .collect(ctx);
    expect(allSources.map(s => s.subjectId).sort()).toEqual(
      ["dev_direct", "dev_groupA", "dev_groupB"],
    );
  });

  test("removing device from group removes effective source", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, {
      schema: notificationSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const group = { type: "group" as const, id: "grp1" };
    const dev1 = { type: "device" as const, id: "dev1" };
    const dev2 = { type: "device" as const, id: "dev2" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    await zbar.addRelation(ctx, group, "container", dev1);
    await zbar.addRelation(ctx, group, "container", dev2);
    await zbar.addRelation(ctx, group, "source", rule);

    // Both devices are sources
    let sources = await zbar.list()
      .object(rule)
      .relation("source")
      .subject("device")
      .collect(ctx);
    expect(sources.map(s => s.subjectId).sort()).toEqual(["dev1", "dev2"]);

    // Remove dev1 from group
    await zbar.removeRelation(ctx, group, "container", dev1);

    // Only dev2 should remain as source
    sources = await zbar.list()
      .object(rule)
      .relation("source")
      .subject("device")
      .collect(ctx);
    expect(sources.map(s => s.subjectId)).toEqual(["dev2"]);
  });

  test("adding device to group after group is already a source", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, {
      schema: notificationSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const group = { type: "group" as const, id: "grp1" };
    const dev1 = { type: "device" as const, id: "dev1" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    // First make group a source
    await zbar.addRelation(ctx, group, "source", rule);

    // Then add a device to the group
    await zbar.addRelation(ctx, group, "container", dev1);

    // Device should become an effective source
    const sources = await zbar.list()
      .object(rule)
      .relation("source")
      .subject("device")
      .collect(ctx);
    expect(sources.map(s => s.subjectId)).toEqual(["dev1"]);
  });

  test("removing group from system cascades device_member removal from system", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, {
      schema: notificationSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const sys = { type: "system" as const, id: "sys1" };
    const group = { type: "group" as const, id: "grp1" };
    const dev1 = { type: "device" as const, id: "dev1" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    // Build chain and make system a source
    await zbar.addRelation(ctx, sys, "parent", group);
    await zbar.addRelation(ctx, group, "container", dev1);
    await zbar.addRelation(ctx, sys, "source", rule);

    // dev1 is effective source via system
    let sources = await zbar.list()
      .object(rule)
      .relation("source")
      .subject("device")
      .collect(ctx);
    expect(sources.map(s => s.subjectId)).toEqual(["dev1"]);

    // Break the chain: remove group from system
    await zbar.removeRelation(ctx, sys, "parent", group);

    // dev1 should no longer be a source (device_member on system removed)
    sources = await zbar.list()
      .object(rule)
      .relation("source")
      .subject("device")
      .collect(ctx);
    expect(sources).toEqual([]);
  });

  test("adding device to group after system hierarchy is set up", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, {
      schema: notificationSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const sys = { type: "system" as const, id: "sys1" };
    const group = { type: "group" as const, id: "grp1" };
    const dev1 = { type: "device" as const, id: "dev1" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    // Set up system → group and system as source first
    await zbar.addRelation(ctx, sys, "parent", group);
    await zbar.addRelation(ctx, sys, "source", rule);

    // No device sources yet
    let sources = await zbar.list()
      .object(rule)
      .relation("source")
      .subject("device")
      .collect(ctx);
    expect(sources).toEqual([]);

    // NOW add device to group — should cascade all the way to notification_rule
    await zbar.addRelation(ctx, group, "container", dev1);

    // dev1 should now be an effective source
    sources = await zbar.list()
      .object(rule)
      .relation("source")
      .subject("device")
      .collect(ctx);
    expect(sources.map(s => s.subjectId)).toEqual(["dev1"]);
  });

  test("permissions still work alongside reverse edges", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, {
      schema: notificationSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const alice = { type: "user" as const, id: "alice" };
    const sys = { type: "system" as const, id: "sys1" };
    const group = { type: "group" as const, id: "grp1" };
    const dev1 = { type: "device" as const, id: "dev1" };

    // Setup hierarchy: system → group → device
    await zbar.addRelation(ctx, sys, "parent", group);
    await zbar.addRelation(ctx, group, "container", dev1);

    // Make alice admin of system
    await zbar.addRelation(ctx, alice, "admin", sys);

    // Alice should have admin on group via parent.admin traversal
    const canManageGroup = await zbar.hasRelationship(ctx, alice, "admin", group);
    expect(canManageGroup).toBe(true);

    // Alice should have admin on device via container.admin traversal
    const canManage = await zbar.hasRelationship(ctx, alice, "admin", dev1);
    expect(canManage).toBe(true);

    // Also verify view via inheritance
    const canView = await zbar.hasRelationship(ctx, alice, "viewer", dev1);
    expect(canView).toBe(true);
  });

  test("deleteEntity cleans up both forward and reverse edges", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, {
      schema: notificationSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const group = { type: "group" as const, id: "grp1" };
    const dev1 = { type: "device" as const, id: "dev1" };
    const rule = { type: "notification_rule" as const, id: "rule1" };

    await zbar.addRelation(ctx, group, "container", dev1);
    await zbar.addRelation(ctx, group, "source", rule);

    // Device is effective source
    let sources = await zbar.list()
      .object(rule)
      .relation("source")
      .subject("device")
      .collect(ctx);
    expect(sources.length).toBe(1);

    // Delete the device entirely
    await zbar.deleteEntity(ctx, dev1);

    // No more device sources
    sources = await zbar.list()
      .object(rule)
      .relation("source")
      .subject("device")
      .collect(ctx);
    expect(sources.length).toBe(0);
  });
});
