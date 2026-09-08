# ZeroPress Edge Agent Guide

## Scope and Sources of Truth

- This repository contains the public ZeroPress Edge source and must build and
  test independently. Do not depend on a parent workspace, a sibling checkout,
  or another project's source files.
- Treat `README.md`, `docs/`, `database/README.md`, and `SECURITY.md` as the
  authoritative product, API, database, and security documentation. Read the
  relevant documents before changing those contracts, and update their tests
  and documentation together with the implementation.

## Change Boundaries

- Do not change the package version unless explicitly requested.
- Do not deploy Workers, mutate Cloudflare resources, or execute SQL against a
  local or remote D1 database. Prepare code and artifacts for human review.
- This project does not use Wrangler D1 migrations. Do not add a top-level
  `migrations/` directory, configure `migrations_dir`, or prescribe
  `wrangler d1 migrations` as an operational path.
- Edge owns the canonical SQL artifacts under `database/`; Studio provides the
  supported database lifecycle. Follow `database/README.md` and keep the schema
  contract, artifact checksums, and tests consistent when those files change.

## Verification

Run the checks appropriate to the change and, before handing off a completed
code change, run the full project checks when the environment permits:

```sh
npm test
npm run typecheck
npm run build
```

`npm run build` is a Wrangler dry run. Do not substitute `npm run deploy`.
