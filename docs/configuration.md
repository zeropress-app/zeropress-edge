# Edge configuration

For a first installation, follow [Getting Started](getting-started.md). This
reference covers configuration choices and their runtime effects.

## Wrangler configuration

[`wrangler.jsonc`](../wrangler.jsonc) defines the Worker entry point,
compatibility date, resource bindings, quota policy, and retention schedule.
Both npm commands and Wrangler read this file directly.

Deploy to Cloudflare writes the selected Worker and resource names/IDs into this
file in the installation repository. For CLI deployment, set these values in the
same file before deploying. Edit or remove resource bindings there.

| Command | Behavior |
| --- | --- |
| `npm run build` | Build with Wrangler's deployment dry run |
| `npm run deploy` | Deploy, preserving Dashboard variables |
| `npm run dev` | Run locally, honoring each binding's `remote` setting |

Edge and Studio must bind `EDGE_DB` to the same D1 database in the same Cloudflare
account; matching binding names alone is insufficient. Retain the `database_id`
and other resource identities written by Cloudflare.

The supplied D1, KV, and Queue bindings use `remote: false` for local development.
Setting a binding to `remote: true` lets development read or change that real
resource. These flags do not change the resources used by a deployed Worker.

## Worker bindings

| Binding | Purpose |
| --- | --- |
| `EDGE_DB` | Required D1 database for public runtime data |
| `EDGE_KV` | Optional runtime cache and PoW replay guard; required for a fresh Studio/Edge installation |
| `MAIL_QUEUE` | Newsletter confirmation and optional Form notification delivery through Studio |
| `COMMENT_READ_RATE_LIMITER` | Comment reads and authentication discovery |
| `COMMENT_WRITE_RATE_LIMITER` | Comment writes by IP and authenticated identity |
| `COMMENT_CHALLENGE_RATE_LIMITER` | Comment verification discovery |
| `NEWSLETTER_READ_RATE_LIMITER` | Newsletter metadata, confirmation, and unsubscribe |
| `NEWSLETTER_SUBSCRIBE_RATE_LIMITER` | Newsletter signup |
| `NEWSLETTER_CHALLENGE_RATE_LIMITER` | Newsletter verification discovery |
| `FORM_READ_RATE_LIMITER` | Form metadata |
| `FORM_SUBMIT_RATE_LIMITER` | Form submissions |
| `FORM_CHALLENGE_RATE_LIMITER` | Form verification discovery |
| `TURNSTILE_VERIFY_RATE_LIMITER` | Optional shared limiter before Siteverify; absent from the supplied configuration |

All rate-limit bindings are optional. Omitting one removes its corresponding
Worker quota. A configured but failing limiter returns an availability error.
See [API rate limits](api/common.md#rate-limits) for counter behavior.

Configure quotas and namespace IDs in `wrangler.jsonc`. Use distinct IDs where
quotas must be independent of other installations in the account.

## Worker variables and secrets

In the Cloudflare Dashboard, open the **Edge Worker → Settings → Variables and
secrets**. Add entries with the **Text** or **Secret** type shown below.
`Default` is the runtime value used when an entry is absent; `none` means there
is no fallback.

| Type | Name | Default | Description |
| --- | --- | --- | --- |
| Text | `ALLOWED_ORIGINS` | empty | Comma-separated exact HTTP(S) Origins of public sites, such as `https://blog.example`; no paths, queries, or fragments |
| Text | `COMMENTS_ENABLED` | `false` | Enables Comments routes |
| Text | `NEWSLETTER_ENABLED` | `false` | Enables Newsletter routes; unsubscribe remains available while disabled |
| Text | `FORMS_ENABLED` | `false` | Enables Forms routes |
| Text | `EDGE_MAINTENANCE_MODE` | `false` | Pauses recognized public routes and scheduled IP retention |
| Secret | `EDGE_TOKEN_SIGNING_SECRET` | none | At least 64 characters after trimming; signs comment read challenges, PoW write challenges, and newsletter confirmation tokens |
| Secret | `IP_HASH_SECRET` | none | A separate value of at least 64 trimmed characters; derives IP hashes and authenticated-comment limiter identities |
| Secret | `TURNSTILE_SECRET_KEY` | none | Required when any feature uses Turnstile; paired with the public site key in [runtime settings](#runtime-settings) |

Feature and maintenance gates accept only the strings `true` and `false`.
Any other configured value returns `503 EDGE_CONFIGURATION_ERROR`. Maintenance
preserves feature selections; Studio does not change these Worker variables.
See [HTTP behavior](api/common.md#http-behavior) for responses and preflight.

Generate separate values for `EDGE_TOKEN_SIGNING_SECRET` and `IP_HASH_SECRET`
by running this command once for each:

```sh
openssl rand -hex 32
```

Save each output as its Secret entry above and keep a copy in your secret
manager. Studio's own secrets and comment request-token keys are separate.

Subsequent `npm run deploy` executions preserve Dashboard values.
`wrangler.jsonc` uses `keep_vars: true` and contains no `vars` object. Keep defaults
in runtime code; Wrangler `vars` and deployment `--var` arguments write remote
values.

For local development, `npm run dev` creates `.dev.vars` only when `.dev.vars`,
`.env`, and `.env.local` are all absent. It allows `http://localhost:3000`, enables
Comments, leaves the other gates `false`, and generates independent 64-character
hex values for `EDGE_TOKEN_SIGNING_SECRET` and `IP_HASH_SECRET`. Existing files
are preserved without filling missing values. Edit the local file to customize
it or add `TURNSTILE_SECRET_KEY`. These files remain excluded from Git; build and
deployment do not generate them.

## Runtime settings

Manage these values through Studio's **Edge Security**. They are stored in the
`EDGE_DB.edge_runtime_settings` singleton (`id = 1`):

| Column | Seed | Allowed values |
| --- | --- | --- |
| `comment_write_verification_mode` | `pow` | `pow` or `turnstile`; comment reads are unaffected |
| `newsletter_subscribe_verification_mode` | `pow` | `pow` or `turnstile`; confirmation is unaffected |
| `form_submit_verification_mode` | `pow` | `pow` or `turnstile` |
| `turnstile_sitekey` | `NULL` | Trimmed, non-empty public site key, at most 256 characters; required for Turnstile |
| `ip_address_retention_days` | `30` | Integer from `1` through `365` |

Missing, unreadable, or invalid settings fail affected requests with
`EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE`; there is no environment or code fallback.
For Turnstile, allow the frontend hostnames in the widget and configure the
matching Worker secret. See [write verification](api/common.md#public-write-verification).

Comment policy and visitor authentication have their own
[settings](api/comments.md#runtime-defaults).

## IP address retention

Write APIs store the original IP, a secret-derived `ip_hash`, and Cloudflare
network metadata. The scheduled job clears `ip_address` from comments,
newsletter subscriptions, and form submissions after the configured retention
period. The hash, ASN, organization, and country remain.

Retention uses `ip_address_recorded_at`, which must exist whenever an original
IP is stored. Maintenance pauses the scheduled job.

## Mail queue contract

Edge stores public operations and enqueues mail jobs; Studio composes and sends
the messages. Both must support the same `contract_version: 1` envelope.

| Message type | Trigger | Delivery behavior |
| --- | --- | --- |
| `newsletter.confirmation` | An admitted double-opt-in signup | [Confirmation email delivery](api/newsletters.md#confirmation-email-delivery) |
| `form.notification` | A stored submission with a configured recipient | [Notification delivery](api/forms.md#notification-delivery) |

Before an incompatible producer/consumer rollout, migrate or drain pending jobs
with a compatible consumer and keep Edge in maintenance until both sides are
compatible. Studio defers queue batches while the Edge database is not current
`ready`. Queue resource names are independent of the message contract version.

## CI and Workers Builds

CI runs `npm run build` against `wrangler.jsonc` as a dry run.

For Cloudflare Workers Builds, keep the detected build command `npm run build`
and deploy command `npm run deploy`. See Cloudflare's
[Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).
