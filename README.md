# Convzibar (Convex x Zanzibar)

A high-performance, strictly typed ReBAC and ABAC authorization engine built
specifically for Convex, heavily inspired by Google Zanzibar.

Convzibar is a **hybrid engine**: you choose, per relation, whether cross-object
paths are flattened at write-time (fast reads, larger writes) or joined at
read-time (zero write amplification, bounded-depth reads). Every question —
`can()`, `hasRelationship()`, `.list()`, `.via()`, `getPermissions()` — is
answered by compiling the schema into a small operator tree and evaluating it
against the materialized cache plus any read-time branches.

## Features

- **Pure Zanzibar ReBAC:** Define relationships between entities (e.g.,
  `user -> owner -> org`, `folder -> parent -> project`) and traverse them
  safely.
- **Hybrid materialization model:** Declare cross-object traversals with
  `.relation('editor', 'user', 'parent_org.admin')` to flatten them at
  write-time (one indexed lookup), or with `.readTimeRelation('editor',
  'parent_org.admin')` to join them at read-time (zero write fan-out, 2–3
  indexed queries). Local inheritance (e.g., `admin` implies `viewer`) is
  always computed in memory.
- **Unified planning algebra:** Every read is compiled into a typed operator
  tree — `Materialised`, `ValidatedMaterialised`, `EdgeExpand`, `Compose`,
  `Union` — with cost-ordered execution, sequential narrowing for batch
  checks, and fan-out collapsing through batched Convex round-trips. There's
  no hand-rolled "try cache, fall back to RT" ladder; both strategies are
  branches of the same plan.
- **Batched fan-outs:** `Compose.expandObjectsFromMany` and
  `expandSubjectsFromMany` collapse multi-hop chains to **O(depth)** Convex
  round-trips instead of O(branching<sup>depth</sup>), so deep read-time
  chains stay fast.
- **Multi-permission batching:** `getPermissions()` resolves every permission
  on `(subject, object)` in **one** materialized query plus at most one
  shared read-time branch per unique `(derivedRelation, sourceType)`.
- **Unified ABAC + ReBAC:** Attach dynamic conditions to both relationships
  (write-time edges) and permissions (read-time requirements). Conditions
  evaluate in order along the path, and a condition that returns an object
  merges its data into the context for downstream conditions (middleware).
- **Userset Expansion:** Use `#` syntax (e.g., `group#admin`) to allow
  non-user entities as subjects. When a group is made admin of a resource,
  all admins of that group inherit access — materialized at write-time by
  default, or read-time if declared via `.readTimeRelation()`.
- **Reverse Edges:** Declare `{ type: "group", reverse: "device_member" }`
  on a relation to automatically insert a mirrored edge in the opposite
  direction at write-time. Combined with traversals and usersets, this
  enables powerful V-pattern lookups that resolve in a single indexed query.
- **Token-lineage cascade deletes:** Every materialized path carries the IDs
  of the base edges that produced it. Removing a base edge surgically deletes
  only the derived paths that depend on it, in **O(N)**, without recomputing
  the graph.
- **Schema-load cycle detection:** Read-time path declarations are checked
  for cycles at `new Zbar()` time via a 3-color DFS. A cyclic RT chain would
  silently return `false` once it hit the depth cap — catching it at schema
  load prevents denies-when-should-grant bugs from ever reaching production.
- **Fluent List Queries:** `.list()` for effective-relationship queries with
  optional `.via()` intermediary filtering, and `.listDirect()` for raw
  base-relationship queries. Both support `.map()` and `.collect()`.
- **Runtime Validation:** Subject types are validated against the schema at
  runtime, preventing invalid entity combinations from being written to the
  graph.
- **Perfect TypeScript Inference:** The `createZbarSchema` definition
  provides 100% strict type-checking and autocomplete for all subjects,
  objects, relations, and permissions without any codegen steps.

## Installation

This package is distributed directly from GitHub (not the npm registry). Install
a specific tagged version with bun or npm:

```bash
bun add github:AllAware/convzibar#v1.0.0
# or
npm install github:AllAware/convzibar#v1.0.0
```

If the repo is private, see [PUBLISHING.md](./PUBLISHING.md) for how to give
your CI/CD build access via a fine-grained PAT.

Register the component in your `convex.config.ts`:

```typescript
import { defineApp } from "convex/server";
import zbar from "convzibar/convex.config";

const app = defineApp();
app.use(zbar);
export default app;
```

## Quick Start

### 1. Define your Authorization Schema

Create a shared file (e.g., `convex/zbar.ts`) to define your schema. This serves
as the single source of truth and powers the TypeScript inference.

```typescript
import { createZbarSchema, Zbar } from "convzibar";
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
      // A project editor includes direct users AND any admin of the parent org.
      // This edge materializes at write-time — reads are a single indexed lookup.
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
  tenantId: "default",    // Useful for multi-tenant isolation
  readTimeChainDepth: 3,  // Max depth for chained read-time paths (default: 3)
});
```

#### Schema Syntax Reference

Relations support these target kinds:

| Syntax | Name | When resolved | Meaning |
|---|---|---|---|
| `"user"` / `{ type: "user" }` | Entity type | Write-time | Direct subject type (e.g., a user can hold this relation) |
| `"admin"` | Local inheritance | Read-time (in memory) | This relation includes all holders of `admin` on the same object |
| `"parent_org.admin"` | Traversal (dot) | Write-time | Follow the `parent_org` relation, inherit `admin` from the target. Materialized into `effectiveRelationships` at write-time |
| `"group#admin"` | Userset (hash) | Write-time | When a group is the subject, expand through that group's `admin` relation. Materialized at write-time |
| `{ type: "group", reverse: "device_member" }` | Reverse edge | Write-time | Auto-insert a mirrored edge in the opposite direction at write-time |
| `.readTimeRelation("editor", "parent_org.admin")` | Read-time path | Read-time (on demand) | Same shape as a dot-path or userset, but **no** traversal rule is generated — `can()` / `list()` join it at read-time in 2–3 queries |

### 2. Mutating the Graph (Write-Time)

When you assign a relationship, the engine immediately enqueues a BFS that
expands any **write-time** cross-object traversal rules (dot-paths and
usersets declared via `.relation()`). Read-time declarations are skipped
during this phase — they contribute nothing to `effectiveRelationships`.

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

A permission check compiles a plan once and evaluates it. For relations with
no read-time branches, that's a single indexed lookup against the materialized
cache. For relations with read-time dot-paths or usersets, the plan becomes a
`Union` that short-circuits on the first hit — usually the direct materialized
branch (cost 1) — and only runs RT branches on a miss.

```typescript
import { query } from "./_generated/server";
import { zbar } from "./zbar";

export const getProjectData = query({
  handler: async (ctx, args) => {
    // Check permission (throws PermissionError if denied)
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

    // Check a specific relation (skips permission → relation expansion)
    const isEditor = await zbar.hasRelationship(
      ctx,
      { type: "user", id: userId },
      "editor",
      { type: "project", id: projId },
      { timezone: "EST" },
    );

    // Get every permission the subject holds — resolved in ONE materialized
    // query plus at most one shared RT branch per unique derived relation.
    const perms = await zbar.getPermissions(
      ctx,
      { type: "user", id: userId },
      { type: "project", id: projId },
      { timezone: "EST" },
    );
    // perms: Array<"edit" | "delete">  (typed from the schema)

    if (canEdit) {
      return "Secret Data";
    }
  },
});
```

### 4. Read-Time Relations

For high-fan-out paths, materializing every transitive edge at write-time
becomes expensive — assigning one group as a source can expand into thousands
of per-member rows. `readTimeRelation()` lets you declare the same schema
shape but defer the join to read-time:

```typescript
.entity("project", (e) =>
  e
    .relation("parent_org", "org")
    // Must declare the typed target so subjects can be written to it.
    .relation("editor", "user", "parent_org.admin")

    // Write-time version (default): materialized into effectiveRelationships.
    // Assigning a single user as 'admin' of a parent_org flashes an effective
    // edge onto every project under that org.
    //
    // Read-time version: swap the `.relation()` traversal for
    // `.readTimeRelation()` instead. No fan-out writes; reads cost 2 indexed
    // queries (fetch parent_org, then check admin on it).
    .readTimeRelation("editor", "parent_org.admin")
)
```

Both path shapes are supported:

- **Dot-path** `"source.target"` — follow the local `source` relation to an
  intermediate, then pick up its `target` relation.
- **Userset** `"type#target"` — when a subject of `type` is assigned to the
  derived relation, expand through that entity's `target` relation at read
  time. The derived relation must declare `type` as a typed target.

#### Trade-offs

| | Write-time (`.relation`) | Read-time (`.readTimeRelation`) |
|---|---|---|
| Write cost | O(fan-out × depth) effective rows | 0 |
| Read cost | 1 indexed lookup | 2 queries per hop (capped at `readTimeChainDepth`) |
| Best for | Hot-read paths, low fan-out | High fan-out, dynamic membership, low query volume |

#### Chaining and cycle detection

Read-time paths compose. If `contact.viewer = system.viewer` is declared
read-time and `system.viewer` itself references another read-time path, the
planner recurses — up to `readTimeChainDepth` hops (default: 3). Cycles in
the read-time graph are detected at schema load via a 3-color DFS; if you
accidentally declare a loop, `new Zbar()` throws with the full cycle path.

### 5. Fluent List Queries

#### Effective Relationships (`.list()`)

Query the materialized effective-relationship graph. Under the hood, `.list()`
compiles a plan identical in shape to the one `can()` uses — so read-time
branches, usersets, and dot-paths are all transparent. Supports listing
objects or subjects, optional `.via()` intermediary filtering, and `.map()`
transformation.

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

When the via entity is referenced by a userset rewrite or dot-path on the
target relation, `.via()` uses a **tight gate** that scans only the relevant
relations on that entity. Otherwise it falls back to a loose gate and runs a
per-candidate verification pass. The engine makes this choice automatically
from the schema.

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

### 6. Reverse Edges

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

**Read-time query (single indexed read):**

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

### 7. Multi-Tenancy

A single `Zbar` instance is bound to one `tenantId`. To operate against a
different tenant, derive a new instance with `.withTenant()`:

```typescript
const tenantZbar = zbar.withTenant("tenant_abc");
await tenantZbar.can(ctx, user, "edit", project);
```

All queries and mutations are tenant-scoped via indexed prefixes on the
`relationships` and `effectiveRelationships` tables — tenants are fully
isolated with no cross-tenant leaks.

### 8. React Hooks

A specialized hook checks permissions on the client, caching them under
Convex's `useQuery`. Expose a server-side permission query and wrap your app
in the provider:

```typescript
// convex/queries.ts
import { query } from "./_generated/server";
import { zbar } from "./zbar";

export const checkPermission = query({
  args: {
    permission: v.string(),
    resource: v.object({ type: v.string(), id: v.string() }),
    requestContext: v.any(),
  },
  handler: async (ctx, args) => {
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

Then generate type-safe hooks by passing `typeof zbarSchema` to
`createReactZbar`:

```tsx
// lib/zbar.ts
import { createReactZbar } from "convzibar/react";
import type { zbarSchema } from "../convex/zbar";

export const { ZbarProvider, useCan, usePermissions } =
  createReactZbar<typeof zbarSchema>();
```

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
  const canEdit = useCan(
    "edit",
    { type: "project", id: projectId },
    { timezone: "EST" },
  );

  if (!canEdit) return <div>Access Denied</div>;
  return <button>Edit Project</button>;
}
```

### 9. Cleaning Up

When an entity is deleted from your application, remove it from the
authorization graph to prevent stale access and clean up the traversal cache.

```typescript
export const deleteProject = mutation({
  handler: async (ctx, args) => {
    // Scours the graph for any incoming or outgoing relationships involving this project,
    // deletes them, and safely cascade-deletes all derived paths in the cache via
    // token-lineage tracking — no full graph re-computation.
    await zbar.deleteEntity(ctx, { type: "project", id: projId });
  },
});
```

## Architecture

### Storage

- **`relationships` table:** Ground-truth base edges. Stores every
  explicitly-written edge plus auto-inserted reverse edges. Indexed by
  `(tenantId, objectType, objectId)` and by
  `(tenantId, subjectType, subjectId, relation, objectType, objectId)` for
  point lookups and range scans in both directions.
- **`effectiveRelationships` table:** Materialized cache of cross-object
  derivations produced by the write-time BFS. Each row stores one or more
  `paths`, where each path carries the `baseIds` (lineage tokens) of the
  edges that produced it and any conditions gated along the way. Removing a
  base edge surgically deletes only the paths containing that ID — an O(N)
  cascade instead of a full recomputation.
- **Local inheritance is never stored.** The fact that `admin` implies
  `viewer` is inferred at read time via `resolveRelationInheritance()` over
  the schema — a pure CPU operation, no extra DB writes.
- **Read-time paths are never stored.** Declaring
  `.readTimeRelation('editor', 'parent_org.admin')` produces zero
  traversal rules; the planner synthesizes the join at query time.

### Planning Algebra

Every read — `can`, `hasRelationship`, `.list()`, `.via()`, `getPermissions` —
flows through [`planRelation`](src/client/zbar/traversal.ts) which compiles
the schema into a `Traversal` tree built from these operators:

- **`Materialised`** — one indexed query over `effectiveRelationships`
  (cost 1). The structural-connectivity leaf.
- **`ValidatedMaterialised`** — same as `Materialised`, plus per-target
  condition validation. Used whenever a permission is in play.
- **`EdgeExpand`** — the primitive enumeration of entities reachable via one
  typed relation. The source side of `Compose`.
- **`Compose(sourceSide, subjectSide)`** — two-hop join through an
  intermediate (`subject --subjectSide--> M --sourceSide--> object`). Used
  to express dot-paths and chained read-time paths.
- **`Union.of(...children)`** — disjunction with algebraic identities
  (flattens nested unions, drops `EMPTY`, collapses single-child unions)
  and cost-ordered children so the cheapest branch probes first.

Execution strategies:

- **`check`** is a hybrid sequential-parallel probe: the cheapest child
  fires first; only on a miss do remaining children race with first-true
  early exit. Happy path fires exactly one query.
- **`checkBatch` / `checkBatchSubjects`** narrow sequentially: each child
  only sees the candidates the previous children didn't cover.
- **`expandObjectsFromMany` / `expandSubjectsFromMany`** collapse
  multi-subject fan-outs into **one** Convex round-trip per hop via the
  component's batch queries — so `Compose` chains run in O(depth) queries
  regardless of branching factor.

The planner never distinguishes "materialised" from "read-time" at runtime;
both are just encodings of the same schema declaration compiled into the
same operator language.

### Write-Time Expansion

`addRelation` inserts the base edge, auto-inserts any declared reverse edge,
and enqueues a BFS that walks `graphConfig.traversalRules`. Each rule
derived from a `.relation()` dot-path or userset either:

1. Finds the edge being added to be a **source** of the rule and materializes
   downstream effective relationships, or
2. Finds it to be a **target** and walks backward to materialize any
   predecessor paths that now complete.

Path expansion is cycle-safe (`baseIds` intersection) and depth-capped
(`maxWriteDepth`, default 10). Large expansions are chunked through
`@convex-dev/workpool` when `asyncWrites` is enabled (default).

`updateRelation` and `setRelation` use Add-Before-Remove via an
`onComplete` chain: the new edge is inserted and fully expanded first, then
the old edge(s) are removed. Users never experience a transient loss of
access.

### Read-Time Depth Cap

The `readTimeChainDepth` option caps recursion in `rtBranches`. When depth
+ 1 reaches the cap, the inner hop collapses to a bare `Materialised`
(no further chaining). The default (3) is generous for typical schemas
while small enough to stop accidental runaways. Cycles in the read-time
graph are detected at schema load — not at runtime — via a 3-color DFS in
`detectReadTimePathCycle`.

### Multi-Permission Evaluator

`getPermissions()` delegates to `evaluateManyPermissions`, which is the
theoretical minimum-work shape for "every permission on (subject, object)":

1. **One** materialized batch query covering the union of every target
   relation across every permission.
2. Per-permission CPU-side validation against the pre-fetched rows.
3. Shared read-time fallback: each unique `(derivedRelation, sourceType)`
   branch runs **at most once**; a single RT hit grants every still-pending
   permission whose targets include that derived relation.

### Escape Hatch: `convzibar/unsafe`

For migrations, backfills, and raw inspection, the `unsafe` entry point
exposes cursor-based `scanRelationships`, bulk `transformRelationships`,
`insertRelationship` / `patchRelationship` / `deleteRelationship` (no
effective-graph side effects), and `rebuildEffectiveRelationships` /
`clearEffectiveRelationships`. Use these when you need to reshape the graph
outside the normal API — e.g. renaming a relation across millions of
rows — then rebuild the cache.

```typescript
import { transformRelationships, rebuildEffectiveRelationships }
  from "convzibar/unsafe";

// Rename a relation
await transformRelationships(ctx, { relation: "viewer" }, (r) => ({
  patch: { relation: "reader" },
}));

// Rebuild the effective-relationship cache
await rebuildEffectiveRelationships(ctx);
```
