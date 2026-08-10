# Newsletter API

Newsletter metadata, double-opt-in signup, confirmation, and unsubscribe.
See [common API rules](common.md) for CORS, envelopes, verification, and shared errors.

## Endpoints

```txt
GET  /api/newsletters/<slug>
GET  /api/newsletters/<slug>/challenge/subscribe
POST /api/newsletters/<slug>/subscriptions
POST /api/newsletters/<slug>/subscriptions/confirm
POST /api/newsletters/<slug>/subscriptions/unsubscribe
```

`NEWSLETTER_ENABLED` must be exact `true` for metadata, discovery, signup, and
confirmation. Unsubscribe remains available when the gate is absent or `false`,
but global maintenance still blocks it.

## Read newsletter metadata

`GET /api/newsletters/<slug>` returns an active newsletter and its active custom fields:

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

The seed creates an active email-only `default` newsletter. `fields` stays empty
until Studio adds definitions. Metadata follows the shared [caching rules](common.md#caching).

## Subscribe

`POST /api/newsletters/<slug>/subscriptions` accepts JSON up to `256 KiB`.
For the default newsletter in `pow` mode:

```json
{
  "email": "alice@example.com",
  "source_url": "https://example.com/newsletter_zeropress.html",
  "newsletter_challenge_token": "n1.payload.signature",
  "newsletter_challenge_solution": "12345"
}
```

In `turnstile` mode, replace both challenge fields with `turnstile_token`.
An optional `fields` object maps configured field keys to their submitted values.
Unknown keys are rejected, required fields must be present, and values must
match each field's type and options.

`source_url` is required: an absolute HTTP(S) URL from the request Origin or
`ALLOWED_ORIGINS`. Edge removes its fragment before use. Option values and labels,
including submitted select/radio/checkbox values, are limited to 120 characters.
A required checkbox must contain at least one value. File, image, and HTML inputs
are unsupported.

Signup is double opt-in only. Successful requests return `202 Accepted`:

```json
{
  "success": true,
  "data": {
    "status": "accepted"
  }
}
```

Already subscribed addresses receive the same response without another email.

### Recipient confirmation quota

A trimmed, lowercase email address shares one confirmation quota across all
newsletters in the same Edge database: at least five minutes between reservations
and at most five reservations in the preceding 24 hours, including first signup.
Changing IP or newsletter slug does not create another allowance.

Queued, sent, failed, and skipped confirmation deliveries count. Enqueue failures
consume a reservation; retries of the same delivery and Form notifications do
not. Retain at least 24 hours of confirmation history in `newsletter_deliveries`.

Over-quota requests return the same generic `202 accepted`, queue no mail, and
provide no retry or remaining-count information. They preserve the existing
confirmation token, expiry, submitted fields, source URL, and timestamps without
extending the cooldown. Concurrent requests cannot reserve the same remaining
allowance.

## Subscription verification

Call `GET /api/newsletters/<slug>/challenge/subscribe` before signup. It follows
[common write verification](common.md#public-write-verification), with scope
`subscribe`, PoW algorithm `zp-newsletter-pow-v1`, and Turnstile action
`newsletter_subscribe`. `NEWSLETTER_CHALLENGE_RATE_LIMITER` and
`NEWSLETTER_SUBSCRIBE_RATE_LIMITER` separately limit discovery and signup.

## Confirm a subscription

Confirmation email links return to the client page with a fragment token:

```txt
https://example.com/newsletter_zeropress.html#confirm_token=<token>
```

Present an explicit confirmation UI, then send JSON to
`POST /api/newsletters/<slug>/subscriptions/confirm`:

```json
{ "token": "nc1.payload.signature" }
```

The body limit is `8 KiB`. A `GET` request with a query token returns
`405 METHOD_NOT_ALLOWED` without changing subscription state. Confirmation has a
separate per-IP read-limit counter from metadata, signup, and unsubscribe.

Tokens are bound to their newsletter and must match the pending subscription.
Malformed, expired, wrong-newsletter, and previously processed tokens are rejected.
An admitted resend invalidates the earlier link; a quota-blocked resend preserves
it. Confirmation consumes the token once.

## Unsubscribe

Newsletter emails link to the client page with an opaque fragment token:

```txt
https://example.com/newsletter_zeropress.html#unsubscribe_token=nu1.<token>
```

Present an explicit confirmation UI, then send JSON to
`POST /api/newsletters/<slug>/subscriptions/unsubscribe`:

```json
{ "token": "nu1.<token>" }
```

The body limit is `8 KiB`. Unsubscribe is idempotent and returns the same success
response when no current subscription is selected. It clears pending confirmation
state when applicable. Its per-IP limiter also applies while signup is disabled;
quota rejection returns `429 RATE_LIMITED` without processing the token.

## Confirmation email delivery

Edge stores the pending subscription and delivery reservation, then queues
`newsletter.confirmation`. Studio sends the email and tracks queued, sent,
failed, or skipped delivery state. See the
[mail queue contract](../configuration.md#mail-queue-contract).

Studio updates `edge_mail_settings.newsletter_confirmation_enabled` when mail
settings are saved. If it is disabled or `MAIL_QUEUE` is absent, signup fails
with `NEWSLETTER_EMAIL_NOT_AVAILABLE`, including already subscribed recipients.
A runtime enqueue failure is recorded while the public response remains generic
`accepted` to avoid exposing subscription state.

## Error codes

Also see [shared errors](common.md#shared-errors).

| Code | Status | Cause |
| --- | --- | --- |
| `INVALID_NEWSLETTER_SLUG` | `400` | The `:slug` path segment is not a lowercase URL slug. |
| `INVALID_NEWSLETTER_CHALLENGE_SCOPE` | `400` | The challenge `:scope` is not `subscribe`. |
| `NEWSLETTER_NOT_FOUND` | `404` | The newsletter does not exist or is inactive. |
| `MISSING_NEWSLETTER_CHALLENGE` | `403` | A required `pow` challenge field is omitted. |
| `INVALID_NEWSLETTER_CHALLENGE` | `403` | The challenge is malformed, mismatched, or its solution is insufficient. |
| `EXPIRED_NEWSLETTER_CHALLENGE` | `403` | The challenge expired. |
| `NEWSLETTER_CHALLENGE_NOT_AVAILABLE` | `503` | The challenge-signing secret is unavailable or too short. |
| `NEWSLETTER_CHALLENGE_ALREADY_USED` | `403` | A PoW challenge was already consumed. |
| `NEWSLETTER_IP_HASH_NOT_AVAILABLE` | `503` | The IP-pseudonymization secret is unavailable or too short. |
| `INVALID_NEWSLETTER_CONFIRMATION_TOKEN` | `400` | The confirmation token is malformed, unknown, processed, or mismatched. |
| `EXPIRED_NEWSLETTER_CONFIRMATION_TOKEN` | `410` | The confirmation token expired. |
| `NEWSLETTER_CONFIRMATION_NOT_AVAILABLE` | `503` | Confirmation-token verification is unavailable. |
| `INVALID_NEWSLETTER_UNSUBSCRIBE_TOKEN` | `400` | The unsubscribe token is malformed. |
| `NEWSLETTER_SUPPRESSED` | `403` | The email address is globally suppressed. |
| `NEWSLETTER_EMAIL_NOT_AVAILABLE` | `503` | Confirmation email cannot currently be queued. |
