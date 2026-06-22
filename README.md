# TinyFeed

A pure-client viewer for the **`xyz.tinycloud.artifacts`** feed, plus the `tc`
recipes for exploring the **Listen** data source it is built on.

## The viewer (pure-client web app)

A Vite + React app (`web/`) that talks to TinyCloud **directly from the browser**
via the [`@tinycloud/web-sdk`](https://www.npmjs.com/package/@tinycloud/web-sdk) —
no server, no `/api`, no sessions database. It signs in as the space **owner**
(v1; scoped reader delegation comes later), reads published artifacts from the
`feed` SQL DB in the owner's `applications` space, renders compact text,
articles, podcasts, and clips, hydrates hero/audio/video media from KV, and
writes reader **interaction** events (nonce-protected) back to the
`interactions` SQL DB.

```sh
bun install
bun run dev        # Portless dev server (https://feed.localhost)
bun run dev:vite   # raw Vite fallback (http://localhost:5173)
bun run build      # static bundle -> web/dist/
bun run typecheck
```

Portless serves HTTPS by default, which OpenKey/WebAuthn needs. On first run it
may ask for sudo so it can bind port 443 and trust the local CA. To avoid sudo
for a one-off local session, run `PORTLESS_PORT=1355 bun run dev` and open
`https://feed.localhost:1355`.

### 5 pages + the agent flow

The app is a small path-routed SPA (`web/src/router.tsx`) with five routes:

| Route | Page | What it does |
| --- | --- | --- |
| `/` | **Connect** | OpenKey sign-in, then `GET /agent/info`, `delegateTo(agentDid, scopes)`, `POST /agent/delegation`. Shows delegation status/expiry + re-grant. |
| `/feed` | **Feed** | Composed artifact cards + More/Less/Save. Each card has an expanded **Data trail** with TinyCloud row metadata, producer run/delegation provenance, media KV keys, source quotes/files, and quality notes. Empty state links to `/agents`. |
| `/a/:slug` | **Artifact** | Full article detail. |
| `/agents` | **Agents** | Delegation status, re-grant/revoke, **Generate** (`POST /agent/run` → poll `GET /agent/run/:id`), run history, run media/proof summaries. |
| `/preferences` | **Preferences** | Weak-signal summary plus interaction history (the signal Artifactory reads before generation). |

The user delegates **Listen-read + artifacts-read/write** to a stable agent
`did:pkh` (`web/src/tinycloud.ts` `AGENT_SCOPES`). The broadened sign-in manifest
unions those scopes into the SIWE recap, so `delegateTo(agentDid, AGENT_SCOPES)`
derives from the session key with **no extra wallet prompt**. The agent runs the
artifact pipeline under that delegation, publishing to the user's **own**
`applications` space; the feed refreshes after a run. The agent endpoints
(`web/src/agentClient.ts`) are gated behind the resolved agent host — with no
host configured, the UI shows a clear "agent backend not configured" state rather
than faking success. That host/DID/token come from a **runtime** config loaded at
startup (see "Repointing the agent" below), not from build-time env directly.
If the browser still has a stored delegation ack but the agent backend restarted
and returns `409 no_delegation` on `POST /agent/run`, Feed clears that local ack,
re-posts a fresh delegation through the normal space/DID guards, and retries the
run once before surfacing an error. That recovery is shown as a non-fatal run
notice on both `/feed` and `/agents` so backend/session drift is visible.
Newer Artifactory agents may accept an optional `artifactType` on `POST
/agent/run` and return `targetArtifactType` + `proof` from `GET /agent/run/:id`
and `GET /agent/runs`. Feed treats that as operator evidence, not a hard product
mode: the Agents page has an Auto/Article/Podcast/Video target selector and
shows whether a targeted run actually published the requested type, including
rich-media checks for `clip` video, `podcast` audio, and `article` hero images.
Agents that expose `corpusPlan` and `mixPlan` also render both planning
snapshots in run history: `corpusPlan` shows which Listen conversations were
selected or rotated past, while `mixPlan` shows compact / developed /
rich-media intent, diversity checks, and weak-backpressure notes. Agents that
expose `executionSource` show whether the run came from Feed HTTP, Smithers
`agent-run`, or Smithers staged `agent-run`, which makes operator runs
distinguishable after the shared run lock is released.

### Environment + Cloudflare Pages

Vite only exposes `VITE_`-prefixed vars to the client. Copy `.env.example` to
`.env` for local dev, or set these in the CF Pages project:

| Var | Default | Purpose |
| --- | --- | --- |
| `VITE_AGENT_HOST` | _(unset)_ | **Dev-only fallback** for the agent backend host. In prod the host comes from runtime `/agent-config.json` (below); this VITE var is used only under `vite dev` when no static config is present. |
| `VITE_AGENT_DID` | _(unset)_ | Optional: the agent's stable `did:pkh`. Still feeds the **manifest** delegation target (advisory, build-time). The runtime **guard** DID comes from `/agent-config.json` (or `/agent/info` when absent). |
| `VITE_AGENT_TOKEN` | _(unset)_ | The per-install bearer token for the mutating agent endpoints. **Never committed.** Set in the CF Pages project; the runtime config file deliberately omits it. |
| `VITE_OPENKEY_HOST` | `https://openkey.so` | OpenKey passkey host. |
| `VITE_TINYCLOUD_HOST` | `https://node.tinycloud.xyz` | TinyCloud node (storage). |

**Cloudflare Pages build:** build command `bun run build`, output directory
`web/dist`. `web/public/_redirects` (`/* /index.html 200`) is copied into the
build so deep links and refreshes resolve to the SPA.

### Repointing the agent (runtime config — no rebuild)

The agent **host** and **DID** are loaded at app startup from a runtime
`web/public/agent-config.json` (served at `/agent-config.json`), so **repointing
the feed at a new agent is just an edit to that static file + a redeploy — no code
change and no VITE rebuild.** The DID is also **auto-discovered** from
`GET {host}/agent/info`, so a CVM DID change needs no config edit at all (the
`did` field, when present, only tightens the swapped-agent guard).

```jsonc
// web/public/agent-config.json — committed; host + DID are both public-safe.
{
  "host": "https://<agent-host>",
  "did": "did:pkh:eip155:1:0x…"   // optional; omit to fully auto-discover from /agent/info
}
```

- **Precedence:** runtime `/agent-config.json` **wins**; `VITE_AGENT_*` is a
  fallback for local `vite dev` only. In a **built/prod** context a missing or
  malformed `/agent-config.json` **fails loudly** (the app renders an "Agent
  configuration error" screen) — it never silently boots a blank or stale agent.
- **Token:** the committed file carries **host + DID only**. The bearer token is
  sourced from `VITE_AGENT_TOKEN` (never committed). The loader also supports an
  optional `token` field in the JSON for operators who serve their own static file
  out-of-band, but the in-repo file omits it so no secret lands in git. See
  `web/public/agent-config.example.json`.

### How it reads / writes

| What | Where | How |
| --- | --- | --- |
| Artifact feed | SQL `xyz.tinycloud.artifacts/feed` (applications space) | `tcw.sqlForSpace(appsUri).db(feed).query(...)` |
| Interactions | SQL `xyz.tinycloud.artifacts/interactions` | `tcw.sqlForSpace(appsUri).db(interactions).execute(INSERT ...)` |
| Media (hero/audio/video) | KV `xyz.tinycloud.artifacts/media/<id>/...` | `tcw.kvForSpace(appsUri).get(key)` → base64 → blob URL |

Space-scoped storage goes through `tcw.sqlForSpace(uri)` / `tcw.kvForSpace(uri)`
(`@tinycloud/web-sdk` >= 2.4.0-beta.2); the codebase reaches them through the two
`spaceSql` / `spaceKv` helpers in `web/src/feedClient.ts`. Render shape is driven
by the row's `render_type` and the format-specific fields preserved in the
lossless `raw_artifact` JSON, including compact text, articles, podcasts, and
clips with optional hero/audio/video media keys.

The card **Data trail** intentionally exposes the operational trail for
development: SQL row `id`, `slug`, schema version, `publisher_did`, producer
`run_id`, delegated space, delegation CID/expiry, target artifact type, media
focus, media KV keys (`hero_image_key`, `audio_key`, `video_key`),
approval/audience fields, source transcript file names, `quality.notes`, and
`source_quotes` from `raw_artifact`. This is not a separate API; it renders data
already present in the TinyCloud artifact row.

Feed reads newest-first rows from TinyCloud, but the visible page is passed
through `composeFeed` (`web/src/feedComposition.ts`) before render. The newest
artifact stays first; after that, the composer picks from a small recency window
to reduce same-type/source/run clumps and to surface media variety when it is
available. This is deterministic and local to the viewer: TinyCloud remains the
durable chronological store, while Feed gets a fresher first page.

The Preferences page summarizes the same interaction rows with
`summarizePreferenceSignals` (`web/src/preferenceSignals.ts`). It labels sparse
feedback as an early signal, only marks it directional after repeated aligned
evidence, and keeps the raw interaction history visible so the user can inspect
what Artifactory will treat as weak-prior generation backpressure.

Media hydration diagnostics are enabled by default on `*.localhost` and Vite dev
builds. They log structured `[TinyFeed media]` console events for KV hydration
start/ready/cache-hit/not-found/error plus image/video/audio element readiness.
Use them from the signed-in browser when media appears lazy or unstable:

```js
localStorage.setItem("tinyfeed:media-debug", "1") // force diagnostics on
localStorage.setItem("tinyfeed:media-debug", "0") // force diagnostics off
localStorage.removeItem("tinyfeed:media-debug")   // return to localhost/dev default
```

Checks:

```sh
bun run test
bun run typecheck
```

### Manual browser verification (owner sign-in)

The one step that can't be automated headlessly is the passkey/wallet sign-in.
To verify the rendered feed against the live `applications` space:

```sh
bun install
bun run dev          # https://feed.localhost
```

1. Open `https://feed.localhost` and click **Sign in**.
2. Complete OpenKey/passkey sign-in **as the owner of the `applications` space**
   (the wallet that owns `xyz.tinycloud.artifacts`). The manifest requests
   `applications`-space `tinycloud.sql` + `tinycloud.kv` caps.
3. The feed loads published artifacts and composes the first page from a bounded
   newest-first window. Open **Data trail** at the bottom of a card to inspect
   the TinyCloud row id, publisher DID, run provenance, media KV keys, source
   transcript files, quality notes, and verified quotes.
4. **More / Less / Save** on a card writes an `interaction` row (nonce-protected)
   to `xyz.tinycloud.artifacts/interactions`; **Less** hides the card with an
   undo toast. Open an article via "Continue reading" to see the full view.

The non-interactive data path (feed query, `raw_artifact` shape, KV hero decode)
is verified against the live rows via the `tc` CLI owner session.

### Local development with your Claude session

For local generation, run a local distillery agent backend and point the feed at
it. The feed must stay on HTTPS for OpenKey/WebAuthn; Portless provides the
trusted local HTTPS URLs. The easiest path is the sibling Artifactory launcher:

```sh
cd "../artifactory"
AGENT_API_TOKEN=local-claude-dev \
VITE_AGENT_TOKEN=local-claude-dev \
PORTLESS_PORT=1355 \
bun run artifact:dev:https
# -> https://feed.localhost:1355
# -> https://agent.feed.localhost:1355
```

For a deliberate rich-media proof run, add `AGENT_MEDIA_FOCUS=podcast` to bias
generation toward one real podcast/audio artifact when Gemini TTS is configured.
Use `AGENT_MEDIA_FOCUS=video AGENT_ENABLE_VIDEO=1` to bias generation toward one
real clip. Gemini/Veo is the preferred lower-cost video path when configured;
FAL/Seedance remains the higher-control clip path when `FAL_KEY` is configured
and you intend to spend on that provider. The default `balanced` mode picks the
strongest format for the material, but video-enabled auto runs should still
record a concrete held/skip reason when no clip ships.
For a targeted operator proof, use the `/agents` target selector, Artifactory's
Smithers workflows, or call `startRun({ artifactType })`; the returned proof
block is displayed in `/agents`.

Manual setup is still useful when debugging the two halves separately:

```sh
# 1. Start the feed over HTTPS.
PORTLESS_PORT=1355 bun run dev
# -> https://feed.localhost:1355

# 2. In another terminal, start the local agent backend from the sibling
# artifactory checkout. It invokes your logged-in Claude CLI session via
# `claude -p`, so `claude` must already be logged in on this Mac.
cd "../artifactory"
AGENT_API_TOKEN=local-claude-dev \
AGENT_ALLOWED_ORIGIN=https://feed.localhost:1355,https://feed.localhost \
AGENT_NAME="Local Claude Distillery Agent" \
bun harness/agent/src/server.ts
# -> http://127.0.0.1:4097

# 3. Register the local agent behind the same Portless HTTPS proxy.
cd "../feed"
PORTLESS_PORT=1355 bunx portless alias agent.feed 4097 --force
# -> https://agent.feed.localhost:1355
```

For this local setup, keep `web/public/agent-config.json` pointed at the deployed
agent and put the local override in `.env.local` (gitignored):

```sh
VITE_AGENT_CONFIG_OVERRIDE=1
VITE_AGENT_HOST=https://agent.feed.localhost:1355
VITE_AGENT_TOKEN=local-claude-dev
```

The local agent uses your Claude Code login because the backend's generate step
runs `claude -p` with the real `$HOME` and the macOS session variables Claude
needs for Keychain auth. The agent still requires an OpenKey/TinyCloud delegation
from the feed before it can read Listen data or publish artifacts.

---

## Exploring the Listen data source (`tc` recipes)

The viewer is built on the **Listen** data source; this repo is also the sandbox
where we explore the underlying data — conversations and transcripts that
`listen-importer` wrote into a TinyCloud space.

**TinyFeed has no CLI of its own.** It uses the **TinyCloud `tc` CLI** directly. Any
project built on this one should do the same: talk to Listen through `tc`. This
README is the guide to those commands.

Everything here is **read-only**.

## What you get

This repo pins `@tinycloud/cli` (>= `0.6.0-beta.11`, the version with
`tc kv --space`) as a dependency, so after `bun install` you have a known-good
`tc` available via `bunx tc` — no global install, no version guessing. That's the
whole "framework": a pinned CLI plus the recipes below.

## Getting started

### Prerequisites

- [Bun](https://bun.sh) >= 1.3
- The **Ethereum wallet that owns the Listen data** — the identity used to sign in
  to the Listen app / run `listen-importer`.

### 1. Install (provides `tc`)

```sh
bun install
bunx tc --version   # -> 0.6.0-beta.11
```

> Every `tc ...` command below is `bunx tc ...` in this repo. To type plain `tc`,
> add the local bin to your PATH for the session:
> `export PATH="$PWD/node_modules/.bin:$PATH"`.

### 2. Sign in (create an owner session)

`tc init` generates a local session key and authenticates it against a node. The
default method is **OpenKey**, which opens a browser to sign in with your wallet
(the owner of the Listen space):

```sh
bunx tc init --name listen --host https://node.tinycloud.xyz
```

- Profile already exists? Refresh the session: `bunx tc auth login --profile listen --method openkey`
- No browser (remote/SSH)? Add `--paste` for manual copy-paste auth.

Confirm who you are:

```sh
bunx tc auth status --profile listen   # authenticated? which host/space?
bunx tc auth whoami  --profile listen   # owner DID + session DID
```

### 3. Grant this session read access to the Listen data

Listen is a **manifest app**, so its data lives in your **`applications`** space
(see [The data source](#the-data-source)). Self-grant read caps **as the owner**.
Note: the KV path needs a **trailing slash** (prefix semantics) and KV actions are
`get`/`list`/`metadata` (not `read`):

```sh
bunx tc auth request --profile listen \
  --cap "tinycloud.sql:applications:xyz.tinycloud.listen/conversations:read" --grant --yes
bunx tc auth request --profile listen \
  --cap "tinycloud.kv:applications:xyz.tinycloud.listen/:get,list,metadata" --grant --yes
```

> **Grants expire** (capped by the session lifetime). When a read starts returning
> `401 AUTH_UNAUTHORIZED`, just re-run the two `auth request` commands above.

## Using the `tc` CLI

All reads target `--space applications` and `--db xyz.tinycloud.listen/conversations`.
Add `--profile listen` (or set `TC_PROFILE`) to each command. Add `--json` for
machine-readable output you can pipe to `jq`.

### Conversations (SQL)

```sh
# How many conversations?
bunx tc sql query "SELECT count(*) FROM conversation" \
  --space applications --db xyz.tinycloud.listen/conversations

# Newest first
bunx tc sql query "SELECT id, started_at, source, title FROM conversation ORDER BY started_at DESC LIMIT 20" \
  --space applications --db xyz.tinycloud.listen/conversations

# Breakdown by source + date range
bunx tc sql query "SELECT source, count(*) n, min(started_at) earliest, max(started_at) latest FROM conversation GROUP BY source ORDER BY n DESC" \
  --space applications --db xyz.tinycloud.listen/conversations

# Most recently imported (by created_at)
bunx tc sql query "SELECT id, title, source, created_at FROM conversation ORDER BY created_at DESC LIMIT 5" \
  --space applications --db xyz.tinycloud.listen/conversations

# One conversation, full row (including the Fireflies-generated summary)
bunx tc sql query "SELECT * FROM conversation WHERE id = ?" --params '["<conversationId>"]' \
  --space applications --db xyz.tinycloud.listen/conversations

# Participants for a conversation
bunx tc sql query "SELECT name, speaker_label FROM participant WHERE conversation_id = ?" --params '["<conversationId>"]' \
  --space applications --db xyz.tinycloud.listen/conversations
```

The `conversation` row carries a `summary` column (≈258/282 conversations have
one) — a ready-made per-conversation artifact, independent of transcript
availability.

### Transcripts (KV)

Transcripts are JSON blobs keyed by conversation id. Use `--raw` so you get the
value (not a JSON envelope):

```sh
# List available transcript keys
bunx tc kv list --prefix "xyz.tinycloud.listen/transcript" --space applications

# Fetch one transcript
bunx tc kv get "xyz.tinycloud.listen/transcript/<conversationId>" --space applications --raw

# Pretty-print speaker + text
bunx tc kv get "xyz.tinycloud.listen/transcript/<conversationId>" --space applications --raw \
  | jq -r '.[] | "\(.speaker_name): \(.text)"'
```

Not every conversation has a transcript blob — a missing key returns
`NOT_FOUND`.

### Pull the whole corpus locally

```sh
# Dump all conversation rows to JSON (works with the read cap from step 3).
# --json returns { columns, rows: [[...]] }; this jq zips them into objects.
bunx tc --json sql query "SELECT * FROM conversation" \
  --space applications --db xyz.tinycloud.listen/conversations \
  | jq '[.rows[] as $r | (.columns | to_entries | map({(.value): $r[.key]}) | add)]' \
  > conversations.json

# Save every transcript as JSON
mkdir -p transcripts
bunx tc kv list --prefix "xyz.tinycloud.listen/transcript" --space applications --json \
  | jq -r '.keys[]' \
  | while read key; do
      bunx tc kv get "$key" --space applications --raw > "transcripts/${key##*/}.json"
    done
```

Prefer a real SQLite file? `tc sql export` writes a binary `.db`, but needs an
extra `export` action on the cap:

```sh
bunx tc auth request --profile listen \
  --cap "tinycloud.sql:applications:xyz.tinycloud.listen/conversations:export" --grant --yes
bunx tc sql export --space applications --db xyz.tinycloud.listen/conversations --output listen.db
sqlite3 listen.db "SELECT source, count(*) FROM conversation GROUP BY source"
```

## The data source

Listen is a manifest app (`app_id: xyz.tinycloud.listen`, `defaults: true`). The
SDK manifest resolver routes its canonical data into the owner's **`applications`**
space — NOT the profile's primary `default` space. This is the key gotcha: every
read must pass `--space applications`.

| What          | Space          | Path                                       | Shape |
| ------------- | -------------- | ------------------------------------------ | ----- |
| Conversations | `applications` | SQL `xyz.tinycloud.listen/conversations`   | `conversation`, `participant` tables |
| Transcripts   | `applications` | KV  `xyz.tinycloud.listen/transcript/<id>` | `TranscriptSentence[]` |
| Raw audio     | `default`      | KV  `xyz.tinycloud.listen/importer/media/…`| mp3 / m4a (listen-importer uploads) |

`conversation` columns: `id, title, source, source_id, source_url, started_at,
ended_at, duration_secs, summary, metadata (JSON), created_at, updated_at`.

A transcript sentence is `{ index, speaker_id, speaker_name, text, start_time,
end_time, language }`.

## Gotchas

- **Space:** all Listen reads need `--space applications`. `tc sql` and `tc kv`
  both support `--space` (the latter requires `@tinycloud/cli` >= 0.6.0-beta.11).
- **KV prefix caps** need a **trailing slash** (`xyz.tinycloud.listen/`) or they
  match an exact key, not a prefix.
- **KV actions** are `get`/`list`/`metadata` — not `read`.
- **`tc kv get`** wraps the value in JSON unless you pass `--raw`.
- **Grants expire** — re-run the `auth request` commands when reads start 401-ing.
