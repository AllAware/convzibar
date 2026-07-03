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

const mkCtx = (t: any) =>
  ({
    runQuery: t.query.bind(t),
    runMutation: t.mutation.bind(t),
  }) as any;

// ============================================================================
// Schema using .extend() for forward references — NO `as any` needed
// ============================================================================

const extendSchema = createZbarSchema()
  .entity("user")
  .entity("system", (e) =>
    e
      .relation("owner", "user")
      .relation("admin", "user", "owner")
      .relation("viewer", "user", "admin")
      // Placeholder — will be wired up by group.owner's reverse + .extend()
      .relation("has_group")
      .permission("view", "viewer")
      .permission("manage_groups", "admin")
  )
  .entity("group", (e) =>
    e
      .relation("owner", { type: "system", reverse: "has_group" })
      .relation("device_member")
      .relation("contact_member")
      .relation("admin", "user", "owner.admin")
      .relation("viewer", "user", "admin", "owner.viewer")
      .permission("view", "viewer")
      .permission("manage", "admin")
  )

  // ✅ Forward references: group is now defined, so dot-paths resolve cleanly
  .extend("system", (e) =>
    e
      .relation("device_member", "has_group.device_member")
      .relation("contact_member", "has_group.contact_member")
  )

  .entity("device", (e) =>
    e
      .relation("owner", "system", { type: "system", reverse: "device_member" })
      .relation("container", "group", {
        type: "group",
        reverse: "device_member",
      })
      .relation("admin", "user", "owner.admin", "container.admin")
      .relation("viewer", "user", "admin", "owner.viewer", "container.viewer")
      .permission("view", "viewer")
      .permission("manage", "admin")
  )

  .entity("contact", (e) =>
    e
      .relation("owner", "system", {
        type: "system",
        reverse: "contact_member",
      })
      .relation("container", "group", {
        type: "group",
        reverse: "contact_member",
      })
      .relation("admin", "owner.admin", "container.admin")
      .relation("viewer", "admin", "owner.viewer", "container.viewer")
      .permission("view", "viewer")
      .permission("manage", "admin")
  )

  .entity("notification_rule", (e) =>
    e
      .relation("owner", "system")
      .relation(
        "source",
        "device",
        "group#device_member",
        "system#device_member",
      )
      .relation(
        "recipient",
        "contact",
        "group#contact_member",
        "system#contact_member",
      )
  )
  .build();

// ============================================================================
// Tests: .extend() produces the correct runtime schema
// ============================================================================

describe("SchemaBuilder.extend()", () => {
  test("extend merges relations into existing entity", () => {
    const systemRelations = Object.keys(extendSchema.entities.system.relations);

    // Original relations from .entity()
    expect(systemRelations).toContain("owner");
    expect(systemRelations).toContain("admin");
    expect(systemRelations).toContain("viewer");
    expect(systemRelations).toContain("has_group");

    // Relations added via .extend()
    expect(systemRelations).toContain("device_member");
    expect(systemRelations).toContain("contact_member");
  });

  test("extend preserves permissions from original entity", () => {
    const systemPermissions = Object.keys(
      extendSchema.entities.system.permissions,
    );
    expect(systemPermissions).toContain("view");
    expect(systemPermissions).toContain("manage_groups");
  });

  test("extend preserves relation values (dot-path traversals)", () => {
    const rels = extendSchema.entities.system.relations as any;
    expect(rels.device_member).toBe("has_group.device_member");
    expect(rels.contact_member).toBe("has_group.contact_member");
  });

  test("extended schema works end-to-end with reverse edges", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = new Zbar(api, {
      schema: extendSchema,
      asyncWrites: false,
    });

    const alice = { type: "user" as const, id: "alice" };
    const sys = { type: "system" as const, id: "sys1" };
    const grp = { type: "group" as const, id: "grp1" };
    const dev = { type: "device" as const, id: "dev1" };

    // Build the hierarchy:
    // alice → owner → system
    // system ← owner ← group  (group.owner points to system, with reverse: has_group)
    // group ← container ← device (device.container points to group, with reverse: device_member)
    await zbar.addRelation(ctx, alice, "owner", sys);
    await zbar.addRelation(ctx, sys, "owner", grp);   // group.owner = system
    await zbar.addRelation(ctx, grp, "container", dev); // device.container = group

    // Alice is system owner → inherits admin → viewer on device via:
    //   device.owner.admin → system.admin → system.owner (alice)
    expect(await zbar.can(ctx, alice, "view", grp)).toBe(true);
    expect(await zbar.can(ctx, alice, "manage", grp)).toBe(true);
  });

  test("extend merges targets into existing relation instead of overwriting", () => {
    // When .extend() calls .relation() on a name that already has targets,
    // the new targets should be appended, not replace the originals.
    const schema = createZbarSchema()
      .entity("user")
      .entity("system", (e) =>
        e
          .relation("owner", "user")
          .relation("admin", "user", "owner")
          .relation("viewer", "user", "admin")
          .relation("has_group")
          .relation("user_member", "viewer")  // initial: inherits from viewer
          .permission("view", "viewer")
      )
      .entity("group", (e) =>
        e
          .relation("owner", { type: "system", reverse: "has_group" })
          .relation("user_member", "user")
          .relation("admin", "user", "owner.admin")
          .relation("viewer", "user", "admin", "owner.viewer")
      )
      .extend("system", (e) =>
        e.relation("user_member", "has_group.user_member")
      )
      .build();

    const rels = schema.entities.system.relations as any;
    // Should contain BOTH the original 'viewer' AND the new traversal
    expect(rels.user_member).toEqual(["viewer", "has_group.user_member"]);
  });

  test("extend merge deduplicates identical string targets", () => {
    const schema = createZbarSchema()
      .entity("user")
      .entity("system", (e) =>
        e
          .relation("owner", "user")
          .relation("admin", "user", "owner")
          .relation("viewer", "user", "admin")
      )
      .extend("system", (e) =>
        e.relation("viewer", "user", "admin")  // duplicates of existing targets
      )
      .build();

    const rels = schema.entities.system.relations as any;
    // 'user' and 'admin' already existed — should not be duplicated
    expect(rels.viewer).toEqual(["user", "admin"]);
  });

  test("extend merge deduplicates identical object targets", () => {
    const schema = createZbarSchema()
      .entity("user")
      .entity("system", (e) =>
        e
          .relation("owner", "user")
          .relation("has_group")
      )
      .entity("group", (e) =>
        e.relation("parent", { type: "system", reverse: "has_group" })
      )
      .extend("system", (e) =>
        // Adding the same reverse-edge object again should not duplicate
        e.relation("has_group", "group")
      )
      .build();

    const rels = schema.entities.system.relations as any;
    // Placeholder was resolved to 'group' by the reverse edge mechanism,
    // then extend adds 'group' — should be just 'group', not ['group', 'group']
    expect(rels.has_group).toBe("group");
  });

  test("extend on placeholder relation sets value without merging", () => {
    // When the original relation is a placeholder (undefined), extend
    // should just set the new value normally.
    const schema = createZbarSchema()
      .entity("user")
      .entity("system", (e) =>
        e
          .relation("owner", "user")
          .relation("has_group")      // placeholder
          .relation("device_member")  // placeholder
      )
      .entity("group", (e) =>
        e.relation("device_member", "user")
      )
      .extend("system", (e) =>
        e
          .relation("has_group", "group")
          .relation("device_member", "has_group.device_member")
      )
      .build();

    const rels = schema.entities.system.relations as any;
    expect(rels.device_member).toBe("has_group.device_member");
  });

  test("extend throws for undefined entity", () => {
    expect(() => {
      createZbarSchema()
        .entity("user")
        // @ts-expect-error — 'bogus' is not a defined entity
        .extend("bogus", (e: any) => e.relation("foo"))
        .build();
    }).toThrow("Cannot extend entity 'bogus'");
  });
});

// ============================================================================
// Type-level tests: verify reverse inference resolves placeholder targets
// ============================================================================

describe("Reverse type inference", () => {
  test("dot-paths through resolved placeholders are validated", () => {
    // This schema compiles — has_group is resolved to 'group' via the
    // reverse declaration, so 'has_group.device_member' is validated
    // against group's actual relations.
    const _schema = createZbarSchema()
      .entity("user")
      .entity("system", (e) =>
        e.relation("owner", "user").relation("has_group"),
      )
      .entity("group", (e) =>
        e
          .relation("parent", { type: "system", reverse: "has_group" })
          .relation("device_member")
          .relation("contact_member"),
      )
      .extend("system", (e) =>
        e
          // ✅ 'device_member' is a valid relation on 'group'
          .relation("device_member", "has_group.device_member")
          // ✅ 'contact_member' is a valid relation on 'group'
          .relation("contact_member", "has_group.contact_member"),
      )
      .build();

    expect(_schema).toBeDefined();
  });

  test("invalid dot-paths through resolved placeholders are caught", () => {
    createZbarSchema()
      .entity("user")
      .entity("system", (e) =>
        e.relation("owner", "user").relation("has_group"),
      )
      .entity("group", (e) =>
        e
          .relation("parent", { type: "system", reverse: "has_group" })
          .relation("device_member"),
      )
      .extend("system", (e) =>
        e
          // @ts-expect-error — 'nonexistent' is NOT a relation on 'group'
          .relation("bad", "has_group.nonexistent"),
      );
  });

  test("invalid reverse relation names are caught", () => {
    createZbarSchema()
      .entity("user")
      .entity("system", (e) =>
        e.relation("owner", "user").relation("has_group"),
      )
      .entity("group", (e) =>
        e.relation(
          "parent",
          // @ts-expect-error — 'nonexistent' is NOT a relation on 'system'
          { type: "system", reverse: "nonexistent" },
        ),
      );
  });

  test("unresolved placeholders reject dot-paths (no ${string} fallback)", () => {
    createZbarSchema()
      .entity("user")
      .entity("system", (e) =>
        e
          .relation("owner", "user")
          .relation("has_group") // placeholder, never resolved
          // @ts-expect-error — has_group target is unresolved (string), dot-path rejected
          .relation("bad", "has_group.anything"),
      );
  });
});
