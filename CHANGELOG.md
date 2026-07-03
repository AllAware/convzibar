# Changelog

## 2.0.0

Simplification release: the engine is now ReBAC-only, single-tenant, and
~30% smaller. No behavior changes to retained functionality.

### Breaking

- **ABAC conditions removed.** `.condition()`, `{ relation, condition }`
  targets, the `condition`/`conditionContext` write options, and the
  `requestContext` parameter on every read (`can`, `hasRelationship`,
  `getPermissions`, `require`, `.collect()`) are gone. `createZbarSchema()`
  and `createZbar()` lose their `Data`/context generics.
- **Multi-tenancy removed.** The required `tenantId` client option and
  `.withTenant()` are gone; tables are no longer tenant-indexed.
- **Audit log removed.** `enableAuditLog`, `defaultActorId`, and the
  `createdBy`/`actorId` write options are gone.
- **Component query surface consolidated.** The seven per-shape queries
  (`checkPermissionFast`, `checkPermissionBatch*`, `list*Fast`, `list*Batch`)
  collapse into `effectiveForward` / `effectiveReverse` with identical
  dispatch semantics.

### Changed

- Mutations ship a stable content hash of the compiled graph config instead
  of the full rule set; the component stores configs in a new `configs`
  table (registered automatically on first write, self-healing if the
  registration is lost).
- `getPermissions()` runs at most one shared read-time branch per unique
  derived relation (previously one per pending permission).

### Upgrade notes

- The v2 component schema still declares the legacy v1 fields (`tenantId`,
  `condition`, `conditionContext`, per-path `conditions`) as optional and
  keeps the `auditLog` table, so an in-place `convex deploy` over v1 data
  passes schema validation. The engine never reads or writes them; the
  transitional declarations can be deleted after data cleanup.

## 0.0.0

- Initial release.
