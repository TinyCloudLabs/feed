# feed

A pure-client viewer for the **`xyz.tinycloud.artifacts`** feed, plus the `tc`
recipes for exploring the **Listen** data source it is built on.

## The viewer (pure-client web app)

A Vite + React app (`web/`) that talks to TinyCloud **directly from the browser**
via the [`@tinycloud/web-sdk`](https://www.npmjs.com/package/@tinycloud/web-sdk) —
no server, no `/api`, no sessions database. It signs in as the space **owner**
(v1; scoped reader delegation comes later), reads published artifacts from the
`feed` SQL DB in the owner's `applications` space, renders **tweet** and
**article** cards, hydrates hero images from KV, and writes reader
**interaction** events (nonce-protected) back to the `interactions` SQL DB.

```sh
bun install
bun run dev        # local dev server (http://localhost:5173)
bun run build      # static bundle -> dist/
bun run typecheck
```

### How it reads / writes

| What | Where | How |
| --- | --- | --- |
| Artifact feed | SQL `xyz.tinycloud.artifacts/feed` (applications space) | `tcw.sqlForSpace(appsUri).db(feed).query(...)` |
| Interactions | SQL `xyz.tinycloud.artifacts/interactions` | `tcw.sqlForSpace(appsUri).db(interactions).execute(INSERT ...)` |
| Media (hero) | KV `xyz.tinycloud.artifacts/media/<id>/...` | `tcw.kvForSpace(appsUri).get(key)` → base64 → blob URL |

Space-scoped storage goes through `tcw.sqlForSpace(uri)` / `tcw.kvForSpace(uri)`
(`@tinycloud/web-sdk` >= 2.4.0-beta.2); the codebase reaches them through the two
`spaceSql` / `spaceKv` helpers in `web/src/feedClient.ts`. Render shape is driven
by the row's `render_type` (`tweet` \| `article` in v1); richer fields come from
the lossless `raw_artifact` JSON.

### Manual browser verification (owner sign-in)

The one step that can't be automated headlessly is the passkey/wallet sign-in.
To verify the rendered feed against the live `applications` space:

```sh
bun install
bun run dev          # http://localhost:5173
```

1. Open `http://localhost:5173` and click **Sign in**.
2. Complete OpenKey/passkey sign-in **as the owner of the `applications` space**
   (the wallet that owns `xyz.tinycloud.artifacts`). The manifest requests
   `applications`-space `tinycloud.sql` + `tinycloud.kv` caps.
3. The feed loads published artifacts newest-first. With the current live data
   you should see **1 article** ("Why seat-based pricing punishes the customers
   you most want to keep" — with a hydrated hero image) and **1 tweet** ("Seat
   pricing taxes your power users").
4. **More / Less / Save** on a card writes an `interaction` row (nonce-protected)
   to `xyz.tinycloud.artifacts/interactions`; **Less** hides the card with an
   undo toast. Open an article via "Continue reading" to see the full view.

The non-interactive data path (feed query, `raw_artifact` shape, KV hero decode)
is verified against the live rows via the `tc` CLI owner session.

---

## Exploring the Listen data source (`tc` recipes)

The viewer is built on the **Listen** data source; this repo is also the sandbox
where we explore the underlying data — conversations and transcripts that
`listen-importer` wrote into a TinyCloud space.

**Feed has no CLI of its own.** It uses the **TinyCloud `tc` CLI** directly. Any
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
