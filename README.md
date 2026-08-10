# ZeroPress Edge

ZeroPress Edge provides public APIs for ZeroPress static sites. It runs as a
Cloudflare Worker; ZeroPress Studio manages its data, settings, moderation,
and mail delivery.

> Edge is beta software. Use a Studio release with compatible database and
> mail queue contracts.

## Features

- Threaded comments for published Posts and Pages, with moderation and optional
  Supabase visitor authentication.
- Newsletter signup, email confirmation, and unsubscribe.
- Public form definitions and submissions, with optional email notifications.

Public writes use proof-of-work or Cloudflare Turnstile verification, selected
per feature in Studio. Edge uses D1 for runtime data, optional KV caching, and
a shared Queue for mail delivery through Studio.

## Getting started

Follow the [installation guide](docs/getting-started.md) to connect Cloudflare
resources, prepare the Worker configuration, initialize Studio, and enable the
selected APIs. Node.js 22.22.0 or newer and npm are required.

The guide covers both fresh installations and existing Edge databases. Studio
provides database installation and maintenance; deploying the Worker does not
initialize the database.

## Documentation

| Document | Use it for |
| --- | --- |
| [Configuration](docs/configuration.md) | Wrangler overrides, bindings, variables, secrets, and runtime settings |
| [Common API rules](docs/api/common.md) | Response format, CORS, write verification, rate limits, and shared errors |
| [Comments API](docs/api/comments.md) | Reading and posting comments, request tokens, and visitor authentication |
| [Newsletter API](docs/api/newsletters.md) | Signup, confirmation, unsubscribe, and delivery behavior |
| [Forms API](docs/api/forms.md) | Field definitions, submissions, and notifications |
| [Database artifacts](database/README.md) | Schema contracts and supported lifecycle operations |
| [Comment pagination decision](docs/decisions/0001-comment-thread-pagination.md) | Thread pagination design and its limits |

## Development

From the Edge repository:

```sh
npm ci
npm test
npm run typecheck
npm run build
```

`build` is a Wrangler dry run. If the default `wrangler.override.jsonc` is
missing, it is created from the example and validation stops until you fill in
the installation values. See [configuration](docs/configuration.md#wrangler-configuration).

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run locally using the installation configuration |
| `npm run dev:enable-remote` | Run with bindings explicitly configured as remote |
| `npm run test:sql` | Test repositories against in-memory SQLite |
| `npm run test:runtime` | Test the Worker with disposable local D1, KV, and Queue resources |

Runtime tests require a local process and loopback server. Use the npm commands
for development and deployment; bare `wrangler dev` and `wrangler deploy` are
blocked. Remote development can read or change the selected Cloudflare resources.

Keep local variables and secrets in `.dev.vars` or `.env`. Remote configuration
and deployment commands are described in the [configuration reference](docs/configuration.md).

## Related projects

- [ZeroPress Studio](https://github.com/zeropress-app/zeropress-studio) manages
  content, Edge settings, database operations, and mail delivery.
- [ZeroPress Build](https://github.com/zeropress-app/zeropress-build) generates
  the static site that calls Edge's APIs.

## Security

Report vulnerabilities privately using the [security policy](SECURITY.md).

## License

[Apache License 2.0](LICENSE).
