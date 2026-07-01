# TinyFeed

TinyFeed is the Feed v1 client app. It signs the reader in with OpenKey and
talks to the separate Feed Host API for projections, artifact hydration,
feedback, and control intents.

The previous direct-SQL TinyFeed app is archived in `web/legacy-src` with its
old docs in `README.legacy.md`.

## Runtime

Set these Vite variables for local development or deployment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_FEED_HOST_URL` | `https://api.feed.tinycloud.xyz` | Feed Host API base URL. |
| `VITE_FEED_HOST_TOKEN` | unset | Optional bearer token for protected Feed Host installs. |
| `VITE_OPENKEY_HOST` | `https://openkey.so` | OpenKey sign-in host. |
| `VITE_TINYCLOUD_HOST` | `https://node.tinycloud.xyz` | TinyCloud node used for the OpenKey-backed session. |

The app does not read or bootstrap TinyCloud SQL directly. Feed v1 schema
resources live in Artifactory and are applied by the Feed Host path.

## Local Feed Host

Run the TinyCloud-backed Feed Host and app in separate terminals:

```sh
bun run host
bun run dev:local
```

The host listens on `http://127.0.0.1:8787` by default. After the app submits
the actor's Feed Host delegation set, the host activates those delegations with
TinyCloud, applies the Artifactory Feed v1 `tinycloud.sql/schema` migrations to
the actor's TinyCloud SQL resources, writes seeded artifact documents to
TinyCloud KV, and serves the API the app expects:

```text
GET  /feed
GET  /artifacts/:id
GET  /artifacts/:id/provenance
POST /feedback
POST /control-intents
POST /admin/seed
```

The app does not treat OpenKey sign-in as Feed Host authority. On startup it
fetches `GET /delegation-policy`, includes the Feed Host delegate DID/resources
in the TinyCloud manifest before sign-in, creates portable delegations with
`space("default").delegations.create(...)`, and submits them with `POST
/delegations`. Feed reads, artifact hydration, feedback, and control intents are
rejected until the host has accepted the complete Feed v1 SQL/KV delegation set
for the actor.

For local development, the Feed Host can use a generated session DID. Hosted
deployments should set `FEED_HOST_PRIVATE_KEY` so the delegate DID is stable
across restarts and users do not have to re-mint delegations unexpectedly.

## Commands

```sh
bun install
bun run host
bun run dev:local
bun run dev:vite
bun run typecheck
bun test web/src host
bun run test:smoke
bun run build
```

`bun run test:smoke` starts both the local Feed Host and Vite app, then runs the
OpenKey external-wallet flow with an injected Ethereum test key, matching the
Secret Manager E2E approach. The test signs in, mints/submits Feed Host
delegations, hydrates the seeded feed item, posts feedback, and persists an Ask
Feed control intent.
