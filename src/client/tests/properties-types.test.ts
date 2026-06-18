/**
 * Type-level tests for edge properties.
 * These tests verify TypeScript inference — they don't run any logic,
 * they just ensure the compiler accepts/rejects the right patterns.
 */
import { describe, test } from "vitest";
import { createZbarSchema, Zbar } from "../index.js";
import { v } from "convex/values";

describe("Edge Properties — Type Inference", () => {
  test("type-level: properties are inferred correctly from schema", () => {
    const schema = createZbarSchema()
      .entity("user")
      .entity("org", (e) =>
        e
          .relation("admin", "user")
          .relation("viewer", "user", "admin")
          .properties("admin", {
            title: v.string(),
            level: v.number(),
          })
          .properties("viewer", {
            expires: v.optional(v.string()),
          })
          .permission("manage", "admin"),
      )
      .build();

    // This is a compile-time check — we're just asserting the schema
    // builds without type errors and the property validators are present.
    const adminProps = schema.entities.org.propertyValidators.admin;
    const viewerProps = schema.entities.org.propertyValidators.viewer;

    // These should be the validator objects
    void adminProps.title;
    void adminProps.level;
    void viewerProps.expires;
  });

  test("type-level: addRelation accepts correct property shapes", async () => {
    const schema = createZbarSchema()
      .entity("user")
      .entity("org", (e) =>
        e
          .relation("owner", "user")
          .relation("admin", "user")
          .properties("admin", {
            title: v.string(),
            level: v.number(),
            note: v.optional(v.string()),
          }),
      )
      .build();

    const zbar = new Zbar({} as any, {
      schema,
      asyncWrites: false,
    });

    // These are just type-checks — they'll never actually execute
    // because we pass a dummy component. We're testing that the
    // TypeScript compiler accepts the right property shapes.

    // @ts-expect-error — "owner" has no properties, so `properties` should not be allowed
    void ((z: typeof zbar) =>
      z.addRelation({} as any, { type: "user", id: "u1" }, "owner", { type: "org", id: "o1" }, {
        properties: { anything: true },
      }));

    // Valid: all required fields present
    void ((z: typeof zbar) =>
      z.addRelation({} as any, { type: "user", id: "u1" }, "admin", { type: "org", id: "o1" }, {
        properties: { title: "CTO", level: 1 },
      }));

    // Valid: required + optional fields
    void ((z: typeof zbar) =>
      z.addRelation({} as any, { type: "user", id: "u1" }, "admin", { type: "org", id: "o1" }, {
        properties: { title: "CTO", level: 1, note: "founder" },
      }));

    // @ts-expect-error — missing required field "level"
    void ((z: typeof zbar) =>
      z.addRelation({} as any, { type: "user", id: "u1" }, "admin", { type: "org", id: "o1" }, {
        properties: { title: "CTO" },
      }));

    // @ts-expect-error — wrong type for "level"
    void ((z: typeof zbar) =>
      z.addRelation({} as any, { type: "user", id: "u1" }, "admin", { type: "org", id: "o1" }, {
        properties: { title: "CTO", level: "high" },
      }));
  });

  test("type-level: entities without properties still work unchanged", () => {
    const schema = createZbarSchema()
      .entity("user")
      .entity("org", (e) =>
        e
          .relation("owner", "user")
          .relation("admin", "user", "owner")
          .permission("manage", "admin"),
      )
      .build();

    const zbar = new Zbar({} as any, {
      schema,
      asyncWrites: false,
    });

    // Should compile fine without properties
    void ((z: typeof zbar) =>
      z.addRelation({} as any, { type: "user", id: "u1" }, "owner", { type: "org", id: "o1" }));

    void ((z: typeof zbar) =>
      z.addRelation({} as any, { type: "user", id: "u1" }, "admin", { type: "org", id: "o1" }));
  });
});
