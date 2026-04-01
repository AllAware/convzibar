# Convzibar (Convex x Zanzibar)

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
- **Userset Expansion:** Use `#` syntax (e.g., `group#admin`) to allow
  non-user entities as subjects. When a group is made admin of a resource, all
  admins of that group automatically inherit access via write-time expansion.
- **Runtime Validation:** Subject types are validated against the schema at
  runtime, preventing invalid entity combinations from being written to the
  graph.
- **Perfect TypeScript Inference:** The `createZbarSchema` definition provides
  100% strict type-checking and autocomplete for all subjects, objects,
  relations, and permissions without any codegen steps.

## Installation

```bash
npm install @csilvas/convzibar
```

Register the component in your `convex.config.ts`:

```typescript
import { defineApp } from "convex/server";
import zbar from "@csilvas/convzibar/convex.config";

const app = defineApp();
app.use(zbar);
export default app;
```

## Quick Start

### 1. Define your Authorization Schema

Create a shared file (e.g., `convex/zbar.ts`) to define your schema. This serves
as the single source of truth and powers the TypeScript inference.

```typescript
import { createZbarSchema, Zbar } from "@csilvas/convzibar";
import { components } from "./_generated/api";

export type MyContext = {
  timezone?: string;
  active?: boolean;
  userRank?: "novice" | "expert";
};

export const zbarSchema = createZbarSchema<MyContext>()
  // Define dynamic conditions (ABAC)
  // 1. Conditions can return a boolean to allow/deny access
  .condition("isBusinessHours", (ctx, { data }) => data.timezone === "EST")
  .condition("isActive", (ctx, { data }) => data.active === true)

  // 2. Conditions can also act as "middleware" by returning an object.
  // This object is merged into the context (`data`) for all subsequent
  // condition checks in the evaluation chain! You have full access to `ctx` (QueryCtx).
  .condition("injectUserRank", async (ctx, { subject, data }) => {
    // e.g. Query your database to fetch additional data
    const user = await ctx.runQuery(components.api.users.get, {
      id: subject.id,
    });
    return { userRank: user?.rank || "novice" };
  })

  // This condition relies on the `userRank` injected above
  .condition("isExpert", (ctx, { data }) => data.userRank === "expert")

  // Define your Entity Graph (ReBAC)
  .entity("user")
  .entity("org", (e) =>
    e
      .relation("owner", "user")

      // Local Inheritance: Admins include Owners
      .relation("admin", "user", "owner")

      // Local Inheritance: Viewers include Admins
      .relation("viewer", "user", "admin")

      .permission("edit_settings", "admin")
      .permission("view_dashboard", "viewer"),
  )
  .entity("group", (e) =>
    e
      // Userset: groups and orgs can be admins of a group.
      // When an org is made admin, all admins of that org inherit access.
      .relation("admin", "user", "org#admin", "group#admin")

      // Local + Userset: viewers include admins, plus org/group viewer usersets
      .relation("viewer", "user", "admin", "org#viewer", "group#viewer")

      .permission("manage", "admin")
      .permission("view", "viewer"),
  )
  .entity("project", (e) =>
    e
      .relation("parent_org", "org")

      // Cross-Object Traversal (dot syntax):
      // A project editor includes direct users AND any admin of the parent org
      .relation("editor", "user", "parent_org.admin")

      // Permissions can require conditions
      .permission("edit", { relation: "editor", condition: "isBusinessHours" })

      // A condition can rely on data injected by a previous condition in the evaluation chain!
      .permission("delete", { relation: "editor", condition: "isExpert" }),
  )
  .build();

// Export the strictly typed client instance
export const zbar = new Zbar(components.convzibar, {
  schema: zbarSchema,
  tenantId: "default", // Useful for multi-tenant isolation
});
```

#### Schema Syntax Reference

Relations support three kinds of targets:

| Syntax | Name | Meaning |
|---|---|---|
| `"user"` | Entity type | Direct subject type (e.g., a user can hold this relation) |
| `"admin"` | Local inheritance | This relation includes all holders of `admin` on the same object |
| `"parent_org.admin"` | Traversal (dot) | Follow the `parent_org` relation, inherit `admin` from the target |
| `"group#admin"` | Userset (hash) | When a group is the subject, expand through that group's `admin` relation |

### 2. Mutating the Graph (Write-Time)

When you assign relationships, the engine automatically calculates cross-object
traversals (like `project.editor` derived from `org.admin`) and caches them for
lightning-fast reads.

```typescript
import { mutation } from "./_generated/server";
import { zbar } from "./zbar";

export const createProject = mutation({
  handler: async (ctx, args) => {
    // ... create project and org in your db ...

    // Link the project to the org
    await zbar.addRelation(ctx, { type: "project", id: projId }, "parent_org", {
      type: "org",
      id: orgId,
    });

    // Add a user as an admin to the org
    await zbar.addRelation(ctx, { type: "user", id: userId }, "admin", {
      type: "org",
      id: orgId,
    });

    // Add a group as admin of another group (userset expansion)
    await zbar.addRelation(ctx, { type: "group", id: teamId }, "admin", {
      type: "group",
      id: groupId,
    });
  },
});
```

You can also attach conditions directly to the graph edges. Edges in a path are
evaluated first, allowing them to act as middleware that injects context for
later conditions!

```typescript
// This edge uses our middleware condition to dynamically fetch and inject the user's rank
await zbar.addRelation(
  ctx,
  { type: "user", id: userId },
  "editor",
  { type: "project", id: projId },
  { condition: "injectUserRank" },
);

// This edge is only valid if the explicit context provides { active: true }
await zbar.addRelation(
  ctx,
  { type: "user", id: userId },
  "viewer",
  { type: "project", id: projId },
  { condition: "isActive" },
);
```

You can also seamlessly change and override relationships. Because this system
performs zero-downtime Add-before-Remove background chaining, the user will
never experience a temporary loss of access during the update:

```typescript
// Replace "viewer" with "admin" seamlessly
await zbar.updateRelation(
  ctx,
  { type: "user", id: userId },
  "viewer", // old
  "admin", // new
  { type: "project", id: projId },
);

// Force the user to be an "owner" and automatically delete any
// other relationships they might already have on this object.
await zbar.setRelation(ctx, { type: "user", id: userId }, "owner", {
  type: "project",
  id: projId,
});
```

### 3. Checking Permissions (Read-Time)

Checking permissions takes a single, fast O(1) database query. The client engine
infers local inheritance and evaluates conditions dynamically.

```typescript
import { query } from "./_generated/server";
import { zbar } from "./zbar";

export const getProjectData = query({
  handler: async (ctx, args) => {
    // Check permission (throws Error if denied)
    await zbar.require(
      ctx,
      { type: "user", id: userId },
      "edit",
      { type: "project", id: projId },
      { timezone: "EST" }, // Inject runtime context for ABAC conditions
    );

    // Or safely check boolean
    const canEdit = await zbar.can(
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

### 4. React Hooks

We provide a specialized hook to check permissions on the client, caching them
using `useQuery` under the hood. To use `useCan`, you must expose a query
handler using the `zbar.checkPermissionFast` query and wrap your application in
the `ZbarProvider`.

```typescript
// convex/queries.ts
import { query } from "./_generated/server";
import { zbar } from "./zbar";

// Expose a public query to your frontend
export const checkPermission = query({
  args: {
    permission: v.string(),
    resource: v.object({ type: v.string(), id: v.string() }),
    requestContext: v.any(), // Important if using MyContext!
  },
  handler: async (ctx, args) => {
    // Determine subject from the auth context (e.g. convex auth)
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return false;

    return await zbar.can(
      ctx,
      { type: "user", id: identity.subject },
      args.permission as any,
      args.resource as any,
      args.requestContext,
    );
  },
});
```

Then in your React app, you can generate fully type-safe hooks by passing
`typeof zbarSchema` to `createReactZbar`:

```tsx
// lib/zbar.ts
import { createReactZbar } from "@csilvas/convzibar/react";
import type { zbarSchema } from "../convex/zbar"; // Import your schema type

export const { ZbarProvider, useCan, usePermissions } =
  createReactZbar<typeof zbarSchema>();
```

Now use your generated provider and hooks anywhere:

```tsx
// app/providers.tsx
import { ZbarProvider } from "../lib/zbar";
import { api } from "../convex/_generated/api";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ZbarProvider checkPermissionQuery={api.queries.checkPermission}>
      {children}
    </ZbarProvider>
  );
}

// app/MyComponent.tsx
import { useCan } from "../lib/zbar";

export function MyComponent({ projectId }: { projectId: string }) {
  // Pass runtime context that aligns with `MyContext`
  const canEdit = useCan(
    "edit",
    { type: "project", id: projectId },
    { timezone: "EST" },
  );

  if (!canEdit) return <div>Access Denied</div>;
  return <button>Edit Project</button>;
}
```

### 5. Fetching Lists

You can query the graph bi-directionally in O(1) time.

**Find all objects a user can access:**

```typescript
const projects = await zbar.listAccessibleObjects(
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
const users = await zbar.listSubjectsWithAccess(
  ctx,
  "user", // The subject type to search for
  "edit",
  { type: "project", id: projId },
  { timezone: "EST" },
);
// Returns: [{ subjectId: "user_456" }, ...]
```

**Check if a subject has a specific relationship on an object:**

```typescript
const isEditor = await zbar.hasRelationship(
  ctx,
  { type: "user", id: userId },
  "editor",
  { type: "project", id: projId },
  { timezone: "EST" }, // Optional context
);
```

**Get all valid relationships a subject has on an object:**

```typescript
// To get only explicit relations and exclude inherited ones (default):
const explicitRels = await zbar.getRelationships(
  ctx,
  { type: "user", id: userId },
  { type: "project", id: projId },
);
// Returns: ["owner"]

const relationships = await zbar.getRelationships(
  ctx,
  { type: "user", id: userId },
  { type: "project", id: projId },
  { timezone: "EST" }, // Optional conditions context
  { includeInherited: true }, // Expands inheritance
);
// Returns: ["viewer", "editor", "owner"] (respects local inheritance!)
```

### 6. Cleaning Up

When an entity is deleted from your application, you must remove it from the
authorization graph to prevent stale access and clean up the traversal cache.

```typescript
export const deleteProject = mutation({
  handler: async (ctx, args) => {
    // Scours the graph for any incoming or outgoing relationships involving this project,
    // deletes them, and safely cascade-deletes all derived paths in the cache.
    await zbar.deleteEntity(ctx, { type: "project", id: projId });
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
