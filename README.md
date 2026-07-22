# TinyFeed

TinyFeed is the Feed v1 client app. It signs the reader in with OpenKey and
talks to the separate Feed Host API for projections, artifact hydration,
feedback, and control intents.

Feed ranks and renders `FeedItemProjection` rows. A Feed item targets either a
`FeedPost` inside a rich artifact or a legacy artifact preview; opening a post
hydrates the shared artifact and can focus its referenced section. Feedback
targets an artifact, post, or feed item explicitly, so two posts from one
artifact can be shaped independently without losing the artifact link.

The previous direct-SQL TinyFeed app is archived in `web/legacy-src` with its
old docs in `README.legacy.md`.

## Runtime

Set these Vite variables for local development or deployment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_FEED_HOST_URL` | `https://api.feed.tinycloud.xyz` | Feed Host API base URL. |
| `VITE_FEED_HOST_TOKEN` | unset | Optional install-level bearer token for protected Feed Host installs. Actor sessions use separate HttpOnly cookies issued automatically after delegation. |
| `FEED_HOST_STATE_DIR` | unset | Private directory for a generated, persistent Feed Host identity. Production containers should mount a named volume here. |
| `FEED_HOST_PRIVATE_KEY` | unset | Explicit Feed Host identity override. Prefer `FEED_HOST_STATE_DIR` for deployments that can persist a private volume. |
| `FEED_HOST_ALLOWED_ORIGINS` | unset | Comma-separated exact browser origins. Required when the web client and Host use different origins because actor sessions use credentialed CORS. |
| `FEED_PROACTIVE_ACTOR_ID` | unset | Opt-in kill switch for Host-side daily generation. Set one delegated actor DID to ensure one unscoped request per UTC day; unset is inert. |
| `VITE_OPENKEY_HOST` | `https://openkey.so` | OpenKey sign-in host. |
| `VITE_TINYCLOUD_HOST` | `https://node.tinycloud.xyz` | TinyCloud node used for the OpenKey-backed session. |

The app does not read or bootstrap TinyCloud SQL directly. Feed v1 schema
resources live in Artifactory and are applied by the Feed Host path.

## Local Feed Host

Run the TinyCloud-backed Feed Host and app in separate terminals:

```sh
FEED_HOST_ALLOWED_ORIGINS=http://127.0.0.1:5173 \
FEED_HOST_STATE_DIR=.local/feed-host \
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
GET  /input-authorities
POST /input-authorities
GET  /input-authorities/:sourceId/status
POST /input-authorities/:sourceId/revoke
DELETE /input-authorities/:sourceId
POST /admin/seed
```

## Local Feed with Portless

Portless gives the two-process development stack stable HTTPS names:

- `https://feed.localhost` — Vite web app;
- `https://api.feed.localhost` — Feed Host.

Install Portless globally once, then start and trust its local HTTPS proxy:

```sh
npm install -g portless
portless proxy start
portless trust
```

Register fixed aliases for Feed's documented development ports. `--force`
intentionally moves an existing alias from another worktree to this stack:

```sh
portless alias api.feed 8787 --force
portless alias feed 5173 --force
```

Start Feed Host in the first terminal:

```sh
FEED_HOST_ALLOWED_ORIGINS=https://feed.localhost,http://127.0.0.1:5173 \
FEED_HOST_STATE_DIR=.local/feed-host \
bun run host
```

Start Vite in the second terminal. The browser must use the HTTPS Host URL to
avoid mixed-content blocking:

```sh
VITE_FEED_HOST_URL=https://api.feed.localhost \
bun run dev:vite --host 127.0.0.1 --port 5173
```

Verify and open the stack:

```sh
curl -fsS https://api.feed.localhost/health
open https://feed.localhost
portless list
```

`FEED_HOST_STATE_DIR` preserves the local Host key and delegate DID across
restarts. Deleting `.local/feed-host` creates a new Host identity, so an
existing browser session may need to sign in again for the new delegate.

`bun run dev` also launches Vite through Portless, but Portless normally adds a
branch/worktree prefix to dynamically managed routes. Use the fixed aliases
above when collaborators need the exact `feed.localhost` and
`api.feed.localhost` URLs.

Safari can require an explicit hosts-file refresh:

```sh
portless hosts sync
```

If 8787 or 5173 is already occupied, select another pair and update both the
process and alias together. For example:

```sh
portless alias api.feed 8877 --force
portless alias feed 5273 --force

FEED_HOST_PORT=8877 \
FEED_HOST_ALLOWED_ORIGINS=https://feed.localhost \
FEED_HOST_STATE_DIR=.local/feed-host \
bun run host

VITE_FEED_HOST_URL=https://api.feed.localhost \
bun run dev:vite --host 127.0.0.1 --port 5273
```

Stop the Host and Vite processes with `Ctrl-C`. Static aliases can remain for
the next run, or be removed explicitly:

```sh
portless alias --remove feed
portless alias --remove api.feed
```

The Playwright smoke suite starts its own Host and Vite processes. Keep the live
stack running by assigning the smoke suite different ports:

```sh
FEED_SMOKE_HOST_PORT=8897 \
FEED_SMOKE_WEB_PORT=4299 \
bun run test:smoke
```

Named input authorities are separate from the Feed Host output delegation.
The browser attenuates a received `tc1` share with
`sharing.delegateReceivedShare(...)`; raw share links, embedded private JWKs,
and parent bearers never leave the browser. Feed Host stores only the child
portable delegation and non-secret source lineage (host, owner space, path,
read actions, expiry, parent CID chain, and agent DID). Deploying this flow
requires publishing the approved web/node SDK sharing changeset from
`js-sdk-feed-share` and then updating Feed's `@tinycloud/web-sdk` and
`@tinycloud/node-sdk` package versions. Older SDKs show an explicit
"SDK update required" compatibility error; Feed does not implement a second
delegation or crypto path.

The app does not treat OpenKey sign-in as Feed Host authority. On startup it
fetches `GET /delegation-policy`, includes the Feed Host delegate DID/resources
in the TinyCloud manifest before sign-in, silently materializes a portable
delegation, and submits it with `POST /api/delegations`. The Host derives the
actor from that signed delegation and establishes an opaque HttpOnly session
cookie. Private routes derive the actor from the session and reject a
caller-supplied actor without it.

For local development, the Feed Host can use a generated session DID. Hosted
deployments should mount a private named volume at `FEED_HOST_STATE_DIR`, or set
`FEED_HOST_PRIVATE_KEY` through the deployment secret store. With a stable key
the host signs into its own TinyCloud space at
startup, so the delegate DID is the stable `did:pkh` identity, and every
accepted delegation is persisted to the host's own TinyCloud KV space under
`delegations/{actorId}`. After a restart the host reactivates persisted
delegations lazily on the actor's first request (pruning expired ones), so
actors keep working without re-submitting delegations. Without a key the host
keeps its generated session DID and accepted delegations live in memory only.

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
Feed control intent. Set `FEED_SMOKE_HOST_PORT` / `FEED_SMOKE_WEB_PORT` to run
the smoke stack on alternate ports when the defaults (8787/4199) are held by
live dev services.
