# Getting Started with ZeroPress Edge

This guide connects an Edge Worker to Studio and enables public APIs for a
separately hosted static site. Resource creation and deployment are operator
steps; Studio provides database installation and maintenance.

## 1. Prepare the source and prerequisites

You need:

- A Cloudflare account with Workers, D1, KV, and Queues for the selected features.
- A [Studio](https://github.com/zeropress-app/zeropress-studio) release compatible
  with Edge schema version `1` and mail contract version `1`. Package Semver
  numbers do not need to match; check the [schema contract](../database/schema-contract.json).
- The public site's Origin, for example `https://blog.example`.
- Node.js 22.22.0 or newer and npm for local development or CLI deployment.

## 2. Prepare and connect the Cloudflare resources

Select or create these resources during deployment in step 3, in the same
Cloudflare account as Studio:

| Resource | Edge Worker | Studio Worker |
| --- | --- | --- |
| Edge D1 database | `EDGE_DB` | `EDGE_DB`, pointing to the same database |
| Edge KV namespace | `EDGE_KV` | `EDGE_KV`, pointing to the same namespace |
| Mail queue | Producer `MAIL_QUEUE` | Producer `MAIL_QUEUE` and a consumer for the same queue |
| Studio database and KV | Not used | Separate `DB` and `KV` bindings |

Edge and Studio must use the same actual Edge D1 database, KV namespace, and
mail queue. When deploying the second Worker, select the first Worker's shared
resources; automatically generated KV names differ between Workers. Keep Edge's
database and KV separate from Studio's `DB` and `KV`.
Although KV is optional for the Edge runtime, fresh Studio installation requires
`EDGE_KV` to initialize an empty Edge database.

Studio consumes mail jobs. A comments-only installation may omit the mail queue;
Newsletter signup and Form notifications require the matching Studio consumer
and mail configuration.

## 3. Deploy and configure the Worker

Open [Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/zeropress-app/zeropress-edge),
choose the destination repository and Worker name, and select the resources from
step 2. Keep the detected build command `npm run build` and deploy command
`npm run deploy`, then select **Deploy**. Cloudflare saves the selected resource
names and IDs in the new repository's `wrangler.jsonc`.

For CLI deployment instead, obtain the source from the
[Edge repository](https://github.com/zeropress-app/zeropress-edge), configure the
Worker name in [`wrangler.jsonc`](../wrangler.jsonc), and authenticate Wrangler to
the intended Cloudflare account. Wrangler can provision resources when IDs are
omitted. If Studio already has the shared resources, set their IDs and Queue
name before deploying; see [Wrangler configuration](configuration.md#wrangler-configuration).
Then run:

```sh
npm ci
npm run build
npm run deploy
```

Deploying the Worker does not initialize D1. Follow
[Worker variables and secrets](configuration.md#worker-variables-and-secrets)
to configure the Text and Secret entries needed by your installation.

## 4. Initialize or connect Studio

### Installing Studio for the first time

Follow the [Studio installation instructions](https://github.com/zeropress-app/zeropress-studio)
with the shared `EDGE_DB` and `EDGE_KV` bindings from step 2. Its initial installer
handles Edge according to the existing database:

| Edge database | Result |
| --- | --- |
| Empty application catalog, with `EDGE_KV` available | Install the Edge schema and seed data; enable Edge integration |
| Non-empty application catalog, including an already managed database | Preserve it; install Studio with Edge integration disabled |
| Missing/unavailable database, failed inspection, or missing KV for an empty database | Report an installation error |

After completing Studio installation, sign in and check **Edge Services**.
A fresh Edge installation is already enabled. An unavailable database is not
treated as empty, and a non-empty database is not automatically adopted or upgraded.

### Connecting an existing Studio or a preserved non-empty Edge database

Use Studio's
[Maintenance & Recovery instructions](https://github.com/zeropress-app/zeropress-studio/blob/main/docs/maintenance-and-recovery.md#edge-database-lifecycle-and-target-reconciliation).
Inspect the existing state before installing, adopting, or upgrading. A current
`ready` database needs no reinstall. Complete any target reconciliation before
enabling **Edge Services**; reconciliation does not enable integration itself.

The [database artifact guide](../database/README.md) defines lifecycle
preconditions, including Studio maintenance for post-install installation or
adoption. Use those supported operations rather than applying SQL directly or
emptying an existing database to trigger fresh installation.

## 5. Configure the public features

In Studio, set the canonical public-site URL and confirm that **Edge Services**
is ready. Configure the selected features:

| Feature | Setup |
| --- | --- |
| Comments | Save the API base as `https://edge.example/api`, keep the site comment policy enabled, and choose moderation/threading settings. Saving initializes a missing request-signing keyset. Publish a Post/Page with comments allowed and wait for Edge target synchronization. |
| Newsletter | Activate the seeded `default` newsletter in Studio and configure the mail provider, confirmation delivery, and Queue consumer. |
| Forms | Create an active Form with the frontend's fields. The seed creates no contact form. For notifications, choose a recipient and complete mail/queue setup. |

The Comments API base includes `/api`. Check request-security status in Comments
settings, generate fresh Preview Data, and rebuild the static site with a theme
or frontend implementing the selected APIs. Themes obtain per-target comment
request tokens from Preview Data; these are distinct from Worker Secrets.

Choose write verification and IP retention through **Edge Security**.

## 6. Verify the installation

Once the database is current `ready`, target synchronization is complete, and
feature settings are saved, verify the selected features from the public site's
browser:

- Comments: load a published target, submit a comment, approve it if required,
  then reload and confirm it is visible.
- Newsletter: subscribe, receive and follow the confirmation email, and verify
  the subscription in Studio. A successful signup response alone does not prove
  mail delivery.
- Forms: submit a configured form and check the stored submission in Studio;
  also verify the email if notifications are enabled.

For a metadata and browser-Origin check with Newsletter enabled:

```sh
curl --include 'https://edge.example/api/newsletters/default' \
  -H 'Origin: https://blog.example'
```

Expect `200` and an `Access-Control-Allow-Origin` matching the supplied Origin.
`GET /` returns an empty `404` and is not a health check.

Use the [Comments](api/comments.md), [Newsletter](api/newsletters.md), and
[Forms](api/forms.md) references for requests, responses, and verification.

## If a setup check fails

| Result | What to check |
| --- | --- |
| `503 EDGE_MAINTENANCE` | The deployed maintenance gate is `true` |
| `503 EDGE_CONFIGURATION_ERROR` | Exact `true`/`false` gate values |
| `503 EDGE_DATABASE_NOT_AVAILABLE` | Shared database identity, compatible schema, and lifecycle state in Studio |
| Empty `404` on a feature route | Worker address, route, and feature gate |
| `403 CORS_ORIGIN_DENIED` or browser CORS failure | Public-site Origins in [Worker variables and secrets](configuration.md#worker-variables-and-secrets) |
| Comments unavailable or an invalid request token | API base, comment policy, target synchronization, request-security state, and fresh Preview Data |
| Challenge or IP-hash configuration error | The Edge Worker [Secret requirements](configuration.md#worker-variables-and-secrets) |
| `NEWSLETTER_EMAIL_NOT_AVAILABLE` or a missing notification | Studio mail settings, shared queue, consumer, and delivery status |
| `503 RATE_LIMIT_NOT_AVAILABLE` | The configured limiter's availability; quota rejection is `429 RATE_LIMITED` |

For later schema operations, use the [database lifecycle guide](../database/README.md).
