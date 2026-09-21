# Comments API

Threaded public comments for published Posts and Pages. `COMMENTS_ENABLED` must
be exact `true`. See [common API rules](common.md) for CORS, deployment gates,
response envelopes, write verification, and shared errors.

## Endpoints

```txt
GET  /api/comments/auth
GET  /api/posts/<public_post_id>/comments/challenge/read
GET  /api/posts/<public_post_id>/comments/challenge/write
GET  /api/posts/<public_post_id>/comments
POST /api/posts/<public_post_id>/comments
```

Page routes use the same shapes under `/api/pages/<public_page_id>`.

## Read comments

Obtain a target-bound read challenge, then send its solution with the target
request token:

```txt
GET /api/posts/12132/comments/challenge/read?comment_request_token=<token>
GET /api/posts/12132/comments?comment_request_token=<token>&comment_challenge_token=<challenge>&comment_challenge_solution=<solution>&page=<page>
```

Only these query parameters are accepted:

| Parameter | Required | Description |
| --- | --- | --- |
| `comment_request_token` | yes | Per-target Preview Data token: `comments.request_token` |
| `comment_challenge_token` | yes | Token from `/comments/challenge/read` |
| `comment_challenge_solution` | yes | PoW solution for that challenge |
| `page` | no | Positive integer; defaults to `1` |

Pagination, ordering, and moderation come from D1 settings. Missing or malformed
request-token/PoW inputs return `403`. Valid-looking inputs still require valid
signatures, target scope, expiry, and PoW; optional read limits apply to cache
hits and forged signatures.

A successful read returns:

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

`created_at_iso` is UTC RFC 3339 at second precision (`YYYY-MM-DDTHH:mm:ssZ`).
`author_kind` is `guest`, `site_user`, or `authenticated_user`. Only trusted
server-side writers create `site_user` comments; public writes require verified
Supabase identity to become `authenticated_user`. Imported comments without a
trusted identity remain guests. Private identity fields and email are not returned.

Pagination selects root threads and includes all their descendants. Roots use
the configured creation-time order, with public ID as the tie-breaker; replies
use ascending creation-time/public-ID order.
`total_pages` counts root pages; `total_comments` counts all approved comments
for the target. Missing/self parents become roots, cycles are cut deterministically,
and an 11th-level comment starts a new root. Repairs affect responses only. See
[ADR 0001](../decisions/0001-comment-thread-pagination.md) for the design limits.

`content_text` preserves Unicode and joined emoji. Normalization converts CRLF/CR
to LF, removes C0/C1 controls except LF/tab, converts tabs to spaces, trims the
content and whitespace around line breaks, and limits consecutive breaks to two.
The normalized result must contain 1–5,000 UTF-16 code units. Render it as text.

Imported WordPress HTML is converted to plain text, with character entities
decoded once and paragraph/list breaks preserved. Comments, scripts, styles,
and template contents are omitted. Text such as `&lt;code&gt;` becomes literal
`<code>` text; `content_text` is not HTML-safe markup. Use `textContent` or your
framework's escaped text rendering.

## Create a comment

`POST /api/posts/<public_post_id>/comments` accepts a JSON body up to `64 KiB`.
In the default `pow` mode:

```json
{
  "parent_id": null,
  "author_name": "Alice",
  "author_email": "alice@example.com",
  "content_text": "Comment body",
  "comment_request_token": "<target-request-token>",
  "comment_challenge_token": "c3.payload.signature",
  "comment_challenge_solution": "12345"
}
```

In `turnstile` mode, replace `comment_challenge_token` and
`comment_challenge_solution` with `turnstile_token`. Keep `comment_request_token`.
`parent_id` may be omitted or `null` for a root; replies require the positive
integer ID of an existing approved comment on the same target.

Guests must supply `author_email`. With optional Supabase authentication enabled,
`author_email` may be omitted when sending an access token in the header:

```http
Authorization: Bearer <supabase-access-token>
Content-Type: application/json
```

`author_name` remains user-authored; Edge derives the stored email from the
verified JWT and rejects client-supplied internal identity fields. Invalid,
expired, anonymous-user, service-role, or wrong-project Bearer credentials return
`401`, without falling back to a guest write. An account without usable email
returns `403`; verifier unavailability returns `503`. No Authorization header
uses guest behavior.

Authentication changes attribution only. Request tokens, PoW/Turnstile,
moderation, and IP limits still apply. When `COMMENT_WRITE_RATE_LIMITER` is bound,
authenticated writes also consume a pseudonymous identity quota.

Successful writes return `201 Created`:

```json
{
  "success": true,
  "data": {
    "publication": "published"
  }
}
```

`publication` is `published` or `pending_moderation`. The response does not return
the comment or its ID.

## Request token

Studio generates the target's token into Preview Data as `comments.request_token`.
Send it in the query on reads and challenge requests, or in the body on writes.
Treat the token as opaque; Studio manages its keys separately from Worker Secrets.
Missing or invalid request-key configuration returns `INVALID_COMMENT_REQUEST_TOKEN`.

Tokens are bound to target type, public ID, and target incarnation. Deleting and
recreating a Post/Page invalidates its previous token, even if the public ID is
reused. Generate fresh Preview Data after such changes.

## Verification discovery

`/comments/challenge/read` always issues a read PoW challenge, regardless of
write-verification mode or visitor authentication. Include the target request
token in its query. Its response is flat under `data.item`:

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

Read challenges last `300` seconds and can be reused for page navigation until
expiry. Use the [PoW calculation](common.md#public-write-verification) and send
its decimal result as `comment_challenge_solution`.

`/comments/challenge/write` also requires the target request token. It follows
the shared write-discovery structure: `mode`, `scope: "write"`, and either `pow`
or `turnstile`. PoW uses `zp-comment-pow-v1`; Turnstile uses action
`comment_create`. The request token does not sign the challenge;
`EDGE_TOKEN_SIGNING_SECRET` signs read and PoW write challenges.

## Optional Supabase authentication

Discover browser configuration from the Edge origin:

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

When authentication is disabled, `data` contains only `{ "enabled": false }`,
even if settings retain a project/key pair. Invalid or unreadable settings return
`503`. Discovery is behind `COMMENTS_ENABLED` and uses its own read-rate counter.

Configure authentication in `edge_comment_settings` through Studio:

| Column | Seed | Contract |
| --- | --- | --- |
| `auth_enabled` | `0` | Enables optional authentication; guests remain supported |
| `supabase_project_url` | `NULL` | HTTPS origin, or HTTP loopback origin for local development |
| `supabase_publishable_key` | `NULL` | Trimmed `sb_publishable_` browser key |

The URL and key must both be null or both valid. Enabling authentication requires
the complete pair. HTTP is allowed only for `localhost`, `127.0.0.1`, and `[::1]`.

Edge accepts asymmetric Supabase access tokens signed with `ES256` or `RS256`,
with the configured issuer `<project_url>/auth/v1`, `authenticated` audience and
role, expiry, and subject claims. Shared JWT secrets and service-role keys are
unsupported.

## Runtime defaults

Comment policy comes from `EDGE_DB.edge_comment_settings`. Missing settings use:

| Setting key | Default |
| --- | --- |
| `comments_enabled` | `true` |
| `api_base_url` | `null` |
| `require_approval` | `true` |
| `per_page` | `50` |
| `sort_order` | `desc` |
| `thread_comments` | `true` |
| `thread_comments_depth` | `2` |

`per_page` accepts 1–100 root threads. Write depth `2` allows direct replies to
roots only; it is separate from response repair depth.

Studio exposes the comment policy as `comments.enabled`, but emits
`site.comments` only after `api_base_url` is configured. A missing or malformed
API base keeps reads, writes, and challenges unavailable even for a published,
commentable target. Configure the API base and request-security state in Studio
before rebuilding Preview Data.

## Error codes

Also see [shared errors](common.md#shared-errors).

| Code | Status | Cause |
| --- | --- | --- |
| `INVALID_COMMENT_TARGET_ID` | `400` | The Post/Page target path segment is not a positive integer. |
| `INVALID_PAGE` | `400` | `page` is present but is not a positive integer. |
| `INVALID_COMMENT_CHALLENGE_SCOPE` | `400` | The challenge `:scope` is not `read` or `write`. |
| `MISSING_COMMENT_REQUEST_TOKEN` | `403` | A valid target request omitted its request token. |
| `INVALID_COMMENT_REQUEST_TOKEN` | `403` | The token or request-secret configuration is invalid. |
| `INVALID_COMMENT_AUTH_TOKEN` | `401` | Explicit Bearer credentials are invalid for the configured project. |
| `UNSUPPORTED_COMMENT_AUTH_TOKEN_ALGORITHM` | `401` | Bearer credentials do not use `ES256` or `RS256`. |
| `COMMENT_AUTH_NOT_ENABLED` | `401` | Bearer credentials were supplied while authentication is disabled. |
| `COMMENT_AUTH_EMAIL_NOT_AVAILABLE` | `403` | The verified account has no usable email claim. |
| `COMMENT_AUTH_SETTINGS_NOT_AVAILABLE` | `503` | Supabase settings are unavailable or invalid. |
| `COMMENT_AUTH_VERIFICATION_NOT_AVAILABLE` | `503` | JWKS retrieval or local verification is unavailable. |
| `MISSING_COMMENT_CHALLENGE` | `403` | A required read or `pow`-mode write challenge field is omitted. |
| `INVALID_COMMENT_CHALLENGE` | `403` | The challenge is malformed, mismatched, or its solution is insufficient. |
| `EXPIRED_COMMENT_CHALLENGE` | `403` | The challenge expired. |
| `COMMENT_CHALLENGE_NOT_AVAILABLE` | `503` | The challenge-signing secret is unavailable or too short. |
| `COMMENT_CHALLENGE_ALREADY_USED` | `403` | A PoW write challenge was already consumed. |
| `COMMENT_IP_HASH_NOT_AVAILABLE` | `503` | The IP-pseudonymization secret is unavailable or too short. |
| `COMMENTS_NOT_FOUND` | `404` | The API base or a published, commentable target is unavailable. |
| `COMMENTS_DISABLED` | `403` | The D1 comment policy is disabled. |
