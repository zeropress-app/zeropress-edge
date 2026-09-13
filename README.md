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
resources, deploy the Worker, initialize Studio, and enable the selected APIs.

The guide covers both fresh installations and existing Edge databases. Studio
provides database installation and maintenance; deploying the Worker does not
initialize the database.

## Documentation

| Document | Use it for |
| --- | --- |
| [Configuration](docs/configuration.md) | Wrangler configuration, bindings, variables, secrets, and runtime settings |
| [Common API rules](docs/api/common.md) | Response format, CORS, write verification, rate limits, and shared errors |
| [Comments API](docs/api/comments.md) | Reading and posting comments, request tokens, and visitor authentication |
| [Newsletter API](docs/api/newsletters.md) | Signup, confirmation, unsubscribe, and delivery behavior |
| [Forms API](docs/api/forms.md) | Field definitions, submissions, and notifications |
| [Database artifacts](database/README.md) | Schema contracts and supported lifecycle operations |
| [Comment pagination decision](docs/decisions/0001-comment-thread-pagination.md) | Thread pagination design and its limits |

## Development

Use Node.js 22.22.0 or newer and npm. From the Edge repository:

```sh
npm ci
npm test
npm run typecheck
npm run build
```

`build` is a Wrangler dry run using [`wrangler.jsonc`](wrangler.jsonc).

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the Worker locally using `wrangler.jsonc` |
| `npm run test:sql` | Test repositories against in-memory SQLite |
| `npm run test:runtime` | Test the Worker with disposable local D1, KV, and Queue resources |

Runtime tests require a local process and loopback server.

`npm run dev` initializes local variables and secrets when needed. See the
[configuration reference](docs/configuration.md#worker-variables-and-secrets)
for local defaults and deployed settings.

## Related projects

- [ZeroPress Studio](https://github.com/zeropress-app/zeropress-studio) manages
  content, Edge settings, database operations, and mail delivery.
- [ZeroPress Build](https://github.com/zeropress-app/zeropress-build) generates
  the static site that calls Edge's APIs.

## Security

Report vulnerabilities privately using the [security policy](SECURITY.md).

## License

[Apache License 2.0](LICENSE).
