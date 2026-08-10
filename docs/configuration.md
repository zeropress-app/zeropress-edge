# Edge configuration

For a first installation, follow [Getting Started](getting-started.md). This
reference covers configuration choices and their runtime effects.

## Wrangler configuration

[`wrangler.base.jsonc`](../wrangler.base.jsonc) defines the Worker entry point,
compatibility date, binding names, quota policy, and retention schedule.
`wrangler.override.jsonc` supplies installation-specific Worker and resource
names, namespace IDs, and development binding choices.

Commands that consume configuration create a missing default override from
[`wrangler.override.example.jsonc`](../wrangler.override.example.jsonc), then
validate it. Replace every placeholder and rerun the command. Incomplete values
stop configuration generation and Wrangler execution; existing files are never
overwritten. Track the reviewed override in the private deployment repository.

`npm run config:init` can create the default file in advance. It requires an
absent default file and an unset `ZEROPRESS_EDGE_WRANGLER_OVERRIDE`.

Set `ZEROPRESS_EDGE_WRANGLER_OVERRIDE` to select another reviewed file. Relative
paths resolve from the command's working directory. An explicitly selected file
must exist, including when it names the default path; a missing file reports its
path and stops without creating a replacement.

The following commands compose and validate a fresh generated file:

| Command | Behavior |
| --- | --- |
| `npm run config:compose` | Generate deployment configuration without deploying |
| `npm run build` | Build with Wrangler's deployment dry run |
| `npm run deploy` | Deploy, preserving Dashboard variables |
| `npm run dev` | Use installation identities and force supported bindings local |
| `npm run dev:enable-remote` | Honor explicit `remote: true` choices; require at least one remote binding |

Configure `EDGE_DB.database_name` explicitly. Edge and Studio must use the same
database name in the same Cloudflare account; matching binding names alone is
insufficient. The composer does not require a second D1 identifier.

For each configured D1, KV, or Queue binding, supply an exact `remote: true` or
`remote: false`. Build and deployment output omit these development-only fields.
Remote development can read or change real resources.

Optional KV, Queue, and rate-limit bindings must be explicitly configured or
removed. An empty collection removes all bindings in that collection.

Binding arrays merge by `binding`, or by `name` for rate limiters. Duplicate keys,
incomplete choices, changes to base-owned build fields or quota policy, and
Wrangler migration-directory configuration are rejected. Review generated files
through their source inputs rather than editing the outputs.

Resource binding changes belong in the override. Bare `wrangler dev` and
`wrangler deploy` are blocked; use the npm commands above.

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

The base configuration supplies quotas; each installation supplies namespace
IDs. Use distinct IDs where quotas must be independent of other installations
in the account. Quota changes belong in the base configuration.

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

Subsequent `npm run deploy` executions preserve Dashboard values. Generated
configuration uses `keep_vars: true` and contains no `vars` object. Keep defaults
in runtime code; Wrangler `vars` and deployment `--var` arguments write remote
values. For local development, use `.dev.vars` or `.env`.

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

Public package CI can select the synthetic
[`scripts/fixtures/wrangler.override.ci.jsonc`](../scripts/fixtures/wrangler.override.ci.jsonc)
through `ZEROPRESS_EDGE_WRANGLER_OVERRIDE` for build verification. This fixture
is not a deployment configuration.

For Cloudflare Workers Builds, leave the optional build command empty and set
the deploy command to `npm run deploy`. Connect a private branch containing the
reviewed installation override. See Cloudflare's
[Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).
