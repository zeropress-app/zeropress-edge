# Forms API

Public form definitions and submissions. `FORMS_ENABLED` must be exact `true`.
See [common API rules](common.md) for CORS, envelopes, verification, and shared errors.

## Endpoints

```txt
GET  /api/forms/<slug>
GET  /api/forms/<slug>/challenge/submit
POST /api/forms/<slug>/submissions
```

## Read form metadata

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

Studio permits at most 50 fields per form. Metadata follows the shared
[caching rules](common.md#caching).

Load this endpoint before enabling the form. Keep submission disabled until
metadata loads successfully, and display a short unavailable message with a
retry action on failure. A missing or inactive form returns `404`. The submission
endpoint checks activation again if the form changes after the page loads.

## Submit a form

`POST /api/forms/<slug>/submissions` accepts JSON up to `256 KiB`. For the
email-only form above, a `pow` request is:

```json
{
  "fields": {
    "email": "alice@example.com"
  },
  "source_url": "https://example.com/contact/",
  "form_challenge_token": "f1.payload.signature",
  "form_challenge_solution": "12345"
}
```

In `turnstile` mode, replace both challenge fields with `turnstile_token`.
Unknown field keys are rejected; values must match the field's type, required
flag, and configured options.

`text` and `textarea` preserve Unicode and emoji, remove controls, and trim
surrounding whitespace. `text` converts line breaks/tabs to spaces; `textarea`
uses the [comment multiline rules](comments.md#read-comments). Limits after
normalization are 300 and 5,000 UTF-16 code units respectively. Empty normalized
values are rejected. Render these values as plain text.

Option values and labels, including submitted values, are limited to 120
characters. Select, radio, and checkbox fields support at most 50 options;
checkbox submissions also allow at most 50 values. Options use single-line text
normalization. Dates must be real calendar dates in `YYYY-MM-DD` format.
File, image, and HTML inputs are unsupported.

`source_url` is optional. Send the current page URL, rather than
`document.referrer`. It must be an absolute HTTP(S) URL from the request Origin
or `ALLOWED_ORIGINS`, without credentials; Edge removes its fragment.

Successful submissions return `202 Accepted`:

```json
{
  "success": true,
  "data": {
    "status": "accepted",
    "message": "Your submission has been received."
  }
}
```

The response does not expose row IDs or internal submission/moderation state.

## Notification delivery

When `forms.notification_recipient_user_id` is configured, Edge queues a
`form.notification` job for that Studio user after storage. Studio checks the
snapshotted recipient's current eligibility and resolves their email. It skips
sending if the recipient is no longer eligible or the provider is unavailable;
earlier submissions are not notified retroactively.

If `MAIL_QUEUE` is absent or enqueueing fails, the submission remains stored and
the response stays `202 Accepted`. See the
[mail queue contract](../configuration.md#mail-queue-contract).

## Submission verification

Call `GET /api/forms/<slug>/challenge/submit` before submitting. It follows
[common write verification](common.md#public-write-verification), with scope
`submit`, PoW algorithm `zp-form-pow-v1`, and Turnstile action `form_submit`.
`FORM_CHALLENGE_RATE_LIMITER` and `FORM_SUBMIT_RATE_LIMITER` separately limit
discovery and submissions.

## Error codes

Also see [shared errors](common.md#shared-errors).

| Code | Status | Cause |
| --- | --- | --- |
| `INVALID_FORM_SLUG` | `400` | The `:slug` path segment is not a lowercase URL slug. |
| `INVALID_FORM_CHALLENGE_SCOPE` | `400` | The challenge `:scope` is not `submit`. |
| `FORM_NOT_FOUND` | `404` | The form does not exist or is inactive. |
| `MISSING_FORM_CHALLENGE` | `403` | A required `pow` challenge field is omitted. |
| `INVALID_FORM_CHALLENGE` | `403` | The challenge is malformed, mismatched, or its solution is insufficient. |
| `EXPIRED_FORM_CHALLENGE` | `403` | The challenge expired. |
| `FORM_CHALLENGE_NOT_AVAILABLE` | `503` | The challenge-signing secret is unavailable or too short. |
| `FORM_CHALLENGE_ALREADY_USED` | `403` | A PoW challenge was already consumed. |
| `FORM_IP_HASH_NOT_AVAILABLE` | `503` | The IP-pseudonymization secret is unavailable or too short. |
