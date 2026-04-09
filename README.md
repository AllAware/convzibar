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
- **Reverse Edges:** Declare `{ type: "group", reverse: "device_member" }` on
  a relation to automatically insert a mirrored edge in the opposite direction
  at write-time. Combined with traversals and usersets, this enables powerful
  V-pattern lookups that resolve in a single indexed query.
- **Fluent List Queries:** `.list()` for effective (materialized) relationship
  queries with optional `.via()` intermediary filtering, and `.listDirect()` for
  raw base-relationship queries. Both support `.map()` and `.collect()`.
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

Relations support four kinds of targets:

| Syntax | Name | Meaning |
|---|---|---|
| `"user"` | Entity type | Direct subject type (e.g., a user can hold this relation) |
| `"admin"` | Local inheritance | This relation includes all holders of `admin` on the same object |
| `"parent_org.admin"` | Traversal (dot) | Follow the `parent_org` relation, inherit `admin` from the target |
| `"group#admin"` | Userset (hash) | When a group is the subject, expand through that group's `admin` relation |
| `{ type: "group", reverse: "device_member" }` | Reverse edge | Auto-insert a mirrored edge in the opposite direction at write-time |

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

### 4. Fluent List Queries

#### Effective Relationships (`.list()`)

Query the materialized effective-relationship graph with full write-time
expansion. Supports listing objects or subjects, optional `.via()`
intermediary filtering, and `.map()` transformation.

**List all objects a subject can access:**

```typescript
const projects = await zbar.list()
  .object("project")
  .permission("edit")
  .subject({ type: "user", id: userId })
  .collect(ctx, { timezone: "EST" });
// Returns: [{ objectId: "proj_123" }, ...]
```

**List all subjects who have access to an object:**

```typescript
const users = await zbar.list()
  .object({ type: "project", id: projId })
  .permission("edit")
  .subject("user")
  .collect(ctx, { timezone: "EST" });
// Returns: [{ subjectId: "user_456" }, ...]
```

**Filter through intermediary nodes with `.via()`:**

```typescript
// Only devices accessible through a specific system
const devices = await zbar.list()
  .object("device")
  .permission("view")
  .subject({ type: "user", id: userId })
  .via({ type: "system", id: systemId })
  .collect(ctx);

// Chained via: user → group → system → devices
const devices = await zbar.list()
  .object("device")
  .permission("view")
  .subject({ type: "user", id: userId })
  .via({ type: "group", id: groupId }, { type: "system", id: systemId })
  .collect(ctx);
```

**Transform results with `.map()`:**

```typescript
const deviceNames = await zbar.list()
  .object("device")
  .permission("view")
  .subject({ type: "user", id: userId })
  .map(async (d) => {
    const device = await ctx.db.get(d.objectId as Id<"devices">);
    return device?.name;
  })
  .collect(ctx);
```

#### Direct Relationships (`.listDirect()`)

Query the raw `relationships` table — only explicitly-written edges, no
transitive or inherited expansions. Useful for management UIs.

```typescript
// All direct relationships where org1 is the object
const rels = await zbar.listDirect()
  .object({ type: "org", id: "org1" })
  .collect(ctx);
// Returns: [{ subject: { type, id }, relation, object: { type, id } }, ...]

// Filter by relation (with inheritance: owner → admin → viewer)
const viewers = await zbar.listDirect()
  .object({ type: "org", id: "org1" })
  .relation("viewer")
  .collect(ctx);

// Filter by permission (expands to all contributing relations)
const editors = await zbar.listDirect()
  .object({ type: "org", id: "org1" })
  .permission("edit_settings")
  .collect(ctx);

// Combine object + subject
const rels = await zbar.listDirect()
  .object({ type: "org", id: "org1" })
  .subject({ type: "user", id: "u1" })
  .collect(ctx);
```

### 5. Reverse Edges

Reverse edges solve the **V-pattern problem**: when you need to query a
relationship graph in both directions from a single write.

Declare `reverse` on a relation's type target to automatically insert a
mirrored edge in the opposite direction whenever the forward edge is written
(and remove it when the forward edge is removed):

```typescript
.entity("device", (e) =>
    e.relation("container", { type: "group", reverse: "device_member" })
)
```

When `group → container → device` is written, the engine automatically inserts
`device → device_member → group`. The reverse edge is a real relationship that
participates in all graph expansion — traversals, usersets, and cascading
deletes work exactly as if you had written both edges manually.

#### Example: Notification Source Expansion

A common use case is expanding a group or system into its individual members.
By combining reverse edges with traversals and usersets, you can build multi-hop
materialization chains that resolve in a single indexed query at read-time.

```typescript
const schema = createZbarSchema()
  .entity("user")
  .entity("system", (e) =>
    e
      .relation("owner", "user")
      .relation("admin", "user", "owner")
      .relation("viewer", "user", "admin")
      // Populated by reverse on group.parent
      .relation("has_group", "group")
      // 2-hop traversal: device_member propagates from groups to system
      .relation("device_member", "device", "has_group.device_member")
      .relation("contact_member", "contact", "has_group.contact_member")
      // ...permissions
  )
  .entity("group", (e) =>
    e
      // Reverse: system → parent → group auto-creates group → has_group → system
      .relation("parent", { type: "system", reverse: "has_group" })
      // Populated by reverse on device.container
      .relation("device_member", "device")
      // Populated by reverse on contact.container
      .relation("contact_member", "contact")
      // ...permissions
  )
  .entity("device", (e) =>
    e
      // Reverse: group → container → device auto-creates device → device_member → group
      // Then has_group.device_member on system propagates: device → device_member → system
      .relation("container", { type: "group", reverse: "device_member" })
      // ...permissions
  )
  .entity("contact", (e) =>
    e
      .relation("container", { type: "group", reverse: "contact_member" })
      // ...permissions
  )
  .entity("notification_rule", (e) =>
    e
      // group#device_member: when group is source, expand to all devices in the group
      // system#device_member: when system is source, expand to all devices in the system
      .relation("source", "device", "group#device_member", "system#device_member")
      .relation("recipient", "contact", "group#contact_member", "system#contact_member")
  )
  .build();
```

**What you write:**

```typescript
// Build the hierarchy (2 writes)
await zbar.addRelation(ctx, system, "parent", group);
await zbar.addRelation(ctx, group, "container", device);

// Configure notification sources
await zbar.addRelation(ctx, device, "source", rule);  // direct
await zbar.addRelation(ctx, group, "source", rule);   // expands to all group devices
await zbar.addRelation(ctx, system, "source", rule);  // expands to all system devices
```

**What the engine materializes:**

```
system → parent → group             ──► group → has_group → system        (reverse)
group  → container → device          ──► device → device_member → group    (reverse)
                                     ──► device → device_member → system   (traversal)
```

**Event-time query (single indexed read):**

```typescript
// "What notification rules is this device a source of?"
const rules = await zbar.list()
  .object("notification_rule")
  .relation("source")
  .subject({ type: "device", id: deviceId })
  .collect(ctx);

// "What contacts should receive this notification?"
const contacts = await zbar.list()
  .object(rule)
  .relation("recipient")
  .subject("contact")
  .collect(ctx);

// Management UI: show the raw configured sources (not expanded)
const configuredSources = await zbar.listDirect()
  .object(rule)
  .relation("source")
  .collect(ctx);
```

### 6. Other Queries

**Check if a subject has a specific relationship:**

```typescript
const isEditor = await zbar.hasRelationship(
  ctx,
  { type: "user", id: userId },
  "editor",
  { type: "project", id: projId },
  { timezone: "EST" },
);
```

### 7. React Hooks

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

### 8. Cleaning Up

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

- **`relationships` table:** Stores the ground-truth edges (including
  auto-inserted reverse edges).
- **`effectiveRelationships` table:** A materialized cache storing flattened
  cross-object traversal paths. It heavily utilizes token lineage so that deeply
  nested edge deletions can cascade securely and surgically in O(N) without full
  graph re-computations.
- **Storage Optimization:** Local inheritance (e.g., `admin` implicitly granting
  `viewer`) is purposefully _not_ expanded in the cache. It is inferred entirely
  in memory during the read step to prevent massive database write
  amplification.
- **Reverse Edges:** Declared via `{ type, reverse }` in the schema. At
  write-time, the engine inserts the mirrored edge as a real base relationship
  and queues it for graph expansion alongside the forward edge. On removal,
  both edges are deleted atomically and their downstream derivations are
  cascade-removed.
