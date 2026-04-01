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

// Schema: groups can be admins of other groups (userset expansion).
// When group1 is made admin of group2, all admins of group1 become
// effective admins of group2.
const groupSchema = createZbarSchema<any>()
  .entity("user")
  .entity("group", (e) =>
    e
      .relation("admin", "user", "group#admin")
      .relation("member", "user", "admin", "group#member")
      .permission("manage", "admin")
      .permission("view", "member"),
  )
  .build();

// Schema: groups can be editors of folders (cross-entity userset).
const folderSchema = createZbarSchema<any>()
  .entity("user")
  .entity("group", (e) =>
    e.relation("admin", "user").relation("member", "user", "admin"),
  )
  .entity("folder", (e) =>
    e
      .relation("editor", "user", "group#member")
      .relation("viewer", "user", "editor")
      .permission("write", "editor")
      .permission("read", "viewer"),
  )
  .build();

describe("Userset Expansion: Self-Referential Group Hierarchy", () => {
  test("group admins inherit through group-as-admin", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: groupSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const groupA = { type: "group" as const, id: "a" };
    const groupB = { type: "group" as const, id: "b" };

    // Alice is admin of group A
    await zbar.addRelation(ctx, alice, "admin", groupA);

    // Group A is admin of group B (userset: all admins of A become admins of B)
    await zbar.addRelation(ctx, groupA, "admin", groupB);

    // Alice should be effective admin of group B
    expect(await zbar.can(ctx, alice, "manage", groupB)).toBe(true);

    // Bob has no access
    expect(await zbar.can(ctx, bob, "manage", groupB)).toBe(false);
  });

  test("adding user after group link propagates correctly", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: groupSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const alice = { type: "user" as const, id: "alice" };
    const groupA = { type: "group" as const, id: "a" };
    const groupB = { type: "group" as const, id: "b" };

    // First link the groups
    await zbar.addRelation(ctx, groupA, "admin", groupB);

    // Then add alice as admin of group A
    await zbar.addRelation(ctx, alice, "admin", groupA);

    // Alice should still become effective admin of group B
    expect(await zbar.can(ctx, alice, "manage", groupB)).toBe(true);
  });

  test("three-level group hierarchy: A -> B -> C", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: groupSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const groupA = { type: "group" as const, id: "a" };
    const groupB = { type: "group" as const, id: "b" };
    const groupC = { type: "group" as const, id: "c" };

    // Build the chain: A admin of B, B admin of C
    await zbar.addRelation(ctx, alice, "admin", groupA);
    await zbar.addRelation(ctx, groupA, "admin", groupB);
    await zbar.addRelation(ctx, groupB, "admin", groupC);

    // Bob is direct admin of C
    await zbar.addRelation(ctx, bob, "admin", groupC);

    // Alice should be effective admin of all three groups
    expect(await zbar.can(ctx, alice, "manage", groupA)).toBe(true);
    expect(await zbar.can(ctx, alice, "manage", groupB)).toBe(true);
    expect(await zbar.can(ctx, alice, "manage", groupC)).toBe(true);

    // Bob is only admin of C
    expect(await zbar.can(ctx, bob, "manage", groupA)).toBe(false);
    expect(await zbar.can(ctx, bob, "manage", groupB)).toBe(false);
    expect(await zbar.can(ctx, bob, "manage", groupC)).toBe(true);
  });

  test("removing group link cascades removal", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: groupSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const alice = { type: "user" as const, id: "alice" };
    const groupA = { type: "group" as const, id: "a" };
    const groupB = { type: "group" as const, id: "b" };

    await zbar.addRelation(ctx, alice, "admin", groupA);
    await zbar.addRelation(ctx, groupA, "admin", groupB);

    // Verify alice has access
    expect(await zbar.can(ctx, alice, "manage", groupB)).toBe(true);

    // Remove the group link
    await zbar.removeRelation(ctx, groupA, "admin", groupB);

    // Alice should no longer have access to group B
    expect(await zbar.can(ctx, alice, "manage", groupB)).toBe(false);

    // But still has access to group A
    expect(await zbar.can(ctx, alice, "manage", groupA)).toBe(true);
  });

  test("removing user from parent group cascades through hierarchy", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: groupSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const alice = { type: "user" as const, id: "alice" };
    const groupA = { type: "group" as const, id: "a" };
    const groupB = { type: "group" as const, id: "b" };

    await zbar.addRelation(ctx, alice, "admin", groupA);
    await zbar.addRelation(ctx, groupA, "admin", groupB);
    expect(await zbar.can(ctx, alice, "manage", groupB)).toBe(true);

    // Remove alice from group A
    await zbar.removeRelation(ctx, alice, "admin", groupA);

    // Alice should lose access to both
    expect(await zbar.can(ctx, alice, "manage", groupA)).toBe(false);
    expect(await zbar.can(ctx, alice, "manage", groupB)).toBe(false);
  });

  test("member relation inherits through group userset", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: groupSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const groupA = { type: "group" as const, id: "a" };
    const groupB = { type: "group" as const, id: "b" };

    // Alice is member of group A, Bob is admin of group A
    await zbar.addRelation(ctx, alice, "member", groupA);
    await zbar.addRelation(ctx, bob, "admin", groupA);

    // Group A is member of group B
    await zbar.addRelation(ctx, groupA, "member", groupB);

    // Alice should be able to view group B (member -> view)
    expect(await zbar.can(ctx, alice, "view", groupB)).toBe(true);
    // Alice should not be able to manage group B
    expect(await zbar.can(ctx, alice, "manage", groupB)).toBe(false);

    // Bob (admin of A) should also be a member of B via admin->member inheritance
    // and via group.member userset
    expect(await zbar.can(ctx, bob, "view", groupB)).toBe(true);
  });
});

describe("Userset Expansion: Cross-Entity (Group as Folder Editor)", () => {
  test("group members become folder editors via userset", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: folderSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const alice = { type: "user" as const, id: "alice" };
    const bob = { type: "user" as const, id: "bob" };
    const devTeam = { type: "group" as const, id: "dev" };
    const docs = { type: "folder" as const, id: "docs" };

    // Alice and Bob are members of dev team
    await zbar.addRelation(ctx, alice, "member", devTeam);
    await zbar.addRelation(ctx, bob, "member", devTeam);

    // Dev team is editor of docs folder
    await zbar.addRelation(ctx, devTeam, "editor", docs);

    // Both should be able to write
    expect(await zbar.can(ctx, alice, "write", docs)).toBe(true);
    expect(await zbar.can(ctx, bob, "write", docs)).toBe(true);

    // And read (viewer inherits from editor)
    expect(await zbar.can(ctx, alice, "read", docs)).toBe(true);
  });

  test("adding member to group after folder link propagates", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: folderSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const alice = { type: "user" as const, id: "alice" };
    const devTeam = { type: "group" as const, id: "dev" };
    const docs = { type: "folder" as const, id: "docs" };

    // Link group to folder first
    await zbar.addRelation(ctx, devTeam, "editor", docs);

    // Then add alice to the group
    await zbar.addRelation(ctx, alice, "member", devTeam);

    // Alice should have write access
    expect(await zbar.can(ctx, alice, "write", docs)).toBe(true);
  });

  test("removing group from folder removes member access", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: folderSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const alice = { type: "user" as const, id: "alice" };
    const devTeam = { type: "group" as const, id: "dev" };
    const docs = { type: "folder" as const, id: "docs" };

    await zbar.addRelation(ctx, alice, "member", devTeam);
    await zbar.addRelation(ctx, devTeam, "editor", docs);
    expect(await zbar.can(ctx, alice, "write", docs)).toBe(true);

    // Remove group from folder
    await zbar.removeRelation(ctx, devTeam, "editor", docs);

    // Alice should lose access
    expect(await zbar.can(ctx, alice, "write", docs)).toBe(false);
  });

  test("group admin inherits member userset on folder", async () => {
    const t = setup();
    const ctx = {
      runQuery: t.query.bind(t),
      runMutation: t.mutation.bind(t),
    } as any;

    const zbar = new Zbar(api, {
      schema: folderSchema,
      tenantId: "t1",
      asyncWrites: false,
    });

    const alice = { type: "user" as const, id: "alice" };
    const devTeam = { type: "group" as const, id: "dev" };
    const docs = { type: "folder" as const, id: "docs" };

    // Alice is admin of dev team (admin inherits member locally)
    await zbar.addRelation(ctx, alice, "admin", devTeam);

    // Dev team is editor of docs (userset expands through group.member)
    await zbar.addRelation(ctx, devTeam, "editor", docs);

    // Alice should have write access since admin -> member -> userset expansion
    expect(await zbar.can(ctx, alice, "write", docs)).toBe(true);
  });
});
