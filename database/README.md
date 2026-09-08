# Edge Database SQL Artifacts

Edge owns the canonical [schema contract](schema-contract.json), including
supported schema versions and SHA-256 artifact checksums. Studio vendors reviewed,
byte-identical copies and provides installation, adoption, upgrade, and removal.
Use Studio's installer or Maintenance & Recovery after operator review; do not
apply these artifacts directly to local/remote D1 or use Wrangler D1 migrations.

## Artifacts

- `install/001_edge_baseline.sql`: non-destructive fresh-install schema.
- `install/002_edge_seed.sql`: default seed data, followed by the schema-1 `ready` row.
- `operations/001_uninstall.sql`: remove managed tables, children before parents,
  with the lifecycle table last.
- [schema-upgrades/](schema-upgrades/README.md): immutable, consecutive
  `schema_N_to_N+1.sql` upgrades registered in the contract.

## Lifecycle state

The singleton `zeropress_edge_schema_state(id=1)` records `schema_version`,
`lifecycle_state`, `target_schema_version`, `active_operation_id`, and
`updated_at_iso`. A healthy schema-1 database is `ready`, with no target version
or active operation. Public routes fail closed when that invariant is not met.

Fresh installation requires an empty application catalog. Each install artifact
runs in one atomic D1 batch; each upgrade artifact and its lifecycle version
update also share one batch. See [Getting Started](../docs/getting-started.md#4-initialize-or-connect-studio)
for initial Studio installation outcomes.

## Adoption and upgrades

Unversioned databases are adopted only when the complete application
table/index/trigger catalog and default seeds exactly match schema 1. Adoption
adds only the lifecycle table and ready row, preserving business data. Partial,
unexpected, or malformed catalogs require recovery.

Exact default values are required only at adoption. Managed databases retain
canonical row identities and constraints while allowing operator changes to
comment, mail, runtime, and Newsletter settings.

After Studio setup, installation or adoption requires Studio maintenance.
Supported upgrades may run while Studio is operational under the lifecycle UI's
preconditions. These operations do not change Worker feature/maintenance gates
or enable Studio integration automatically.

## Uninstall

Uninstall requires separate authorization and an exact lifecycle-managed `ready`
catalog. Disable Studio Edge integration, pause public writes with
`EDGE_MAINTENANCE_MODE=true`, retain a reviewed SQL backup, and review pending
mail/queue work before proceeding in Maintenance & Recovery.

The preview counts managed tables. Execution revalidates and applies the removal
artifact in one atomic batch. It removes Edge SQL schema and data only; Cloudflare
resources, KV/R2 contents, queue messages/consumers, Worker configuration, and
Studio's database remain.
