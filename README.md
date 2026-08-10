# ZeroPress Edge

ZeroPress Edge is the public API layer for ZeroPress static sites.

It is designed to run as a Cloudflare Worker next to static ZeroPress output.
The long-term scope is comments, newsletter-facing APIs, and public forms.

Only recognized module paths return structured JSON errors. Unknown paths
outside `/api/posts/*`, `/api/pages/*`, `/api/newsletters/*`, and `/api/forms/*` return an empty
`404` response. If a feature flag disables a module, that module's paths also
return empty `404` responses before touching D1, KV, or rate limit bindings.

## Database SQL Artifacts

Edge owns its schema contract in `database/schema-contract.json`, the
non-destructive fresh-install artifacts in `database/install/`, and future
immutable N→N+1 artifacts in `database/schema-upgrades/`. This is not a
Wrangler D1 migrations directory, and ZeroPress does not use
`wrangler d1 migrations` for this project. Studio v3 vendors reviewed,
checksum-pinned copies and is the supported install/adopt/forward-upgrade UI;
neither repository applies SQL automatically during development or deploy.

Every active public feature validates the
`zeropress_edge_schema_state(id=1)` lifecycle row through its existing first
D1 lookup. Schema v1 must be `ready` with no active operation. Missing,
malformed, older, newer, installing, or upgrading state fails closed with
`503 EDGE_DATABASE_NOT_AVAILABLE` and operator guidance. Hard-disabled feature
paths and unknown routes are resolved before D1 and remain zero-query paths.

JSON success responses use a common envelope:

```json
{
  "success": true,
  "data": {}
}
```

JSON error responses use the matching error envelope:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Input validation failed.",
    "errors": []
  }
}
```

Public JSON `POST` bodies use code-defined hard byte limits. These limits are
not exposed as Worker environment variables or bindings.

## Public Write Verification

Comment creation, newsletter subscription, and form submission each select one
write-verification mode independently:

| Write | `edge_runtime_settings` column | Turnstile action |
| --- | --- | --- |
| Comment creation | `comment_write_verification_mode` | `comment_create` |
| Newsletter subscription | `newsletter_subscribe_verification_mode` | `newsletter_subscribe` |
| Form submission | `form_submit_verification_mode` | `form_submit` |

The only modes are `pow` and `turnstile`. The seeded D1 row defaults each mode
to `pow`; there is no combined mode, automatic downgrade, environment fallback,
or KV settings cache. A missing, unreadable, or malformed singleton row fails
affected requests closed with `503 EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE`.

The existing `challenge` URL for each write is also its runtime discovery URL.
A `pow` response contains the feature's existing challenge under `item.pow`. A
`turnstile` response contains only the public site key and the expected action
under `item.turnstile`. Clients must follow the mode advertised by the Worker
and send only that mode's verification fields. Supplying fields from the other
mode is a `422 VALIDATION_ERROR` rather than an alternate verification path.

Turnstile mode requires both `edge_runtime_settings.turnstile_sitekey` and the
`TURNSTILE_SECRET_KEY` Worker secret. The D1 value is a trimmed, non-empty public
site key of at most 256 characters. Database and runtime validation require it
whenever any write mode is `turnstile`. A missing Worker secret fails discovery
and writes closed with `503 TURNSTILE_NOT_AVAILABLE`; Edge never falls back to
PoW.
The browser sends the resulting token as `turnstile_token`. Edge verifies it
with Cloudflare Siteverify and requires both the endpoint-specific `action` and
the response `hostname` to match the request `Origin` hostname. The secret is
never returned to clients.

Every public write first applies its bounded-body and mode-independent common
validation. Its existing feature write limiter then runs before the D1 runtime
settings read, mode-specific envelope validation, and PoW or Turnstile
verification. Consequently, invalid mode-specific verification attempts consume
the feature quota, while malformed JSON and invalid common fields do not. In
Turnstile mode, the optional `TURNSTILE_VERIFY_RATE_LIMITER` runs after the
feature limiter and immediately before the outbound Siteverify call.

The Turnstile widget must allow each frontend hostname that uses the site key.
The dogfooding clients load Cloudflare's official script only after a submit-time
discovery selects `turnstile`; `pow` mode never loads that external resource.
They use interaction-only rendering with visitor feedback disabled. Edge also
omits the optional `remoteip` and `cdata` fields from Siteverify requests.
Turnstile nevertheless remains an external service and is an explicit operator
opt-in rather than an automatic fallback.

Turnstile verification errors shared by all three write APIs are:

| Code | Status | Cause |
| --- | --- | --- |
| `EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE` | `503` | The typed D1 runtime-settings singleton is missing, unreadable, or malformed. |
| `TURNSTILE_NOT_AVAILABLE` | `503` | The Turnstile site key or secret is missing or blank. |
| `INVALID_TURNSTILE_TOKEN` | `403` | The token is missing, malformed, rejected, already used, expired, or does not match the expected action/hostname. |
| `INVALID_TURNSTILE_ORIGIN` | `403` | The request does not contain one exact HTTP(S) `Origin` value that can be checked against Siteverify. |
| `TURNSTILE_VERIFY_RATE_LIMITED` | `429` | The optional pre-verification limiter rejected the Siteverify attempt. |
| `TURNSTILE_VERIFY_RATE_LIMIT_NOT_AVAILABLE` | `503` | The optional pre-verification limiter failed. |
| `TURNSTILE_VERIFICATION_NOT_AVAILABLE` | `503` | Siteverify or its configuration is temporarily unavailable. |

Turnstile-related `503` responses emit one structured `console.warn` with the
public error code, action, a fixed failure classification, safe upstream HTTP
status or allowlisted Siteverify error codes where available, and operator
guidance. Logs never include the Turnstile secret or token, site key value,
request body, idempotency key, client IP, Origin, hostname, raw upstream body,
or raw exception message. A transient first attempt that succeeds on retry does
not emit a warning, and client failures (`403`) or normal rate limiting (`429`)
are not logged as service incidents.

Newsletter email confirmation is not a public write-verification target. It
continues to use its signed, hash-bound, single-use confirmation token only.
Comment reads also continue to use the existing request token plus read PoW,
regardless of `comment_write_verification_mode`.

## Comments API

The comments endpoints are:

```txt
/api/comments/status
/api/comments/auth
/api/posts/:target_id/comments
/api/posts/:target_id/comments/challenge/:scope
/api/pages/:target_id/comments
/api/pages/:target_id/comments/challenge/:scope
```

### Public Comments Handshake

Studio and other management clients can test the configured Edge base URL with:

```txt
GET /api/comments/status?site_origin=https%3A%2F%2Fblog.example
```

The endpoint performs no D1, KV, or rate-limit operation and remains reachable
when the deployment-level `COMMENTS_ENABLED` gate is false. It exposes only the
public service contract and gate/origin compatibility:

```json
{
  "success": true,
  "data": {
    "service": "zeropress-edge",
    "feature": "comments",
    "protocol_version": 1,
    "public_api_enabled": true,
    "site_origin_allowed": true
  }
}
```

`site_origin` is optional. When omitted, `site_origin_allowed` is `null`. When
provided, it must be one absolute HTTP(S) origin with no credentials, path,
query, or fragment. The result uses the same exact-origin policy as normal
comment requests: the site origin must equal the Edge API origin or appear in
`ALLOWED_ORIGINS`. The Origin of the Studio request itself is not used as the
site being tested.

`public_api_enabled` reports only the deployment-level `COMMENTS_ENABLED` hard
gate. This handshake verifies endpoint identity, protocol compatibility, and
origin policy; it is not a D1, target, token, challenge, or write-health check.

The handshake and its validation/error responses always use
`Access-Control-Allow-Origin: *`, omit credentials, and use
`Cache-Control: no-store`, so Studio can call an unverified Edge deployment
directly from the browser. `GET` returns `200` even when either public boolean
is false. `OPTIONS` returns `204`; other methods return `405` with
`Allow: GET, OPTIONS`.

### Optional Comment Authentication Discovery

When an operator enables the Supabase identity adapter, a theme can discover
the public browser configuration from the same Edge origin:

```txt
GET /api/comments/auth
```

```json
{
  "success": true,
  "data": {
    "enabled": true,
    "provider": "supabase",
    "mode": "optional",
    "project_url": "https://example.supabase.co",
    "publishable_key": "sb_publishable_public-client-key"
  }
}
```

Disabled authentication returns only `{ "enabled": false }`, even when the
operator retained a complete project/key pair for later use. The endpoint uses
the normal exact-origin CORS policy, performs one D1 settings read, never
returns a secret or service-role key, and is hidden behind the deployment-level
`COMMENTS_ENABLED` gate. Invalid or unreadable settings fail with `503` rather
than publishing a partial configuration.

The project URL must be one absolute HTTPS origin. HTTP is accepted only for
`localhost`, `127.0.0.1`, and `[::1]` development origins. The publishable key
must use Supabase's `sb_publishable_` public-client format. The normalized
project origin, publishable key, enabled state, and fixed `optional` mode are
stored in `edge_comment_settings`; no Supabase authentication secret is used by
Edge.

Supported requests:

```txt
GET  /api/posts/<public_post_id>/comments/challenge/read?comment_request_token=<token>
GET  /api/posts/<public_post_id>/comments/challenge/write?comment_request_token=<token>
GET  /api/posts/<public_post_id>/comments?comment_request_token=<token>&comment_challenge_token=<challenge>&comment_challenge_solution=<solution>&page=<page>
POST /api/posts/<public_post_id>/comments
```

Page requests use the identical shapes under `/api/pages/<public_page_id>`.
Both collections are handled by the same target-aware implementation.

`GET` accepts only these query parameters:

| Parameter | Required | Description |
| --- | --- | --- |
| `comment_request_token` | yes | Per-target request token generated into preview-data as the item `comments.request_token`. |
| `comment_challenge_token` | yes | Token returned by the target's `/comments/challenge/read` endpoint. |
| `comment_challenge_solution` | yes | Proof-of-work solution for `comment_challenge_token`. |
| `page` | no | Positive integer page number. Defaults to `1`. |

Comment pagination, ordering, and moderation policy are read from D1 settings
instead of client query parameters.

Successful comment reads return pagination metadata in the JSON body. The API
does not expose WordPress `X-WP-*` pagination headers.

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": 5022,
        "parent_id": null,
        "author_name": "Alice",
        "author_kind": "guest",
        "created_at_iso": "2026-06-20T22:03:28Z",
        "content_text": "Comment body"
      }
    ],
    "pagination": {
      "page": 1,
      "total_pages": 1,
      "total_comments": 1
    }
  }
}
```

`created_at_iso` is serialized as UTC, second-precision RFC 3339
(`YYYY-MM-DDTHH:mm:ssZ`).

`author_kind` is `guest`, `site_user`, or `authenticated_user`. Only trusted
server-side writers may create a `site_user` comment. A public write becomes
`authenticated_user` only after Edge verifies its Supabase access token. The
endpoint rejects client-supplied identity fields and never exposes the private
identity issuer, identity subject, Studio user ID, or email address. Imported
comments that do not carry a trusted ZeroPress identity remain `guest`.

Comment reads repair malformed thread links in the response only. Missing or
self parents become roots, one deterministic link is cut in each cycle, and an
11th-level comment starts a new root thread. Across root-based pagination, the
Worker returns every approved comment once without mutating the stored D1 rows.

`POST` accepts JSON only. In the default `pow` mode it uses:

```json
{
  "parent_id": null,
  "author_name": "Alice",
  "author_email": "alice@example.com",
  "content_text": "Comment body",
  "comment_request_token": "k_AAAAAAAAAAAAAAAAAAAAAA.qxk04BHW1kADMG1rQP6yBdBWtgk82boFTKyLUqXOgFQ",
  "comment_challenge_token": "c3.payload.signature",
  "comment_challenge_solution": "12345"
}
```

In `turnstile` mode, the PoW fields are replaced by exactly one Turnstile
token:

```json
{
  "parent_id": null,
  "author_name": "Alice",
  "author_email": "alice@example.com",
  "content_text": "Comment body",
  "comment_request_token": "k_AAAAAAAAAAAAAAAAAAAAAA.qxk04BHW1kADMG1rQP6yBdBWtgk82boFTKyLUqXOgFQ",
  "turnstile_token": "browser-issued-token"
}
```

Guest writes require `author_email` as shown above. When optional Supabase Auth
is enabled, a signed-in client may instead send its access token and omit that
field:

```http
Authorization: Bearer <supabase-access-token>
Content-Type: application/json
```

```json
{
  "author_name": "Alice",
  "content_text": "Comment body",
  "comment_request_token": "k_AAAAAAAAAAAAAAAAAAAAAA.qxk04BHW1kADMG1rQP6yBdBWtgk82boFTKyLUqXOgFQ",
  "comment_challenge_token": "c3.payload.signature",
  "comment_challenge_solution": "12345"
}
```

`author_name` remains user-authored display text; an authenticated badge does
not assert that it is a verified legal name. Edge derives the stored email from
the verified JWT and ignores a body `author_email` for attribution. An explicit
malformed, expired, anonymous-user, service-role, wrong-project, or otherwise
invalid Bearer token returns `401` and is never downgraded to a guest write. A
valid account without a usable email returns `403`. JWKS or verifier
unavailability returns `503`. A request without `Authorization` keeps the
existing guest behavior.

Authentication provides attribution only. The target request token,
PoW/Turnstile verification, moderation policy, IP write limit, and network
metadata processing still apply. When `COMMENT_WRITE_RATE_LIMITER` is bound,
an authenticated request also consumes a second bucket keyed by an
`IP_HASH_SECRET`-derived HMAC of its exact `(issuer, subject)` identity; raw
identity values are never sent to the limiter.

Edge accepts only asymmetric Supabase access tokens signed with `ES256` or
`RS256`. It pins the issuer to `<project_url>/auth/v1`, requires the
`authenticated` audience and role plus expiry and subject claims, and obtains
public keys from that issuer's fixed `/.well-known/jwks.json` endpoint. Keys are
cached in Worker memory for at most ten minutes. Unknown `kid` refreshes follow
the verifier's 30-second cooldown and concurrent-fetch coalescing so signing-key
rotation cannot be used to amplify outbound requests. Edge does not store access,
refresh, or social-provider tokens and does not use Supabase's legacy shared
JWT secret or a service-role key.

`parent_id` may be omitted or `null` for a root comment. A reply uses the
positive integer `id` of an existing approved comment on the same target.

The UTF-8 encoded comment request body has a hard limit of `64 KiB`.

Successful comment writes return `201 Created`. `publication` indicates whether
the new comment is immediately visible or awaiting moderation:

```json
{
  "success": true,
  "data": {
    "publication": "published"
  }
}
```

The other successful value is `pending_moderation`. The response intentionally
does not echo the submitted comment or expose its identifier.

`comment_request_token` is required for ZeroPress-native comment endpoints. It
is not a WordPress API parameter.

## Comment Request Token

ZeroPress Studio generates a per-target token when preview-data is built.
Themes should read the current Post/Page item's `comments.request_token` and
send it to this API:

- `GET`: send it as the `comment_request_token` query parameter.
- `POST`: send it as the `comment_request_token` JSON body field.

The Edge Worker verifies the token against
`EDGE_DB.edge_comment_settings.request_secrets_json`. That value is a plain
JSON operational setting managed by Studio.

Token format is fixed length:

```txt
k_<22 base64url chars>.<43 base64url chars>
```

The public `kid` value is opaque and does not expose the creation time. Secret
creation and expiry timestamps live only inside `request_secrets_json`.

If `request_secrets_json` is missing or invalid, comment reads, writes, and
challenge requests fail with `INVALID_COMMENT_REQUEST_TOKEN`. The Worker also
writes a `console.warn` message so the administrator can identify the missing or
malformed setting.

The token is bound to the target type, public ID, and target incarnation nonce.
Deleting and recreating a Post/Page with the same public ID therefore invalidates
the old token. Comment reads pair it with read PoW; comment writes pair it with
the verification mode advertised below.

## Comment Verification Discovery

Each Post/Page `/comments/challenge/:scope` endpoint provides comment verification.
The `read` scope always issues the existing stateless proof-of-work challenge.
The `write` scope returns the mode selected by
`edge_runtime_settings.comment_write_verification_mode`:

```txt
GET /api/posts/12132/comments/challenge/read?comment_request_token=<token>
GET /api/posts/12132/comments/challenge/write?comment_request_token=<token>
```

The read response retains the same fields; its signed token now uses the
target-aware `c3` contract:

```json
{
  "success": true,
  "data": {
    "item": {
      "algorithm": "zp-comment-pow-v1",
      "scope": "read",
      "difficulty": 14,
      "expires_at": "2026-06-28T12:00:00Z",
      "challenge_token": "c3.payload.signature"
    }
  }
}
```

The default write response nests the existing challenge under `pow`:

```json
{
  "success": true,
  "data": {
    "item": {
      "mode": "pow",
      "scope": "write",
      "pow": {
        "algorithm": "zp-comment-pow-v1",
        "scope": "write",
        "difficulty": 15,
        "expires_at": "2026-06-28T12:00:00Z",
        "challenge_token": "c3.payload.signature"
      }
    }
  }
}
```

Turnstile write discovery does not issue a PoW challenge:

```json
{
  "success": true,
  "data": {
    "item": {
      "mode": "turnstile",
      "scope": "write",
      "turnstile": {
        "site_key": "public-site-key",
        "action": "comment_create"
      }
    }
  }
}
```

The `comment_request_token` only proves that the caller has a token generated
with preview-data. It is not used to sign challenge tokens. Comment read and
`pow`-mode write challenges are signed with `EDGE_TOKEN_SIGNING_SECRET`,
matching the PoW newsletter and form challenge model.

The client finds a decimal `comment_challenge_solution` where:

```txt
sha256(challenge_token + "." + comment_challenge_solution)
```

has at least `difficulty` leading zero bits. `scope=read` challenges are valid
for 300 seconds so comment page navigation can reuse them until expiry. In
`pow` write mode, the challenge inside `item.pow` is valid for 60 seconds and
is used for one comment submission.

PoW write challenges are marked as used in `EDGE_KV` immediately before the
comment insert. This is a soft replay guard: KV is eventually consistent, so it
is not a cryptographic one-time guarantee, but ordinary duplicate submits and
simple replays are rejected. Turnstile mode does not create or consume this KV
marker; Cloudflare validates the Turnstile token as a single-use token.

Challenge issuance can be protected with the optional
`COMMENT_CHALLENGE_RATE_LIMITER` binding. The limiter key is the client IP, so a
scanner cannot bypass it by rotating target IDs.

## Error Codes

Common structured error responses use this shape:

```json
{
  "success": false,
  "error": {
    "code": "INVALID_COMMENT_REQUEST_TOKEN",
    "message": "Comment request token is invalid.",
    "errors": []
  }
}
```

Common codes:

| Code | Status | Cause |
| --- | --- | --- |
| `MISSING_QUERY` | `400` | A required query parameter is missing. |
| `UNSUPPORTED_QUERY` | `400` | Unknown or duplicate query parameter was provided. |
| `INVALID_COMMENT_TARGET_ID` | `400` | The Post/Page target path segment is not a positive integer. |
| `INVALID_SITE_ORIGIN` | `400` | Comments status `site_origin` is not one absolute HTTP(S) origin. |
| `INVALID_PAGE` | `400` | `page` is present but is not a positive integer. |
| `INVALID_COMMENT_CHALLENGE_SCOPE` | `400` | The comment challenge `:scope` path segment is not `read` or `write`. |
| `UNSUPPORTED_MEDIA_TYPE` | `415` | `POST` body is not `application/json`. |
| `INVALID_JSON` | `400` | `POST` body is not valid JSON. |
| `REQUEST_BODY_TOO_LARGE` | `413` | `POST` body exceeds the `64 KiB` hard limit. |
| `VALIDATION_ERROR` | `422` | `POST` body fields are missing, malformed, too long, or the parent comment was not found. |
| `MISSING_COMMENT_REQUEST_TOKEN` | `403` | Token is omitted from a valid target comment request. |
| `INVALID_COMMENT_REQUEST_TOKEN` | `403` | Token is malformed, signed for another target or target incarnation, uses an unknown/expired key, or `edge_comment_settings.request_secrets_json` is missing/invalid. |
| `INVALID_COMMENT_AUTH_TOKEN` | `401` | Explicit Bearer credentials are malformed, expired, anonymous, service-role, signed by another issuer, or otherwise invalid. |
| `UNSUPPORTED_COMMENT_AUTH_TOKEN_ALGORITHM` | `401` | Bearer credentials use a signing algorithm other than the supported asymmetric `ES256` or `RS256` algorithms. |
| `COMMENT_AUTH_NOT_ENABLED` | `401` | Bearer credentials were supplied while optional comment authentication is disabled. |
| `COMMENT_AUTH_EMAIL_NOT_AVAILABLE` | `403` | The verified account has no valid email claim required for comment moderation. |
| `COMMENT_AUTH_SETTINGS_NOT_AVAILABLE` | `503` | Supabase settings are missing, unreadable, incomplete, or malformed. |
| `COMMENT_AUTH_VERIFICATION_NOT_AVAILABLE` | `503` | The pinned Supabase JWKS endpoint or local verifier is temporarily unavailable. |
| `MISSING_COMMENT_CHALLENGE` | `403` | A required read or `pow`-mode write challenge token/solution is omitted. |
| `INVALID_COMMENT_CHALLENGE` | `403` | A PoW challenge is malformed, signed for another target, target incarnation, or scope, or the solution does not satisfy the difficulty. |
| `EXPIRED_COMMENT_CHALLENGE` | `403` | A PoW challenge expired. Request a new challenge and retry. |
| `COMMENT_CHALLENGE_NOT_AVAILABLE` | `503` | Worker secret required for read or `pow`-mode write challenge signing is missing or too short. |
| `COMMENT_CHALLENGE_ALREADY_USED` | `403` | A PoW write challenge was already consumed. Request a new challenge and retry. |
| `EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE` | `503` | Required D1 runtime settings are missing, unreadable, or malformed. |
| `TURNSTILE_NOT_AVAILABLE` | `503` | Required Turnstile configuration is missing in `turnstile` mode. |
| `INVALID_TURNSTILE_TOKEN` / `INVALID_TURNSTILE_ORIGIN` | `403` | Turnstile token or request Origin verification failed. |
| `TURNSTILE_VERIFY_RATE_LIMITED` | `429` | Optional pre-verification limiter rejected the attempt. |
| `TURNSTILE_VERIFY_RATE_LIMIT_NOT_AVAILABLE` / `TURNSTILE_VERIFICATION_NOT_AVAILABLE` | `503` | The optional limiter or Siteverify is unavailable. |
| `COMMENT_IP_HASH_NOT_AVAILABLE` | `503` | Worker secret required for IP pseudonymization is missing or too short. Comment writes are temporarily unavailable. |
| `COMMENTS_NOT_FOUND` | `404` | Comments are unavailable because the API base is unset or the target is missing, unpublished, or not commentable. |
| `COMMENTS_DISABLED` | `403` | `edge_comment_settings.comments_enabled` is disabled. |
| `RATE_LIMITED` | `429` | Comment challenge or write rate limiter rejected the request. |
| `CORS_ORIGIN_DENIED` | `403` | Request origin is not in `ALLOWED_ORIGINS` and is not same-origin. |
| `METHOD_NOT_ALLOWED` | `405` | HTTP method is not supported. |
| `NOT_FOUND` | `404` | Route does not exist inside a recognized API module path. Other unknown paths return an empty `404`. |
| `INTERNAL_ERROR` | `500` | Unexpected server-side failure. |

## Newsletter API

The newsletter endpoints are:

```txt
GET  /api/newsletters/<slug>
GET  /api/newsletters/<slug>/challenge/subscribe
POST /api/newsletters/<slug>/subscriptions
POST /api/newsletters/<slug>/subscriptions/confirm
```

`GET /api/newsletters/<slug>` returns active newsletter metadata and active
custom fields:

```json
{
  "success": true,
  "data": {
    "item": {
      "newsletter": {
        "slug": "default",
        "title": "Newsletter",
        "description": null
      },
      "fields": []
    }
  }
}
```

The checked-in install seed creates only the email-only `default` newsletter, so
`fields` is empty until Studio/admin tooling adds field definitions.

Successful newsletter metadata responses are cached in `EDGE_KV` by slug for
the code-defined 300-second lifetime. The cache stores only the public
newsletter metadata payload, not the response envelope. The optional
`NEWSLETTER_READ_RATE_LIMITER` can also rate limit metadata reads by client IP.

`POST /api/newsletters/<slug>/subscriptions` accepts JSON only. In the default
`pow` mode it uses:

```json
{
  "email": "alice@example.com",
  "fields": {
    "first_name": "Alice"
  },
  "source_url": "https://example.com/newsletter_zeropress.html",
  "newsletter_challenge_token": "n1.payload.signature",
  "newsletter_challenge_solution": "12345"
}
```

In `turnstile` mode, replace both newsletter challenge fields with
`turnstile_token`:

```json
{
  "email": "alice@example.com",
  "fields": {
    "first_name": "Alice"
  },
  "source_url": "https://example.com/newsletter_zeropress.html",
  "turnstile_token": "browser-issued-token"
}
```

`fields` may be omitted. `source_url` is required and must be an absolute
`http` or `https` URL from the request origin or `ALLOWED_ORIGINS`; its fragment
is stripped before use. If custom fields exist, unknown field keys are rejected
and required fields must be present. Field values are validated from
`newsletter_fields.type`, `newsletter_fields.required`, and
`newsletter_fields.options_json`. Configured option values and labels, and the
corresponding select, radio, and checkbox inputs, are limited to `120`
characters. A required checkbox must contain at least one value. File, image,
and HTML inputs are not supported.

The UTF-8 encoded subscribe request body has a hard limit of `256 KiB`.

Newsletter subscribe uses double opt-in only. A successful submit returns:

```json
{
  "success": true,
  "data": {
    "status": "accepted"
  }
}
```

If the email is already subscribed, the same response is returned and no email
is sent. This avoids exposing whether a given email address is already on the
list.

### Newsletter Verification Discovery

`GET /api/newsletters/<slug>/challenge/subscribe` returns the runtime
verification mode for newsletter subscription submits:

```txt
GET /api/newsletters/default/challenge/subscribe
```

The default `pow` response nests the existing stateless challenge:

```json
{
  "success": true,
  "data": {
    "item": {
      "mode": "pow",
      "scope": "subscribe",
      "pow": {
        "algorithm": "zp-newsletter-pow-v1",
        "scope": "subscribe",
        "difficulty": 15,
        "expires_at": "2026-07-01T12:00:00Z",
        "challenge_token": "n1.payload.signature"
      }
    }
  }
}
```

The `turnstile` response contains no PoW challenge:

```json
{
  "success": true,
  "data": {
    "item": {
      "mode": "turnstile",
      "scope": "subscribe",
      "turnstile": {
        "site_key": "public-site-key",
        "action": "newsletter_subscribe"
      }
    }
  }
}
```

In `pow` mode, the client finds a decimal `newsletter_challenge_solution`
where:

```txt
sha256(challenge_token + "." + newsletter_challenge_solution)
```

has at least `difficulty` leading zero bits. The challenge inside `item.pow` is
bound to the newsletter slug and is valid for 60 seconds. PoW subscribe
challenges are marked as used in `EDGE_KV` immediately before subscription
processing. This is a soft replay guard; double opt-in and rate limits still
bound the practical effect of replay. Turnstile mode does not create or consume
this KV marker.

Challenge issuance can be protected with the optional
`NEWSLETTER_CHALLENGE_RATE_LIMITER` binding. Subscribe POSTs are still protected
separately by `NEWSLETTER_SUBSCRIBE_RATE_LIMITER`; Turnstile Siteverify calls
may additionally use the shared `TURNSTILE_VERIFY_RATE_LIMITER` after the
subscribe limiter accepts the request.

Confirmation email links point back to the client subscribe page with a fragment
token, for example:

```txt
https://example.com/newsletter_zeropress.html#confirm_token=<token>
```

The client must show an explicit confirmation UI and then call:

```txt
POST /api/newsletters/default/subscriptions/confirm
```

```json
{ "token": "nc1.payload.signature" }
```

The confirm endpoint is JSON-only and state changes happen only on `POST`.
Its UTF-8 encoded request body has a hard limit of `8 KiB`.
`GET /api/newsletters/<slug>/subscriptions/confirm?token=<token>` returns
`405 METHOD_NOT_ALLOWED` and does not confirm the subscription. The confirmation
token is a signed stateless envelope (`nc1.<payload>.<signature>`), so malformed,
wrong-newsletter, and expired links can be rejected before reading D1. Final
confirmation still reads D1 to verify that the token hash belongs to a pending
subscription. Submitting again before confirmation replaces the previous stored
token hash, so only the newest confirmation link remains valid. Confirmation is
committed with an atomic token-hash comparison, preventing a replaced token from
succeeding between lookup and update.

### Newsletter Email

The Edge Worker does not build or send confirmation email directly. It stores
the pending subscription in `EDGE_DB`, then enqueues a mail job to `MAIL_QUEUE`.
The Studio API Worker consumes `zeropress-mail-queue`, composes the final email,
and sends it with the configured mail provider.

Edge only reads `EDGE_DB.edge_mail_settings` to know whether public mail jobs are
available:

| Column | Description |
| --- | --- |
| `newsletter_confirmation_enabled` | Enables newsletter confirmation queue jobs. |
| `form_notification_enabled` | Enables form notification queue jobs. |

The Studio API updates this row when mail settings are saved. If the relevant
flag is disabled, or `MAIL_QUEUE` is not bound, subscription submits fail with
`NEWSLETTER_EMAIL_NOT_AVAILABLE` regardless of whether the email is already
subscribed. A runtime queue enqueue failure is logged and recorded internally,
while the public response remains the generic accepted response to prevent
subscription-state enumeration.

- Missing or too-short `EDGE_TOKEN_SIGNING_SECRET`: newsletter confirmation and
  `pow`-mode subscribe discovery fail with `NEWSLETTER_CONFIRMATION_NOT_AVAILABLE`
  or `NEWSLETTER_CHALLENGE_NOT_AVAILABLE`.
- Missing or too-short `IP_HASH_SECRET`: newsletter subscribe requests fail with
  `NEWSLETTER_IP_HASH_NOT_AVAILABLE`.

### Newsletter Error Codes

Newsletter structured JSON errors use the same response shape as comments.

Common codes:

| Code | Status | Cause |
| --- | --- | --- |
| `INVALID_NEWSLETTER_SLUG` | `400` | The `:slug` path segment is not a lowercase URL slug. |
| `INVALID_NEWSLETTER_CHALLENGE_SCOPE` | `400` | The newsletter challenge `:scope` path segment is not `subscribe`. |
| `NEWSLETTER_NOT_FOUND` | `404` | Newsletter does not exist or is not active. |
| `UNSUPPORTED_MEDIA_TYPE` | `415` | Subscribe or confirmation body is not `application/json`. |
| `INVALID_JSON` | `400` | Subscribe or confirmation body is not valid JSON. |
| `REQUEST_BODY_TOO_LARGE` | `413` | Subscribe body exceeds `256 KiB`, or confirmation body exceeds `8 KiB`. |
| `VALIDATION_ERROR` | `422` | Email or custom field input is missing, unknown, malformed, or unsupported. |
| `MISSING_NEWSLETTER_CHALLENGE` | `403` | A `pow`-mode subscribe challenge token or solution is omitted. |
| `INVALID_NEWSLETTER_CHALLENGE` | `403` | A PoW subscribe challenge is malformed, signed for another newsletter slug, or the solution does not satisfy the difficulty. |
| `EXPIRED_NEWSLETTER_CHALLENGE` | `403` | A PoW subscribe challenge expired. Request a new challenge and retry. |
| `NEWSLETTER_CHALLENGE_NOT_AVAILABLE` | `503` | Worker secret required for `pow`-mode newsletter challenge signing is missing or too short. |
| `NEWSLETTER_CHALLENGE_ALREADY_USED` | `403` | A PoW subscribe challenge was already consumed. Request a new challenge and retry. |
| `EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE` | `503` | Required D1 runtime settings are missing, unreadable, or malformed. |
| `TURNSTILE_NOT_AVAILABLE` | `503` | Required Turnstile configuration is missing in `turnstile` mode. |
| `INVALID_TURNSTILE_TOKEN` / `INVALID_TURNSTILE_ORIGIN` | `403` | Turnstile token or request Origin verification failed. |
| `TURNSTILE_VERIFY_RATE_LIMITED` | `429` | Optional pre-verification limiter rejected the attempt. |
| `TURNSTILE_VERIFY_RATE_LIMIT_NOT_AVAILABLE` / `TURNSTILE_VERIFICATION_NOT_AVAILABLE` | `503` | The optional limiter or Siteverify is unavailable. |
| `NEWSLETTER_IP_HASH_NOT_AVAILABLE` | `503` | Worker secret required for IP pseudonymization is missing or too short. Newsletter subscriptions are temporarily unavailable. |
| `INVALID_NEWSLETTER_CONFIRMATION_TOKEN` | `400` | Confirmation token is malformed, unknown, already processed, or not valid for the newsletter. |
| `EXPIRED_NEWSLETTER_CONFIRMATION_TOKEN` | `410` | Confirmation token expired. Submit the subscribe form again. |
| `NEWSLETTER_CONFIRMATION_NOT_AVAILABLE` | `503` | Worker secret required for confirmation token verification is missing or too short. |
| `NEWSLETTER_SUPPRESSED` | `403` | Email address is globally suppressed. |
| `NEWSLETTER_EMAIL_NOT_AVAILABLE` | `503` | Newsletter confirmation email cannot currently be queued. |
| `RATE_LIMITED` | `429` | Optional newsletter read, challenge, or subscribe rate limiter rejected the request. |

## Forms API

The forms endpoints are:

```txt
GET  /api/forms/<slug>
GET  /api/forms/<slug>/challenge/submit
POST /api/forms/<slug>/submissions
```

`GET /api/forms/<slug>` returns an active form and its active fields:

```json
{
  "success": true,
  "data": {
    "item": {
      "form": {
        "slug": "contact",
        "title": "Contact",
        "description": "Send a message.",
        "submit_label": "Send",
        "success_message": "Thanks for contacting us."
      },
      "fields": [
        {
          "key": "email",
          "label": "Email",
          "type": "email",
          "required": true,
          "placeholder": null,
          "help_text": null,
          "options": [],
          "sort_order": 20
        }
      ]
    }
  }
}
```

Successful form metadata responses are cached in `EDGE_KV` by slug for the
code-defined 300-second lifetime. The cache stores only the public form metadata
payload, not the response envelope. The optional `FORM_READ_RATE_LIMITER` can
also rate limit form metadata reads by client IP. Studio form definitions allow
at most `50` fields.

`POST /api/forms/<slug>/submissions` accepts JSON only. In the default `pow`
mode it uses:

```json
{
  "fields": {
    "name": "Alice",
    "email": "alice@example.com",
    "message": "Hello"
  },
  "source_url": "https://example.com/contact/",
  "form_challenge_token": "f1.payload.signature",
  "form_challenge_solution": "12345"
}
```

In `turnstile` mode, replace both form challenge fields with
`turnstile_token`:

```json
{
  "fields": {
    "name": "Alice",
    "email": "alice@example.com",
    "message": "Hello"
  },
  "source_url": "https://example.com/contact/",
  "turnstile_token": "browser-issued-token"
}
```

Unknown field keys are rejected. Field values are validated from
`form_fields.type`, `form_fields.required`, and `form_fields.options_json`.
Configured option values and labels, and their submitted values, are limited to
`120` characters. Select, radio, and checkbox fields expose at most `50`
configured options, matching the maximum number of values accepted from a
checkbox submission. Configured option values use the same single-line text
normalization as submitted values. Date fields must contain a real calendar
date in `YYYY-MM-DD` format. File, image, and HTML inputs are not supported.
`source_url` is optional; when present, it identifies the page that hosts and
submits the form. Clients must send the current page URL, not
`document.referrer`; external navigation
referrers are not stored. The URL must be an absolute HTTP(S) URL from the
request origin or `ALLOWED_ORIGINS`, must not contain credentials, and has its
fragment removed before storage. Notification email displays this value as
escaped text rather than an operator-controlled link.

The UTF-8 encoded form submission body has a hard limit of `256 KiB`.

A successful submit returns only public acknowledgement data:

```json
{
  "success": true,
  "data": {
    "status": "accepted",
    "message": "Your submission has been received."
  }
}
```

Submission row ids, internal status values, and moderation state are not exposed
to the public caller.

If `forms.notification_email` is set and
`edge_mail_settings.form_notification_enabled = 1`, Edge enqueues an operator
notification job after the submission is stored. Delivery is handled by the
Studio API queue consumer. If notification mail is disabled or `MAIL_QUEUE` is
not bound, the public submit response still remains `202 accepted` because the
submission has already been received. A notification settings lookup or queue
enqueue failure after storage is logged and also does not change that response.

### Form Verification Discovery

`GET /api/forms/<slug>/challenge/submit` returns the runtime verification mode
for public form submissions. The default `pow` response nests the existing
stateless challenge:

```json
{
  "success": true,
  "data": {
    "item": {
      "mode": "pow",
      "scope": "submit",
      "pow": {
        "algorithm": "zp-form-pow-v1",
        "scope": "submit",
        "difficulty": 15,
        "expires_at": "2026-07-02T12:00:00Z",
        "challenge_token": "f1.payload.signature"
      }
    }
  }
}
```

The `turnstile` response contains no PoW challenge:

```json
{
  "success": true,
  "data": {
    "item": {
      "mode": "turnstile",
      "scope": "submit",
      "turnstile": {
        "site_key": "public-site-key",
        "action": "form_submit"
      }
    }
  }
}
```

In `pow` mode, the client finds a decimal `form_challenge_solution` where:

```txt
sha256(challenge_token + "." + form_challenge_solution)
```

has at least `difficulty` leading zero bits. PoW form submit challenges are
valid for 60 seconds and are marked as used in `EDGE_KV` immediately before
submission storage. This is a soft replay guard. Turnstile mode does not create
or consume this KV marker.

Discovery can be protected by `FORM_CHALLENGE_RATE_LIMITER`, and submissions
remain protected separately by `FORM_SUBMIT_RATE_LIMITER`. Turnstile Siteverify
calls may additionally use the shared `TURNSTILE_VERIFY_RATE_LIMITER` after the
submit limiter accepts the request.

### Forms Error Codes

Forms structured JSON errors use the same response shape as comments.

Common codes:

| Code | Status | Cause |
| --- | --- | --- |
| `INVALID_FORM_SLUG` | `400` | The `:slug` path segment is not a lowercase URL slug. |
| `INVALID_FORM_CHALLENGE_SCOPE` | `400` | The form challenge `:scope` path segment is not `submit`. |
| `FORM_NOT_FOUND` | `404` | Form does not exist or is not active. |
| `UNSUPPORTED_MEDIA_TYPE` | `415` | Submission body is not `application/json`. |
| `INVALID_JSON` | `400` | Submission body is not valid JSON. |
| `REQUEST_BODY_TOO_LARGE` | `413` | Submission body exceeds the `256 KiB` hard limit. |
| `VALIDATION_ERROR` | `422` | Field input is missing, unknown, malformed, too long, or unsupported. |
| `MISSING_FORM_CHALLENGE` | `403` | A `pow`-mode submit challenge token or solution is omitted. |
| `INVALID_FORM_CHALLENGE` | `403` | A PoW submit challenge is malformed, signed for another form slug, or the solution does not satisfy the difficulty. |
| `EXPIRED_FORM_CHALLENGE` | `403` | A PoW submit challenge expired. Request a new challenge and retry. |
| `FORM_CHALLENGE_NOT_AVAILABLE` | `503` | Worker secret required for `pow`-mode form challenge signing is missing or too short. |
| `FORM_CHALLENGE_ALREADY_USED` | `403` | A PoW submit challenge was already consumed. Request a new challenge and retry. |
| `EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE` | `503` | Required D1 runtime settings are missing, unreadable, or malformed. |
| `TURNSTILE_NOT_AVAILABLE` | `503` | Required Turnstile configuration is missing in `turnstile` mode. |
| `INVALID_TURNSTILE_TOKEN` / `INVALID_TURNSTILE_ORIGIN` | `403` | Turnstile token or request Origin verification failed. |
| `TURNSTILE_VERIFY_RATE_LIMITED` | `429` | Optional pre-verification limiter rejected the attempt. |
| `TURNSTILE_VERIFY_RATE_LIMIT_NOT_AVAILABLE` / `TURNSTILE_VERIFICATION_NOT_AVAILABLE` | `503` | The optional limiter or Siteverify is unavailable. |
| `FORM_IP_HASH_NOT_AVAILABLE` | `503` | Worker secret required for IP pseudonymization is missing or too short. Form submissions are temporarily unavailable. |
| `RATE_LIMITED` | `429` | Optional form read, challenge, or submit rate limiter rejected the request. |

## Required Bindings

The Worker expects these bindings:

| Binding | Type | Purpose |
| --- | --- | --- |
| `EDGE_DB` | D1 database | Public edge runtime database for comments, newsletter, and form tables. |
| `EDGE_KV` | KV namespace | Optional edge cache and soft used-challenge guard. |
| `MAIL_QUEUE` | Queue producer | Enqueues public mail jobs to `zeropress-mail-queue` for Studio API to consume. |
| `COMMENT_CHALLENGE_RATE_LIMITER` | Rate limiter | Optional rate limit for challenge issuance. |
| `COMMENT_WRITE_RATE_LIMITER` | Rate limiter | Optional write rate limit for comment submissions. |
| `NEWSLETTER_READ_RATE_LIMITER` | Rate limiter | Optional rate limit for newsletter metadata reads. |
| `NEWSLETTER_CHALLENGE_RATE_LIMITER` | Rate limiter | Optional rate limit for newsletter challenge issuance. |
| `NEWSLETTER_SUBSCRIBE_RATE_LIMITER` | Rate limiter | Optional rate limit for newsletter subscription submits. |
| `FORM_READ_RATE_LIMITER` | Rate limiter | Optional rate limit for form metadata reads. |
| `FORM_CHALLENGE_RATE_LIMITER` | Rate limiter | Optional rate limit for form challenge issuance. |
| `FORM_SUBMIT_RATE_LIMITER` | Rate limiter | Optional rate limit for form submissions. |
| `TURNSTILE_VERIFY_RATE_LIMITER` | Rate limiter | Optional shared high-limit guard before outbound Turnstile Siteverify calls. |

If `COMMENT_CHALLENGE_RATE_LIMITER` is not bound, challenge requests are not
rate limited by this Worker.

If `COMMENT_WRITE_RATE_LIMITER` is not bound, comment writes are not rate
limited by this Worker. When it is bound, guest and authenticated writes first
use the existing client-IP bucket. A successfully authenticated identity also
uses a separate HMAC-pseudonymized identity bucket on the same binding.

If `NEWSLETTER_READ_RATE_LIMITER` is not bound, newsletter metadata reads are
not rate limited by this Worker.

If `NEWSLETTER_SUBSCRIBE_RATE_LIMITER` is not bound, newsletter subscription
submits are not rate limited by this Worker.

If `NEWSLETTER_CHALLENGE_RATE_LIMITER` is not bound, newsletter challenge
requests are not rate limited by this Worker.

If `FORM_READ_RATE_LIMITER` is not bound, form metadata reads are not rate
limited by this Worker.

If `FORM_CHALLENGE_RATE_LIMITER` is not bound, form challenge requests are not
rate limited by this Worker.

If `FORM_SUBMIT_RATE_LIMITER` is not bound, form submissions are not rate
limited by this Worker.

If `TURNSTILE_VERIFY_RATE_LIMITER` is not bound, Turnstile verification remains
available without this pre-verification limit. When bound, its key is
`<action>:<client-ip>`. A limiter rejection returns `429`; a limiter failure
returns `503` and does not fall back to PoW. It always runs after the applicable
feature write limiter. The checked-in `wrangler.jsonc` does not provision this
optional binding.

## KV Behavior

`EDGE_KV` is an acceleration and short-window replay mitigation layer. It is
not the source of truth. Comments, newsletter metadata, and form metadata are
stored in D1.

If `EDGE_KV` is not bound, or if KV read/write/delete operations fail, Edge
keeps public APIs functional where possible:

- approved comment reads fall back to `EDGE_DB.comments`;
- newsletter and form metadata reads fall back to `EDGE_DB`;
- cache writes and deletes are skipped after a `console.warn`;
- PoW used-challenge replay markers are skipped when KV is unavailable.

The last point means submit APIs can still work, but short-window duplicate
submit protection is weaker in `pow` mode. Challenge token verification and
optional Cloudflare rate limit bindings still apply. Turnstile verification
does not use `EDGE_KV` replay markers.

A consumed PoW challenge marker remains until 60 seconds after the challenge's
expiry, with a minimum marker lifetime of 60 seconds. Therefore, a freshly
consumed 60-second write challenge normally creates a marker with an
`expirationTtl` of about 120 seconds. These values are product constants and
have no environment-variable or D1 override path.

All three public-data caches use Cloudflare KV `expirationTtl: 300`. This value
is a product constant and has no environment-variable or D1 override path.

## IP Address Retention

Write APIs store the original client IP address, an `IP_HASH_SECRET`-derived
`ip_hash`, and Cloudflare network metadata for moderation and abuse response.
The original `ip_address` is intentionally short-lived.

Each write stores `ip_address_recorded_at` alongside `ip_address`. The scheduled
Worker job clears only `ip_address` after the number of days configured in
`edge_runtime_settings.ip_address_retention_days`; `ip_hash`, ASN, organization,
and country metadata remain available for moderation context. The seeded value
is `30`, and D1 constrains it to `1..365`. Database constraints reject rows that
contain an original IP without `ip_address_recorded_at`, so the scheduled job
only clears timestamped original IPs older than the retention cutoff.

The scheduled job updates:

- `comments.ip_address`
- `newsletter_subscriptions.ip_address`
- `form_submissions.ip_address`

If the scheduled job fails, the Worker writes a structured `console.error` log
and rethrows the error so Cloudflare marks the scheduled invocation as failed.

## Worker Variables

Only deployment-level feature gates and the CORS allowlist are plain Worker
variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | empty | Comma-separated cross-origin allowlist. |
| `COMMENTS_ENABLED` | `true` | Enables comments API routes. Disabled comment routes return empty `404` responses before using D1/KV/rate limits. |
| `NEWSLETTER_ENABLED` | `false` | Enables newsletter API routes. Disabled newsletter routes return empty `404` responses before using D1/KV/rate limits. |
| `FORMS_ENABLED` | `false` | Enables form API routes. Disabled form routes return empty `404` responses before using D1/KV/rate limits. |

`EDGE_TOKEN_SIGNING_SECRET`, `IP_HASH_SECRET`, and `TURNSTILE_SECRET_KEY` are
Worker secrets, not plain variables or D1 values.

## D1 Runtime Settings

`EDGE_DB.edge_runtime_settings` is a typed singleton with `id = 1`. The ordered
schema step creates and seeds this row. Studio manages these columns:

| Column | Seed | Contract |
| --- | --- | --- |
| `comment_write_verification_mode` | `pow` | Exactly `pow` or `turnstile`. Comment reads are unaffected. |
| `newsletter_subscribe_verification_mode` | `pow` | Exactly `pow` or `turnstile`. Confirmation is unaffected. |
| `form_submit_verification_mode` | `pow` | Exactly `pow` or `turnstile`. |
| `turnstile_sitekey` | `NULL` | Trimmed non-empty string up to 256 characters; required if any mode is `turnstile`. |
| `ip_address_retention_days` | `30` | Integer in `1..365`. |

Edge reads this row directly from D1 without a settings KV cache. Missing rows,
D1 query failures, malformed values, and broken mode/sitekey relationships fail
closed with `EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE`; there is no environment or
code fallback. Comment `GET` and read-challenge discovery intentionally do not
read this singleton: they load comment configuration and request secrets from
`edge_comment_settings` in one query. Comment writes and write-challenge
discovery load both settings singletons in one joined query and retain the
strict runtime-settings failure policy.

Optional Supabase comment authentication is configured in the existing
`edge_comment_settings` singleton:

| Column | Seed | Contract |
| --- | --- | --- |
| `auth_enabled` | `0` | Boolean feature state. Disabled settings may retain a complete project/key pair. |
| `supabase_project_url` | `NULL` | Normalized HTTPS origin, or an HTTP loopback origin for local development. |
| `supabase_publishable_key` | `NULL` | Trimmed `sb_publishable_` browser key; it is public configuration, not a Worker secret. |

The project URL and publishable key must be both null or both valid. Enabling
authentication additionally requires the complete pair. Discovery fails closed
for malformed settings. Guest writes remain available in optional mode when no
Authorization header is supplied.

## Code-defined Runtime Constants

These product safety values are fixed in code and have no settings override:

| Behavior | Value |
| --- | --- |
| Approved comments cache lifetime | `300` seconds |
| Newsletter metadata cache lifetime | `300` seconds |
| Form metadata cache lifetime | `300` seconds |
| Comment read PoW difficulty | `14` leading zero bits |
| Comment write PoW difficulty | `15` leading zero bits |
| Newsletter subscribe PoW difficulty | `15` leading zero bits |
| Form submit PoW difficulty | `15` leading zero bits |
| Comment read challenge lifetime | `300` seconds |
| Comment write challenge lifetime | `60` seconds |
| Newsletter subscribe challenge lifetime | `60` seconds |
| Form submit challenge lifetime | `60` seconds |
| Used-challenge expiry buffer / minimum marker lifetime | `60` / `60` seconds |

`EDGE_TOKEN_SIGNING_SECRET` is used for disposable runtime tokens: newsletter
confirmation tokens, comment read challenges, and write challenges for APIs in
`pow` mode. Runtime HMAC signing keys are derived from it with HKDF-SHA256 and
purpose-specific labels. It must be at least 48 characters after trimming.
Generate one with:

```sh
openssl rand -base64 36
```

`TURNSTILE_SECRET_KEY` is sent only from the Worker to Cloudflare Siteverify.
It is required, together with `edge_runtime_settings.turnstile_sitekey`, whenever
any public write is configured as `turnstile`. The checked-in Wrangler
configuration intentionally does not include this secret or the optional
Turnstile limiter.

`IP_HASH_SECRET` is used to pseudonymize client IP addresses stored with
comment writes, newsletter subscription requests, and form submissions. IP hash
HMAC keys are derived from it with HKDF-SHA256 and a purpose-specific label. It
must be at least 48 characters after trimming. Generate one with the same
command:

```sh
openssl rand -base64 36
```

When `ALLOWED_ORIGINS` is empty, same-origin requests and requests without an
`Origin` header are allowed. Cross-origin requests are denied.

## Comment Runtime Defaults

Comment runtime settings are read from `EDGE_DB.edge_comment_settings`. If the
singleton row is missing, the comments runtime uses these fallback values:

| Setting key | Default |
| --- | --- |
| `comments_enabled` | `true` |
| `api_base_url` | `null` |
| `require_approval` | `true` |
| `per_page` | `50` |
| `sort_order` | `desc` |
| `thread_comments` | `true` |
| `thread_comments_depth` | `2` |

The site policy defaults to `comments_enabled: true`, which Studio exposes as
`comments.enabled: true` in its settings API. Studio emits Preview Data
`site.comments` only when `api_base_url` is configured. With an empty
`edge_comment_settings` table, the API base is still null, so comment reads,
writes, and challenges remain unavailable even when an `edge_comment_targets`
row is published and has `allow_comments = 1`. A null or malformed
`api_base_url` likewise makes comments unavailable without discarding the
remaining stored policy.
`thread_comments_depth` is enforced on writes. For example, depth `2` means only
root comments can receive direct replies.

## Development

```bash
npm test
npm run typecheck
npm run build
```

`npm run build` performs a Wrangler dry run. It does not deploy the Worker.
