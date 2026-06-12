# feed

Exploration harness for the **Listen** data source, read through the TinyCloud
`tc` CLI. Feed is (eventually) a destination app; this repo is the sandbox where
we poke at the underlying data — conversations and transcripts that
`listen-importer` wrote into a TinyCloud space — before designing how a feed
renders it.

This is **read-only**. It does not write to TinyCloud.

## Getting started

### Prerequisites

- [Bun](https://bun.sh) >= 1.3
- The **Ethereum wallet that owns the Listen data** — i.e. the identity used to
  sign in to the Listen app / run `listen-importer`. You sign in with it below.

You do **not** need a globally installed `tc`: this repo pins `@tinycloud/cli`
(>= 0.6.0-beta.11, the version with `tc kv --space`), so every `tc` command below
runs the bundled CLI via `bunx tc`.

### 1. Install

```sh
bun install
```

### 2. Sign in with `tc` (create an owner session)

`tc init` generates a local session key and authenticates it against a TinyCloud
node. The default method is **OpenKey**, which opens a browser to sign in with
your wallet (the owner of the Listen space):

```sh
bunx tc init --name listen --host https://node.tinycloud.xyz
```

- Already created the `listen` profile before? Just refresh the session:
  ```sh
  bunx tc auth login --profile listen --method openkey
  ```
- No browser available (remote/SSH)? Add `--paste` for manual copy-paste auth.

Confirm you're signed in and see which space/owner you are:

```sh
bunx tc auth status --profile listen   # authenticated? which host/space?
bunx tc auth whoami  --profile listen   # owner DID + session DID
```

### 3. Grant this session read access to the Listen data

Listen is a manifest app, so its data lives in your **`applications`** space (see
[The data source](#the-data-source)). Self-grant read caps **as the owner** of
the space. Note: the KV path needs a **trailing slash** (prefix semantics) and KV
actions are `get`/`list`/`metadata` (not `read`):

```sh
bunx tc auth request --profile listen \
  --cap "tinycloud.sql:applications:xyz.tinycloud.listen/conversations:read" --grant --yes
bunx tc auth request --profile listen \
  --cap "tinycloud.kv:applications:xyz.tinycloud.listen/:get,list,metadata" --grant --yes
```

### 4. Verify + explore

```sh
bun src/cli.ts doctor       --profile listen   # session + Listen access check
bun src/cli.ts stats        --profile listen   # corpus summary
bun src/cli.ts conversations --profile listen --limit 20
bun src/cli.ts pull         --profile listen   # dump the corpus to ./.feed
```

> `doctor` prints the exact cap-grant commands if step 3 was skipped or the
> session expired. To skip `--profile` on every call, set `FEED_TC_PROFILE=listen`.

## The data source

Listen is a **manifest app** (`app_id: xyz.tinycloud.listen`, `defaults: true`).
The SDK manifest resolver routes its canonical data into the owner's
**`applications`** space — NOT the profile's primary `default` space. This is the
key gotcha: every read must target `--space applications`.

| What          | Space          | Path                                       | Shape |
| ------------- | -------------- | ------------------------------------------ | ----- |
| Conversations | `applications` | SQL `xyz.tinycloud.listen/conversations`   | `conversation`, `participant` tables |
| Transcripts   | `applications` | KV  `xyz.tinycloud.listen/transcript/<id>` | `TranscriptSentence[]` |
| Raw audio     | `default`      | KV  `xyz.tinycloud.listen/importer/media/…`| mp3 / m4a (listen-importer uploads) |

A transcript sentence is `{ index, speaker_id, speaker_name, text, start_time, end_time, language }`.

> Reading applications-space KV requires `tc kv --space`, shipped in
> `@tinycloud/cli` >= 0.6.0-beta.11 (`TinyCloudNode.kvForSpace()`, mirrors the
> existing `sqlForSpace`). Feed pins that CLI as a devDependency, so `bun install`
> provides a `tc` with `--space` — no global install or source build needed.

## Usage

```sh
bun src/cli.ts doctor                   # session + Listen access check
bun src/cli.ts conversations --limit 20 # list (newest first)
bun src/cli.ts transcript <conversationId>
bun src/cli.ts stats                    # corpus summary
bun src/cli.ts pull --out .feed         # dump conversations + transcripts locally
```

All commands accept `--profile`, `--host`, `--space`, and `--json`.

### Selecting a profile / host

```sh
bun src/cli.ts doctor --profile listen --host https://node.tinycloud.xyz
# or via env:
FEED_TC_PROFILE=listen bun src/cli.ts conversations
```

### Pointing at a different space / app id

```sh
FEED_LISTEN_APP_ID=xyz.tinycloud.listen bun src/cli.ts conversations
```

## Environment variables

| Var                   | Default                            | Purpose |
| --------------------- | ---------------------------------- | ------- |
| `FEED_TC_BIN`         | bundled `node_modules/.bin/tc`     | tc binary (override for a local source build / shim) |
| `FEED_TC_PROFILE`     | active profile                     | tc profile |
| `FEED_TC_HOST`        | profile host                       | node URL override |
| `FEED_TC_SPACE`       | `applications`                     | space override for all reads |
| `FEED_LISTEN_SPACE`   | `applications`                     | space Listen's data lives in |
| `FEED_LISTEN_APP_ID`  | `xyz.tinycloud.listen`             | Listen app id |
| `FEED_LISTEN_SQL_DB`  | `<app-id>/conversations`           | SQL db path |
| `FEED_LISTEN_KV_PREFIX`| `<app-id>`                        | KV prefix for transcripts |

## Layout

```
src/
  tc.ts       # thin wrapper over the tc CLI (sql query, kv get/list)
  listen.ts   # Listen data-source reader + types
  cli.ts      # feed CLI
```
