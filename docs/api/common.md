# Common API rules

The [Comments](comments.md), [Newsletter](newsletters.md), and [Forms](forms.md)
references define feature-specific requests and responses. Bindings, variables,
and secrets are listed in [Configuration](../configuration.md).

## HTTP behavior

Feature routes require their deployment gate to be exact `true`. Disabled
features return an empty `404`; Newsletter unsubscribe remains available when
its gate is absent or `false`. Global maintenance returns `503 EDGE_MAINTENANCE`
for recognized public routes, including unsubscribe. CORS preflight remains
available during maintenance. Invalid gate values return
`503 EDGE_CONFIGURATION_ERROR` for non-OPTIONS requests.

Enabled routes require a current, `ready` Edge database. Missing, malformed,
incompatible, or transitioning schema state returns
`503 EDGE_DATABASE_NOT_AVAILABLE`. See the [database lifecycle](../../database/README.md).

Recognized module prefixes are `/api/comments/`, `/api/posts/`, `/api/pages/`,
`/api/newsletters/`, and `/api/forms/`. Unknown paths outside these prefixes,
including `GET /`, return an empty `404`. Errors within recognized modules use
the JSON envelope below.

Same-origin requests and requests without an `Origin` header are allowed.
Other cross-origin requests require an exact match in
[`ALLOWED_ORIGINS`](../configuration.md#worker-variables-and-secrets).
Test browser access with the public site's Origin; a request without that
header does not test CORS.

Success responses use:

```json
{
  "success": true,
  "data": {}
}
```

Structured errors use:

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

JSON endpoints require `Content-Type: application/json`. Each feature reference
specifies its accepted fields, query parameters, and UTF-8 body-size limits.

## Public write verification

Each feature independently selects `pow` or `turnstile` through Studio's
[Edge Security settings](../configuration.md#runtime-settings). The default is
`pow`. There is no combined mode or automatic fallback when verification is
unavailable. Comment reads use a separate [read PoW contract](comments.md#verification-discovery).

Before a write, call that feature's challenge endpoint and follow the returned
`data.item.mode`. A `pow` response has this structure, shown for Forms:

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

For `turnstile`, the same endpoint returns:

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

The feature-specific values are:

| Feature | Scope | PoW algorithm | PoW token / solution body fields | Turnstile action |
| --- | --- | --- | --- | --- |
| Comments | `write` | `zp-comment-pow-v1` | `comment_challenge_token` / `comment_challenge_solution` | `comment_create` |
| Newsletter | `subscribe` | `zp-newsletter-pow-v1` | `newsletter_challenge_token` / `newsletter_challenge_solution` | `newsletter_subscribe` |
| Forms | `submit` | `zp-form-pow-v1` | `form_challenge_token` / `form_challenge_solution` | `form_submit` |

For PoW, find a decimal solution whose digest has at least `difficulty` leading
zero bits:

```txt
sha256(challenge_token + "." + solution)
```

Write challenges currently use difficulty `15`, expire after `60` seconds, and
are intended for one submission. Send the returned token and solution under the
feature's field names. The challenge is bound to its target or slug. A consumed
write challenge has a soft replay guard in KV; KV's eventual consistency or
unavailability can weaken duplicate-submit protection.

For Turnstile, load Cloudflare's official widget script only after discovery
selects that mode, using the returned site key and action. Submit
`turnstile_token` instead of both PoW fields. Edge checks the token with
Siteverify and requires the verified action and hostname to match the endpoint
and request Origin. Turnstile tokens are single-use and do not use KV markers.
Missing site-key/secret configuration returns `TURNSTILE_NOT_AVAILABLE`.

Supplying fields from the other mode returns `422 VALIDATION_ERROR`. Comment
writes also require their target request token, regardless of verification mode
or visitor authentication. Newsletter email confirmation uses its own token.

Form and Newsletter metadata reads do not require PoW or Turnstile. They use
the feature gates, CORS policy, and optional read rate limiters. Obtain and solve
write verification only when the visitor submits, after checking availability.

## Rate limits

Optional feature limiters return `429 RATE_LIMITED` when a quota is exceeded and
`503 RATE_LIMIT_NOT_AVAILABLE` when a configured limiter fails. Omitting a
limiter removes that operation's Worker quota while retaining other validation.

Client IP comes from `CF-Connecting-IP`; a missing value shares the `unknown`
bucket. `X-Forwarded-For` is not used. IP-based limits can affect visitors behind
a shared address. Supplied comment and newsletter read limits are 120 requests
per 60 seconds per key within a Cloudflare location.

Shared read bindings keep these counters independent:

| Binding | Separate per-IP counters |
| --- | --- |
| `COMMENT_READ_RATE_LIMITER` | Post/Page comment reads; authentication discovery |
| `NEWSLETTER_READ_RATE_LIMITER` | Metadata; confirmation; unsubscribe |

Changing newsletter slug or token does not reset confirmation or unsubscribe
quota. The unsubscribe limiter also applies while signup is disabled.
Authenticated comment writes consume both IP and identity quotas when their
write limiter is bound.

Malformed JSON and invalid common write fields do not consume feature quota;
invalid verification attempts do. OPTIONS and early feature/maintenance gate
responses do not consume feature quota. The optional
`TURNSTILE_VERIFY_RATE_LIMITER` applies per action and IP after the feature write
limiter and has the distinct errors listed below.

## Caching

Approved comment reads and successful Newsletter/Form metadata reads are cached
for 300 seconds in `EDGE_KV`. D1 remains authoritative. Missing or failing KV
falls back to D1 for those reads; failed cache updates are skipped. Comment read
limits still apply to cache hits. Missing KV also weakens the PoW replay guard
described above.

Form and Newsletter activation is checked before cached metadata is returned.
Newsletter signup availability is also refreshed on each read; it is not cached
with the field definitions.

## Shared errors

Feature-specific errors and body-size limits appear in each API reference.

| Code | Status | Cause |
| --- | --- | --- |
| `MISSING_QUERY` | `400` | A required query parameter is missing. |
| `UNSUPPORTED_QUERY` | `400` | An unknown or duplicate query parameter was supplied. |
| `UNSUPPORTED_MEDIA_TYPE` | `415` | The endpoint requires `application/json`. |
| `INVALID_JSON` | `400` | The body is not valid JSON. |
| `REQUEST_BODY_TOO_LARGE` | `413` | The endpoint's UTF-8 body limit was exceeded. |
| `VALIDATION_ERROR` | `422` | Request fields are missing, unsupported, or invalid. |
| `EDGE_CONFIGURATION_ERROR` | `503` | A deployment gate has an invalid value. |
| `EDGE_MAINTENANCE` | `503` | Public APIs are paused. |
| `EDGE_DATABASE_NOT_AVAILABLE` | `503` | The database schema or lifecycle state is unavailable or incompatible. |
| `EDGE_RUNTIME_SETTINGS_NOT_AVAILABLE` | `503` | Required runtime settings are missing, unreadable, or invalid. |
| `TURNSTILE_NOT_AVAILABLE` | `503` | The site key or Worker secret is unavailable. |
| `INVALID_TURNSTILE_TOKEN` | `403` | The token is invalid, reused, expired, or mismatched. |
| `INVALID_TURNSTILE_ORIGIN` | `403` | The request has no single verifiable HTTP(S) Origin. |
| `TURNSTILE_VERIFY_RATE_LIMITED` | `429` | The optional Siteverify limiter rejected the attempt. |
| `TURNSTILE_VERIFY_RATE_LIMIT_NOT_AVAILABLE` | `503` | The optional Siteverify limiter failed. |
| `TURNSTILE_VERIFICATION_NOT_AVAILABLE` | `503` | Siteverify or its configuration is unavailable. |
| `RATE_LIMITED` | `429` | A feature limiter rejected the request. |
| `RATE_LIMIT_NOT_AVAILABLE` | `503` | A configured feature limiter failed. |
| `CORS_ORIGIN_DENIED` | `403` | The request Origin is not permitted. |
| `METHOD_NOT_ALLOWED` | `405` | The HTTP method is unsupported. |
| `NOT_FOUND` | `404` | A route does not exist within a recognized module. |
| `INTERNAL_ERROR` | `500` | An unexpected server-side failure occurred. |
