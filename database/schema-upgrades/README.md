# Edge schema upgrade artifacts

This directory is the immutable forward-only Edge database upgrade catalog.
It is not a Wrangler D1 migrations directory. Schema 1 is the first public
release target, so this directory intentionally contains no SQL artifacts yet.

Each future artifact advances exactly one version (`schema_N_to_N+1.sql`) and
is applied only by the reviewed Studio Edge database lifecycle runner. Every
artifact must be registered with its SHA-256 in `../schema-contract.json` and
copied byte-identically into Studio's vendored Edge database contract.
The same contract records the normalized catalog SHA-256 for every supported
source schema so the lifecycle runner can recognize an exact older managed
database before it starts the corresponding upgrade chain.

The first future schema change must add `schema_1_to_2.sql`; released artifacts
are immutable and must not be folded back into the schema-1 baseline.

Do not apply these files directly to local or remote D1 databases.
