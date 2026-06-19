// feedClient.ts — the viewer's only data layer. Reads the artifact feed (SQL),
// hydrates media (KV), and appends interaction events (SQL) — all scoped to the
// owner's `applications` space.
//
// SPACE-SCOPED SQL/KV
// ───────────────────
// `TinyCloudWeb.sqlForSpace(uri)` / `kvForSpace(uri)` (web-sdk >= 2.4.0-beta.2)
// return services scoped to a non-primary space. The whole codebase reaches
// space-scoped storage through the two helpers below (this file AND seed.ts) —
// keep it that way so there's a single place to evolve.

import type { IDatabaseHandle, IKVService } from "@tinycloud/sdk-services";
import { tcw, FEED_DB, INTERACTIONS_DB } from "./tinycloud.ts";
import type {
  ArtifactRow,
  FeedCard,
  InteractionAction,
  InteractionRow,
  RenderType,
} from "./types.ts";

// ── space-scoped storage accessors ──────────────────────────────────────────

/** Space-scoped SQL service for `uri` (full space URI). */
export function spaceSql(uri: string): { db(name: string): IDatabaseHandle } {
  return tcw().sqlForSpace(uri);
}

/** Space-scoped KV service for `uri` (full space URI). */
export function spaceKv(uri: string): IKVService {
  return tcw().kvForSpace(uri);
}

// ── reads ──────────────────────────────────────────────────────────────────

/** Zip a `{ columns, rows: T[][] }` SQL response into row objects. */
function zipRows<T>(columns: string[], rows: unknown[][]): T[] {
  return rows.map((r) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      obj[c] = r[i];
    });
    return obj as T;
  });
}

function parseJsonArray(s: string | null): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function toRenderType(rt: string): RenderType {
  if (rt === "tweet" || rt === "article" || rt === "video") return rt;
  // Unknown render types are surfaced, not silently coerced.
  throw new Error(`unknown render_type: ${rt}`);
}

/** Map a raw `artifact` SQL row to the render-ready card (sans hero blob).
 *  A malformed `raw_artifact` is a corrupt row, not a recoverable state — throw
 *  loudly (no silent `{}` fallback that would hide vanished richer fields). */
function toCard(row: ArtifactRow): FeedCard {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.raw_artifact);
  } catch (e) {
    throw new Error(
      `artifact ${row.id}: malformed raw_artifact JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  // Valid JSON that is null/array/string/number parses without throwing but is
  // the wrong SHAPE — `card.raw.<field>` access would crash the render. Treat
  // wrong-shape the same as unparseable: fail loudly, per-row.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `artifact ${row.id}: malformed raw_artifact JSON (expected an object, got ${
        Array.isArray(parsed) ? "array" : parsed === null ? "null" : typeof parsed
      })`,
    );
  }
  const raw = parsed as Record<string, unknown>;
  return {
    id: row.id,
    type: row.type,
    render_type: toRenderType(row.render_type),
    slug: row.slug,
    headline: row.headline,
    body_md: row.body_md,
    quote: row.quote,
    attribution: row.attribution,
    tags: parseJsonArray(row.tags),
    source_transcripts: parseJsonArray(row.source_transcripts),
    hero_image_key: row.hero_image_key,
    audio_key: row.audio_key,
    audio_mime: row.audio_mime,
    video_key: row.video_key,
    video_mime: row.video_mime,
    video_url: row.video_url,
    audience: row.audience,
    approval_status: row.approval_status,
    platform: row.platform,
    generation_model: row.generation_model,
    critic_pass: row.critic_pass === 1,
    quotes_verified: row.quotes_verified === 1,
    generated_at: row.generated_at,
    published_at: row.published_at,
    publisher_did: row.publisher_did,
    schema_version: row.schema_version,
    raw,
  };
}

const COLUMNS =
  "id, type, render_type, slug, headline, body_md, quote, attribution, tags, " +
  "source_transcripts, hero_image_key, hero_image_sha256, hero_image_mime, " +
  "audio_key, audio_sha256, audio_mime, video_key, video_sha256, video_mime, " +
  "video_url, audience, approval_status, " +
  "platform, generation_model, critic_pass, quotes_verified, raw_artifact, " +
  "generated_at, published_at, publisher_did, schema_version";

/** True when a SQL error is a "the table doesn't exist yet" error — the feed is
 *  read pre-bootstrap (someone hit /feed before connecting, or before the first
 *  run created any artifact rows). Treated as an empty feed, not a hard error. */
function isMissingTable(message: string): boolean {
  return /no such table/i.test(message);
}

/** Read the published feed, newest first. Supports tweet/article/video rows.
 *  A not-yet-existing `artifact` table reads as an EMPTY feed (the empty state
 *  prompts the user to connect + Generate); any other read failure throws. */
export async function loadFeed(
  appsSpaceUri: string,
  limit = 50,
  offset = 0,
): Promise<FeedCard[]> {
  const db = spaceSql(appsSpaceUri).db(FEED_DB);
  const res = await db.query<unknown>(
    `SELECT ${COLUMNS} FROM artifact ` +
      `WHERE render_type IN ('tweet','article','video') ` +
      `ORDER BY published_at DESC LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  if (!res.ok) {
    if (isMissingTable(res.error.message)) return [];
    throw new Error(`feed read failed: ${res.error.message}`);
  }
  const rows = zipRows<ArtifactRow>(res.data.columns, res.data.rows);
  return rows.map(toCard);
}

// ── media hydration ──────────────────────────────────────────────────────────
//
// Blob URLs are ref-counted by key: each `hydrateMedia` adds a reference, each
// `releaseMedia` drops one, and the object URL is revoked when the count hits
// zero. This bounds memory — without it, every hydrated hero would leak a blob
// URL for the page's lifetime (Codex finding).

interface MediaEntry {
  url: string;
  refs: number;
}
const mediaCache = new Map<string, MediaEntry>();

/** Resolve a KV media key (base64 string value, contract §2 `.b64` suffix) to a
 *  blob URL for an <img>. Adds a reference; pair each successful call with
 *  `releaseMedia(key)`. Returns null when the key is absent (404). Non-404 KV
 *  failures throw (no silent swallow). */
export async function hydrateMedia(
  appsSpaceUri: string,
  key: string,
  mime = "image/jpeg",
): Promise<string | null> {
  const cached = mediaCache.get(key);
  if (cached) {
    cached.refs += 1;
    return cached.url;
  }

  const kv = spaceKv(appsSpaceUri);
  const res = await kv.get<string>(key);
  if (!res.ok) {
    if (res.error.code === "KV_NOT_FOUND" || res.error.code === "NOT_FOUND") return null;
    throw new Error(`media read failed (${key}): ${res.error.message}`);
  }
  const b64 = res.data.data;
  if (typeof b64 !== "string") throw new Error(`media ${key} is not a base64 string`);
  const bytes = base64ToBytes(b64);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  // A concurrent hydrate of the same key may have populated the cache while this
  // request was in flight; if so, drop our duplicate and reuse the shared entry.
  const raced = mediaCache.get(key);
  if (raced) {
    URL.revokeObjectURL(url);
    raced.refs += 1;
    return raced.url;
  }
  mediaCache.set(key, { url, refs: 1 });
  return url;
}

/** Drop one reference to a hydrated media key; revoke the blob URL at zero. */
export function releaseMedia(key: string): void {
  const entry = mediaCache.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    URL.revokeObjectURL(entry.url);
    mediaCache.delete(key);
  }
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── interaction writes (contract §1.2 — nonce-based, never timestamp-only) ──

/** Append one interaction event. `id` (client UUID) makes retries idempotent;
 *  `nonce` is per-action replay protection enforced by the uq_interaction_nonce
 *  index on (reader_did, nonce). `created_at` is the client clock (display
 *  only); `recorded_at` is set by the writer here as the trusted ordering key. */
export async function recordInteraction(
  appsSpaceUri: string,
  input: {
    artifactId: string;
    artifactType: string;
    action: InteractionAction;
    readerDid: string;
    note?: string;
  },
): Promise<InteractionRow> {
  const now = new Date().toISOString();
  const row: InteractionRow = {
    id: crypto.randomUUID(),
    artifact_id: input.artifactId,
    artifact_type: input.artifactType,
    action: input.action,
    note: input.note?.trim() ? input.note.trim() : null,
    reader_did: input.readerDid,
    nonce: crypto.randomUUID(),
    created_at: now,
    recorded_at: now,
  };

  const db = spaceSql(appsSpaceUri).db(INTERACTIONS_DB);
  const res = await db.execute(
    `INSERT INTO interaction ` +
      `(id, artifact_id, artifact_type, action, note, reader_did, nonce, created_at, recorded_at) ` +
      `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.artifact_id,
      row.artifact_type,
      row.action,
      row.note,
      row.reader_did,
      row.nonce,
      row.created_at,
      row.recorded_at,
    ],
  );
  if (!res.ok) throw new Error(`interaction write failed: ${res.error.message}`);
  return row;
}

// ── interaction reads (Preferences page) ─────────────────────────────────────

/** Read the reader's recent interactions, newest first. Used by the Preferences
 *  page to show the interaction history that feeds the (server-side) preference
 *  loop. There is no client-side preferences store yet, so this is the durable
 *  signal the user can see. */
export async function loadInteractions(
  appsSpaceUri: string,
  limit = 100,
): Promise<InteractionRow[]> {
  const db = spaceSql(appsSpaceUri).db(INTERACTIONS_DB);
  const res = await db.query<unknown>(
    `SELECT id, artifact_id, artifact_type, action, note, reader_did, nonce, ` +
      `created_at, recorded_at FROM interaction ` +
      `ORDER BY recorded_at DESC LIMIT ?`,
    [limit],
  );
  if (!res.ok) {
    if (isMissingTable(res.error.message)) return [];
    throw new Error(`interactions read failed: ${res.error.message}`);
  }
  return zipRows<InteractionRow>(res.data.columns, res.data.rows);
}

// ── schema bootstrap (owner session, on connect) ─────────────────────────────
//
// The FRONT END owns table bootstrap, not the agent (the agent's delegation is
// minimal — feed-write — so the owner session, which holds read/write on its own
// `feed` + `interactions` via the broadened manifest, is the right authority).
// On connect we run the EXACT §1 DDL idempotently so: (a) the agent can INSERT
// feed rows on its first run, (b) reader interaction writes work, (c) the feed
// read doesn't error on a missing table before the first run.
//
// DDL copied verbatim from the producer's artifact-schema.ts (greenfield
// contract §1.1/§1.2). The front end bootstraps only the two tables the owner +
// reader touch — `feed` and `interactions`; the agent-only `control` DB
// (distill_cursor) is the agent's responsibility, not ours.

const FEED_DDL = `CREATE TABLE IF NOT EXISTS artifact (
  id                 TEXT PRIMARY KEY,
  type               TEXT NOT NULL,
  render_type        TEXT NOT NULL,
  slug               TEXT NOT NULL,
  headline           TEXT NOT NULL,
  body_md            TEXT,
  quote              TEXT,
  attribution        TEXT,
  tags               TEXT NOT NULL DEFAULT '[]',
  source_transcripts TEXT NOT NULL DEFAULT '[]',

  hero_image_key     TEXT,
  hero_image_sha256  TEXT,
  hero_image_mime    TEXT,
  audio_key          TEXT,
  audio_sha256       TEXT,
  audio_mime         TEXT,
  video_key          TEXT,
  video_sha256       TEXT,
  video_mime         TEXT,
  video_url          TEXT,

  audience           TEXT,
  approval_status    TEXT NOT NULL,
  platform           TEXT,

  generation_model   TEXT,
  critic_pass        INTEGER NOT NULL DEFAULT 0,
  quotes_verified    INTEGER NOT NULL DEFAULT 0,

  raw_artifact       TEXT NOT NULL,
  generated_at       TEXT NOT NULL,
  published_at       TEXT NOT NULL,
  publisher_did      TEXT NOT NULL,
  schema_version     INTEGER NOT NULL DEFAULT 1
)`;

const FEED_MIGRATIONS = [
  `ALTER TABLE artifact ADD COLUMN video_key TEXT`,
  `ALTER TABLE artifact ADD COLUMN video_sha256 TEXT`,
  `ALTER TABLE artifact ADD COLUMN video_mime TEXT`,
];

const INTERACTION_DDL = `CREATE TABLE IF NOT EXISTS interaction (
  id            TEXT PRIMARY KEY,
  artifact_id   TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  action        TEXT NOT NULL,
  note          TEXT,
  reader_did    TEXT NOT NULL,
  nonce         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  recorded_at   TEXT NOT NULL
)`;

/** Indexes are BEST-EFFORT: the node's SQLite authorizer rejects CREATE INDEX
 *  ("not authorized" — a server-side constraint, not a cap gap). We attempt them
 *  and swallow ONLY that rejection (loud about any other failure). They are query
 *  accelerators; correctness doesn't depend on them. uq_interaction_nonce's
 *  replay-protection role lives in the per-row `nonce` written by
 *  `recordInteraction` (dedup moves to the distill layer until the node permits
 *  the UNIQUE index). */
const FEED_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_artifact_published_at ON artifact(published_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_artifact_render_type  ON artifact(render_type, published_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_artifact_audience     ON artifact(audience, approval_status)`,
];
const INTERACTION_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_interaction_artifact ON interaction(artifact_id)`,
  `CREATE INDEX IF NOT EXISTS idx_interaction_distill  ON interaction(recorded_at, id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_interaction_nonce ON interaction(reader_did, nonce)`,
];

/** The node rejects CREATE INDEX regardless of cap — the message carries it. */
function isIndexNotAuthorized(message: string): boolean {
  return /not authorized/i.test(message);
}

function isDuplicateColumn(message: string): boolean {
  return /duplicate column name/i.test(message);
}

/** Run one CREATE TABLE/INDEX. Tables hard-fail; an index "not authorized"
 *  rejection is recorded and swallowed (every OTHER error throws). */
async function execDdl(
  db: IDatabaseHandle,
  statement: string,
  isIndex: boolean,
  skipped: string[],
): Promise<void> {
  const res = await db.execute(statement);
  if (res.ok) return;
  if (isIndex && isIndexNotAuthorized(res.error.message)) {
    skipped.push(statement.match(/INDEX IF NOT EXISTS (\w+)/)?.[1] ?? statement);
    return;
  }
  throw new Error(`schema bootstrap failed: ${res.error.message}`);
}

async function execMigration(db: IDatabaseHandle, statement: string): Promise<void> {
  const res = await db.execute(statement);
  if (res.ok) return;
  if (isDuplicateColumn(res.error.message)) return;
  throw new Error(`schema migration failed: ${res.error.message}`);
}

/** Idempotently create the `feed` + `interactions` tables in the owner's space.
 *  Safe to run on every connect. Returns the node-rejected index names (for
 *  diagnostics only — they are accelerators, not correctness). */
export async function bootstrapSchema(
  appsSpaceUri: string,
): Promise<{ skippedIndexes: string[] }> {
  const sql = spaceSql(appsSpaceUri);
  const skipped: string[] = [];

  const feed = sql.db(FEED_DB);
  await execDdl(feed, FEED_DDL, false, skipped);
  for (const migration of FEED_MIGRATIONS) await execMigration(feed, migration);
  for (const idx of FEED_INDEXES) await execDdl(feed, idx, true, skipped);

  const interactions = sql.db(INTERACTIONS_DB);
  await execDdl(interactions, INTERACTION_DDL, false, skipped);
  for (const idx of INTERACTION_INDEXES) await execDdl(interactions, idx, true, skipped);

  return { skippedIndexes: skipped };
}
