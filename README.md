# feed

Exploration harness for the **Listen** data source, read through the TinyCloud
`tc` CLI. Feed is (eventually) a destination app; this repo is the sandbox where
we poke at the underlying data — conversations and transcripts that
`listen-importer` wrote into a TinyCloud space — before designing how a feed
renders it.

This is **read-only**. It does not write to TinyCloud.

## The data source

Listen stores everything in the owner's TinyCloud space under app id
`xyz.tinycloud.listen` (see `repositories/listen-importer/src/{upload,config}.ts`):

| What         | Where                                          | Shape |
| ------------ | ---------------------------------------------- | ----- |
| Conversations| SQL `xyz.tinycloud.listen/conversations`       | `conversation`, `participant` tables |
| Transcripts  | KV  `xyz.tinycloud.listen/transcript/<id>`     | `TranscriptSentence[]` |

A transcript sentence is `{ index, speaker_id, speaker_name, text, start_time, end_time, language }`.

## Setup

```sh
bun install
```

Feed shells out to `tc`. Point it at the **owner session that holds the Listen
data** (the wallet/identity used in the Listen app + importer).

### 1. Create an owner session

```sh
# Authenticate the tc CLI as the owner of the Listen space.
# Opens a browser for OpenKey / wallet sign-in.
tc init --name listen --host https://node.tinycloud.xyz
# or, if the profile already exists:
tc auth login --method openkey
```

### 2. Grant this session read access to the Listen data

The session needs explicit capabilities for the Listen SQL db and transcript KV.
Run these **as the owner** of the space (self-grant):

```sh
tc auth request --cap "tinycloud.sql:default:xyz.tinycloud.listen/conversations:read" --grant --yes
tc auth request --cap "tinycloud.kv:default:xyz.tinycloud.listen:read" --grant --yes
```

### 3. Verify

```sh
bun src/cli.ts doctor
```

## Usage

```sh
bun src/cli.ts conversations --limit 20
bun src/cli.ts transcript <conversationId>
bun src/cli.ts stats
bun src/cli.ts pull --out .feed         # dump conversations + transcripts locally
```

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
| `FEED_TC_BIN`         | `tc`                               | tc binary (e.g. a `tc-local` shim) |
| `FEED_TC_PROFILE`     | active profile                     | tc profile |
| `FEED_TC_HOST`        | profile host                       | node URL override |
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
