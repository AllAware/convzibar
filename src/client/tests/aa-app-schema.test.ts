import { expect, test, describe } from "vitest";
import { convexTest } from "convex-test";
import { Zbar, createZbarSchema } from "../index.js";
import { v } from "convex/values";
import schema from "../../component/schema.js";
import { api } from "../../component/_generated/api.js";
import { register as registerWorkpool } from "@convex-dev/workpool/test";

// ============================================================================
// Downstream-consumer parity: aa-app's production schema, verbatim.
//
// aa-app (the primary consumer of this package) defines the schema below in
// `schemas/zbar.ts` and drives it with a fixed set of call patterns:
// `can` / `getPermissions` / `addRelation` / `removeRelation` / `setRelation`
// / `deleteEntity`, plus `.list()` (with `.via()`) and `.listDirect()`
// (with `.map()` and edge `properties`). This file pins those exact paths so
// engine refactors can't silently break the consumer.
//
// Keep in sync with aa-app `schemas/zbar.ts` when its model changes.
// ============================================================================

const aaSchema = createZbarSchema()
  .entity("user", (e) => e)

  .entity("system", (e) =>
    e
      .relation("owner")
      .relation("admin", "owner")
      .relation("viewer", "admin")

      .relation("has_group")
      .relation("has_rule")
      .relation("has_geofence")
      .relation("has_system_user")

      .relation("user_member", "viewer")
      .relation("device_member")

      .permission("view", "viewer")
      .permission("view_as_member", "user_member")
      .permission("manage_resources", "admin")
      .permission("manage_members", "admin")
      .permission("manage_owners", "owner")
      .permission("manage", "owner")
      .permission("configure_as_recipient", "admin"),
  )

  .entity("group", (e) =>
    e
      .relation("parent", { type: "system", reverse: "has_group" })
      .relation("admin")
      .relation("viewer", "admin")
      .readTimeRelation("admin", "parent.admin")
      .readTimeRelation("viewer", "parent.viewer")
      .relation("user_member", "viewer")

      .relation("admin_device")
      .relation("viewer_device")
      .relation("admin_geofence")
      .relation("viewer_geofence")
      .relation("admin_notification_rule")
      .relation("viewer_notification_rule")
      .relation("admin_system_user")
      .relation("viewer_system_user")

      .relation("device_member", "admin_device", "viewer_device")
      .relation("system_user_visible", "viewer_system_user")

      .permission("view", "viewer")
      .permission("manage", "admin")
      .permission("manage_members", "admin")
      .permission("configure_as_recipient", "admin"),
  )

  .entity("device", (e) =>
    e
      .relation("parent", { type: "system", reverse: "device_member" })
      .relation("admin", { type: "group", reverse: "admin_device" })
      .relation("viewer", "admin", { type: "group", reverse: "viewer_device" })
      .readTimeRelation("admin", "parent.admin", "group#admin")
      .readTimeRelation("viewer", "parent.viewer", "group#viewer")
      .relation("user_member", "viewer")
      .permission("view", "viewer")
      .permission("manage", "admin")
      .permission("manage_members", "admin"),
  )

  .entity("geofence", (e) =>
    e
      .relation("parent", { type: "system", reverse: "has_geofence" })
      .relation("admin", { type: "group", reverse: "admin_geofence" })
      .relation("viewer", "admin", { type: "group", reverse: "viewer_geofence" })
      .readTimeRelation("admin", "parent.admin", "group#admin")
      .readTimeRelation("viewer", "parent.viewer", "group#viewer")
      .permission("view", "viewer")
      .permission("manage", "admin"),
  )

  .entity("system_user", (e) =>
    e
      .relation("parent", { type: "system", reverse: "has_system_user" })
      .relation("identity", "user")
      .relation("admin", { type: "group", reverse: "admin_system_user" })
      .relation("viewer", "admin", {
        type: "group",
        reverse: "viewer_system_user",
      })
      .readTimeRelation("admin", "parent.admin", "group#admin")
      .readTimeRelation("viewer", "parent.viewer", "group#viewer")
      .permission("view", "viewer")
      .permission("manage", "admin")
      .permission("configure_as_recipient", "viewer"),
  )

  .entity("notification_rule", (e) =>
    e
      .relation("parent", { type: "system", reverse: "has_rule" })
      .relation(
        "source",
        "system",
        "device",
        "group",
        "group#device_member",
        "system#device_member",
      )
      .relation(
        "recipient",
        "system",
        "system_user",
        "group",
        "group#system_user_visible",
      )
      .properties("recipient", {
        email: v.optional(v.boolean()),
        sms: v.optional(v.boolean()),
        push: v.optional(v.boolean()),
      })
      .relation("admin", { type: "group", reverse: "admin_notification_rule" })
      .readTimeRelation("admin", "parent.admin", "group#admin")
      .relation("viewer", "admin", {
        type: "group",
        reverse: "viewer_notification_rule",
      })
      .readTimeRelation("viewer", "parent.viewer", "group#viewer")
      .permission("view", "viewer")
      .permission("manage", "admin"),
  )

  .extend("system", (e) =>
    e
      .relation("owner", "system_user", "system_user#identity")
      .relation("admin", "system_user", "system_user#identity")
      .relation("viewer", "system_user", "system_user#identity")
      .readTimeRelation("user_member", "has_group.user_member"),
  )
  .extend("group", (e) =>
    e
      .relation("admin", "system_user", "system_user#identity")
      .relation("viewer", "system_user", "system_user#identity"),
  )
  .build();

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

// Mirror aa-app's client options (convex/zbar.ts): synchronous writes so a
// freshly added relation is queryable in the same mutation, depth 10.
const mkZbar = () =>
  new Zbar(api, { schema: aaSchema, asyncWrites: false, maxWriteDepth: 10 });

const ref = (type: string, id: string) => ({ type, id }) as any;

// Fixture mirroring aa-app provisioning (convex/service.ts + containment.ts):
//   system s1
//   ├── su_owner  (identity u_owner)  — owner of s1
//   ├── su_member (identity u_member) — viewer of s1
//   ├── group g1  (su_ga admin; identity u_ga)
//   ├── device d1 (admin-tier containment in g1)
//   ├── device d2 (viewer-tier containment in g1)
//   └── rule nr1  (source: s1, recipient: su_member with channel properties)
async function provision(zbar: any, ctx: any) {
  const s1 = ref("system", "s1");
  const g1 = ref("group", "g1");
  const d1 = ref("device", "d1");
  const d2 = ref("device", "d2");
  const nr1 = ref("notification_rule", "nr1");
  const suOwner = ref("system_user", "su_owner");
  const suGa = ref("system_user", "su_ga");
  const suMember = ref("system_user", "su_member");
  const uOwner = ref("user", "u_owner");
  const uGa = ref("user", "u_ga");
  const uMember = ref("user", "u_member");

  // Seats and identities.
  for (const [su, u] of [
    [suOwner, uOwner],
    [suGa, uGa],
    [suMember, uMember],
  ]) {
    await zbar.addRelation(ctx, s1, "parent", su);
    await zbar.addRelation(ctx, u, "identity", su);
  }
  await zbar.addRelation(ctx, suOwner, "owner", s1);
  await zbar.addRelation(ctx, suMember, "viewer", s1);

  // Group + containment tiers.
  await zbar.addRelation(ctx, s1, "parent", g1);
  await zbar.addRelation(ctx, suGa, "admin", g1);
  await zbar.addRelation(ctx, s1, "parent", d1);
  await zbar.addRelation(ctx, s1, "parent", d2);
  await zbar.addRelation(ctx, g1, "admin", d1);
  await zbar.addRelation(ctx, g1, "viewer", d2);

  // Notification rule wiring.
  await zbar.addRelation(ctx, s1, "parent", nr1);
  await zbar.addRelation(ctx, s1, "source", nr1);
  await zbar.addRelation(ctx, suMember, "recipient", nr1, {
    properties: { email: true, push: true },
  });

  return { s1, g1, d1, d2, nr1, suOwner, suGa, suMember, uOwner, uGa, uMember };
}

describe("aa-app schema parity", () => {
  test("ownership chain through system_user#identity grants full system permissions", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const f = await provision(zbar, ctx);

    expect(await zbar.can(ctx, f.uOwner, "manage", f.s1)).toBe(true);
    expect(await zbar.can(ctx, f.uOwner, "manage_owners", f.s1)).toBe(true);
    expect(await zbar.can(ctx, f.uMember, "view", f.s1)).toBe(true);
    expect(await zbar.can(ctx, f.uMember, "manage", f.s1)).toBe(false);

    const perms = await zbar.getPermissions(ctx, f.uOwner, f.s1);
    expect(new Set(perms)).toEqual(
      new Set([
        "view",
        "view_as_member",
        "manage_resources",
        "manage_members",
        "manage_owners",
        "manage",
        "configure_as_recipient",
      ]),
    );
    expect(await zbar.getPermissions(ctx, f.uMember, f.s1)).toEqual(
      expect.arrayContaining(["view", "view_as_member"]),
    );
  });

  test("group admin/viewer resolve via parent.* read-time paths", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const f = await provision(zbar, ctx);

    // System owner manages the group through the parent.admin RT path.
    expect(await zbar.can(ctx, f.uOwner, "manage", f.g1)).toBe(true);
    // Group admin manages the group directly, but not the system.
    expect(await zbar.can(ctx, f.uGa, "manage", f.g1)).toBe(true);
    expect(await zbar.can(ctx, f.uGa, "manage", f.s1)).toBe(false);
    expect(await zbar.can(ctx, f.uGa, "view", f.s1)).toBe(false);
    // System viewer sees the group through parent.viewer RT.
    expect(await zbar.can(ctx, f.uMember, "view", f.g1)).toBe(true);
    expect(await zbar.can(ctx, f.uMember, "manage", f.g1)).toBe(false);
  });

  test("device containment: group#admin / group#viewer read-time usersets", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const f = await provision(zbar, ctx);

    // Admin-tier containment: group admin manages d1.
    expect(await zbar.can(ctx, f.uGa, "manage", f.d1)).toBe(true);
    // Viewer-tier containment: group admin only views d2.
    expect(await zbar.can(ctx, f.uGa, "manage", f.d2)).toBe(false);
    expect(await zbar.can(ctx, f.uGa, "view", f.d2)).toBe(true);
    // System-level access flows through parent.* RT paths.
    expect(await zbar.can(ctx, f.uOwner, "manage", f.d1)).toBe(true);
    expect(await zbar.can(ctx, f.uMember, "view", f.d1)).toBe(true);
    expect(await zbar.can(ctx, f.uMember, "manage", f.d1)).toBe(false);
    // Strangers see nothing.
    expect(await zbar.can(ctx, ref("user", "outsider"), "view", f.d1)).toBe(false);

    expect(
      new Set(await zbar.getPermissions(ctx, f.uGa, f.d1)),
    ).toEqual(new Set(["view", "manage", "manage_members"]));
  });

  test(".list() with permission + .via() system gate (scopedList pattern)", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const f = await provision(zbar, ctx);

    const ids = (rows: any[]) => new Set(rows.map((r) => r.objectId));

    const gaDevices = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject(f.uGa)
      .collect(ctx);
    expect(ids(gaDevices)).toEqual(new Set(["d1", "d2"]));

    const ownerDevicesViaSystem = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject(f.uOwner)
      .via(f.s1)
      .collect(ctx);
    expect(ids(ownerDevicesViaSystem)).toEqual(new Set(["d1", "d2"]));

    // Subject-mode list (users.ts pattern): groups administered by a group.
    const adminGroups = await zbar
      .list()
      .object(f.d1)
      .relation("admin")
      .subject("group")
      .collect(ctx);
    expect(adminGroups.map((r: any) => r.subjectId)).toEqual(["g1"]);
  });

  test("V-pattern source lookup: device reaches rule via system#device_member", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const f = await provision(zbar, ctx);

    // notifications/debounce.ts hot path: rules whose source covers a device.
    const rules = await zbar
      .list()
      .object("notification_rule")
      .relation("source")
      .subject(f.d1)
      .collect(ctx);
    expect(rules.map((r: any) => r.objectId)).toEqual(["nr1"]);

    // A device from outside the system matches nothing.
    const none = await zbar
      .list()
      .object("notification_rule")
      .relation("source")
      .subject(ref("device", "d_foreign"))
      .collect(ctx);
    expect(none).toEqual([]);
  });

  test("recipient edge properties round-trip through .listDirect() (resolve.ts pattern)", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const f = await provision(zbar, ctx);

    const edges = await zbar
      .listDirect()
      .object(f.nr1)
      .relation("recipient")
      .collect(ctx);
    expect(edges).toHaveLength(1);
    expect(edges[0].subject).toEqual({ type: "system_user", id: "su_member" });
    expect(edges[0].properties).toEqual({ email: true, push: true });

    // systemUsers.ts pattern: .map() over direct edges. The subject→object
    // direction holds the explicit `owner` grant plus the auto-mirrored
    // `has_system_user` reverse of the seat's `parent` edge.
    const relations = await zbar
      .listDirect()
      .object(f.s1)
      .subject(f.suOwner)
      .map(({ relation }: any) => relation)
      .collect(ctx);
    expect(new Set(relations)).toEqual(new Set(["has_system_user", "owner"]));
  });

  test("role changes: remove+add (users.ts) and setRelation (migrate.ts)", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const f = await provision(zbar, ctx);

    // Promote member seat: viewer → admin via remove+add (aa-app deliberately
    // avoids setRelation here so the parent edge is untouched).
    await zbar.removeRelation(ctx, f.suMember, "viewer", f.s1);
    await zbar.addRelation(ctx, f.suMember, "admin", f.s1);
    expect(await zbar.can(ctx, f.uMember, "manage_resources", f.s1)).toBe(true);
    expect(await zbar.can(ctx, f.uMember, "manage", f.s1)).toBe(false);

    // setRelation clears every other relation between the pair atomically.
    await zbar.setRelation(ctx, f.suMember, "viewer", f.s1);
    expect(await zbar.can(ctx, f.uMember, "manage_resources", f.s1)).toBe(false);
    expect(await zbar.can(ctx, f.uMember, "view", f.s1)).toBe(true);
  });

  test("deleteEntity tears down containment and access (service.ts teardown)", async () => {
    const t = setup();
    const ctx = mkCtx(t);
    const zbar = mkZbar();
    const f = await provision(zbar, ctx);

    await zbar.deleteEntity(ctx, f.d1);
    expect(await zbar.can(ctx, f.uGa, "manage", f.d1)).toBe(false);
    expect(await zbar.can(ctx, f.uOwner, "view", f.d1)).toBe(false);
    const devices = await zbar
      .list()
      .object("device")
      .permission("view")
      .subject(f.uGa)
      .collect(ctx);
    expect(devices.map((r: any) => r.objectId)).toEqual(["d2"]);

    // Deleting the identity user severs the seat-derived access.
    await zbar.deleteEntity(ctx, f.uGa);
    expect(await zbar.can(ctx, f.uGa, "view", f.d2)).toBe(false);
    expect(await zbar.can(ctx, f.uGa, "manage", f.g1)).toBe(false);
  });
});
