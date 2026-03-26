# @csilvas/convex-rebac

A high-performance, strictly typed ReBAC and ABAC authorization engine built
specifically for Convex, heavily inspired by Google Zanzibar.

This library provides **O(1) read-time authorization checks** by pre-computing
cross-object relationship traversals at write-time, while inferring local
(same-object) role inheritance dynamically at read-time to minimize database
write amplification.

## Features

- **Pure Zanzibar ReBAC:** Define relationships between entities (e.g.,
  `user -> owner -> org`, `folder -> parent -> project`) and traverse them
  safely.
- **Leopard Indexing (O(1) Reads):** Cross-object graph traversals are expanded
  at write-time and cached using a materialized path array, allowing `.can()`
  checks to require just a single indexed B-tree database read.
- **Local Inheritance Inference:** Inheritance on the same object (e.g., an
  `admin` is implicitly a `viewer`) is computed at read-time in memory, keeping
  your database writes incredibly lean.
- **Unified ABAC + ReBAC:** Attach dynamic conditions to both relationships
  (write-time edges) and permissions (read-time requirements). Conditions are
  evaluated with injected runtime context.
- **Bidirectional Relationships:** Automatically insert and maintain reverse
  edges (e.g., `org -> owner_of_org -> user`) to allow reverse queries.
- **Perfect TypeScript Inference:** The `createAuthSchema` definition provides
  100% strict type-checking and autocomplete for all subjects, objects,
  relations, and permissions without any codegen steps.

## Installation

```bash
npm install @csilvas/convex-rebac
```

Register the component in your `convex.config.ts`:

```typescript
import { defineApp } from "convex/server";
import authz from "@csilvas/convex-rebac/convex.config";

const app = defineApp();
app.use(authz);
export default app;
```

## Quick Start

### 1. Define your Authorization Schema

Create a shared file (e.g., `convex/authz.ts`) to define your schema. This
serves as the single source of truth and powers the TypeScript inference.

```typescript
import { createAuthSchema, Authz } from "@csilvas/convex-rebac";
import { components } from "./_generated/api";

export const authSchema = createAuthSchema({
  // Define dynamic conditions (ABAC)
  conditions: {
    isBusinessHours: (ctx) => ctx.timezone === "EST",
    isActive: (ctx) => ctx.active === true,
  },

  // Define your Entity Graph (ReBAC)
  entities: {
    user: {},
    org: {
      relations: {
        // Reverse edges are automatically created!
        owner: { type: "user", reverse: "owner_of_org" },

        // Local Inheritance: Admins include Owners
        admin: ["user", "owner"],

        // Local Inheritance: Viewers include Admins
        viewer: ["user", "admin"],
      },
      permissions: {
        edit_settings: ["admin"],
        view_dashboard: ["viewer"],
      },
    },
    project: {
      relations: {
        parent_org: "org",

        // Cross-Object Traversal:
        // A project editor includes direct users AND any admin of the parent org
        editor: ["user", "parent_org.admin"],
      },
      permissions: {
        // Permissions can require conditions
        edit: [{ relation: "editor", condition: "isBusinessHours" }],
      },
    },
  },
});

// Export the strictly typed client instance
export const authz = new Authz(components.convex_rebac, {
  schema: authSchema,
  tenantId: "default", // Useful for multi-tenant isolation
});
```

### 2. Mutating the Graph (Write-Time)

When you assign relationships, the engine automatically calculates cross-object
traversals (like `project.editor` derived from `org.admin`) and caches them for
lightning-fast reads.

```typescript
import { mutation } from "./_generated/server";
import { authz } from "./authz";

export const createProject = mutation({
  handler: async (ctx, args) => {
    // ... create project and org in your db ...

    // Link the project to the org
    await authz.addRelation(
      ctx,
      { type: "project", id: projId },
      "parent_org",
      { type: "org", id: orgId },
    );

    // Add a user as an admin to the org
    await authz.addRelation(ctx, { type: "user", id: userId }, "admin", {
      type: "org",
      id: orgId,
    });
  },
});
```

You can also attach conditions directly to the graph edges:

```typescript
// This relationship is only valid if the context provides { active: true }
await authz.addRelation(
  ctx,
  { type: "user", id: userId },
  "viewer",
  { type: "project", id: projId },
  { condition: "isActive" },
);
```

### 3. Checking Permissions (Read-Time)

Checking permissions takes a single, fast O(1) database query. The client engine
infers local inheritance and evaluates conditions dynamically.

```typescript
import { query } from "./_generated/server";
import { authz } from "./authz";

export const getProjectData = query({
  handler: async (ctx, args) => {
    // Check permission (throws Error if denied)
    await authz.require(
      ctx,
      { type: "user", id: userId },
      "edit",
      { type: "project", id: projId },
      { timezone: "EST" }, // Inject runtime context for ABAC conditions
    );

    // Or safely check boolean
    const canEdit = await authz.can(
      ctx,
      { type: "user", id: userId },
      "edit",
      { type: "project", id: projId },
      { timezone: "EST" },
    );

    if (canEdit) {
      return "Secret Data";
    }
  },
});
```

### 4. Fetching Lists

You can query the graph bi-directionally in O(1) time.

**Find all objects a user can access:**

```typescript
const projects = await authz.listAccessibleObjects(
  ctx,
  { type: "user", id: userId },
  "edit",
  "project", // The target object type
  { timezone: "EST" },
);
// Returns: [{ objectId: "proj_123" }, ...]
```

**Find all users who have access to an object:**

```typescript
const users = await authz.listUsersWithAccess(
  ctx,
  { type: "project", id: projId },
  "edit",
  { timezone: "EST" },
);
// Returns: [{ userId: "user_456" }, ...]
```

### 5. Cleaning Up

When an entity is deleted from your application, you must remove it from the
authorization graph to prevent stale access and clean up the traversal cache.

```typescript
export const deleteProject = mutation({
  handler: async (ctx, args) => {
    // Scours the graph for any incoming or outgoing relationships involving this project,
    // deletes them, and safely cascade-deletes all derived paths in the cache.
    await authz.deleteEntity(ctx, { type: "project", id: projId });
  },
});
```

## Architecture Notes

- **`relationships` table:** Stores the ground-truth edges.
- **`effectiveRelationships` table:** A materialized cache storing flattened
  cross-object traversal paths. It heavily utilizes token lineage so that deeply
  nested edge deletions can cascade securely and surgically in O(N) without full
  graph re-computations.
- **Storage Optimization:** Local inheritance (e.g., `admin` implicitly granting
  `viewer`) is purposefully _not_ expanded in the cache. It is inferred entirely
  in memory during the read step to prevent massive database write
  amplification.
