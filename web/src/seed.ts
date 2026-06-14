// seed.ts — SEEDED TEST DATA. Lets the viewer build + demo before the producer
// (tc-publish / Smithers workflow) has written real rows. Creates the contract
// §1 tables if absent and inserts one tweet + one article (both flagged seeded
// via tags + a `seeded: true` marker in raw_artifact). Triggered only by the
// "Seed test rows" control; never runs automatically.

import type { SqlValue } from "@tinycloud/sdk-services";
import { tcw, FEED_DB, INTERACTIONS_DB, MEDIA_PREFIX } from "./tinycloud.ts";
// Space-scoped SQL goes through the SINGLE quarantined seam in feedClient.ts —
// seed.ts must not reach the private node itself (one access point only).
import { spaceSql, spaceKv } from "./feedClient.ts";

const CREATE_ARTIFACT = `
CREATE TABLE IF NOT EXISTS artifact (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, render_type TEXT NOT NULL,
  slug TEXT NOT NULL, headline TEXT NOT NULL, body_md TEXT, quote TEXT,
  attribution TEXT, tags TEXT NOT NULL DEFAULT '[]',
  source_transcripts TEXT NOT NULL DEFAULT '[]',
  hero_image_key TEXT, hero_image_sha256 TEXT, hero_image_mime TEXT,
  audio_key TEXT, audio_sha256 TEXT, audio_mime TEXT, video_url TEXT,
  audience TEXT, approval_status TEXT NOT NULL, platform TEXT,
  generation_model TEXT, critic_pass INTEGER NOT NULL DEFAULT 0,
  quotes_verified INTEGER NOT NULL DEFAULT 0, raw_artifact TEXT NOT NULL,
  generated_at TEXT NOT NULL, published_at TEXT NOT NULL,
  publisher_did TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1
)`;

const CREATE_INTERACTION = `
CREATE TABLE IF NOT EXISTS interaction (
  id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, artifact_type TEXT NOT NULL,
  action TEXT NOT NULL, note TEXT, reader_did TEXT NOT NULL, nonce TEXT NOT NULL,
  created_at TEXT NOT NULL, recorded_at TEXT NOT NULL
)`;
const CREATE_INTERACTION_NONCE_IDX = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_interaction_nonce ON interaction(reader_did, nonce)`;

// A 2x2 grey JPEG, base64 — stand-in hero so the article card shows a real
// KV→blob round-trip. `.b64` suffix per contract §2.
const TINY_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
  "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAACAAIBAREA/8QAFAABAAAAAAAA" +
  "AAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==";

const HERO_KEY = `${MEDIA_PREFIX}seed-article-001/hero.jpg.b64`;
const HERO_SHA = "seed"; // integrity placeholder; real rows carry a real sha256

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export async function seedTestRows(appsSpaceUri: string): Promise<void> {
  const feed = spaceSql(appsSpaceUri).db(FEED_DB);
  const inter = spaceSql(appsSpaceUri).db(INTERACTIONS_DB);

  // Ensure tables exist (idempotent).
  for (const s of [CREATE_ARTIFACT]) {
    const r = await feed.execute(s);
    if (!r.ok) throw new Error(`seed: create feed table failed: ${r.error.message}`);
  }
  for (const s of [CREATE_INTERACTION, CREATE_INTERACTION_NONCE_IDX]) {
    const r = await inter.execute(s);
    if (!r.ok) throw new Error(`seed: create interaction table failed: ${r.error.message}`);
  }

  // Hero bytes → KV first (media-before-pointer, contract §2).
  const putHero = await spaceKv(appsSpaceUri).put(HERO_KEY, TINY_JPEG_B64);
  if (!putHero.ok) throw new Error(`seed: hero KV put failed: ${putHero.error.message}`);

  const publisher = tcw().did;
  const tweet = makeTweetRow(publisher);
  const article = makeArticleRow(publisher);

  for (const row of [tweet, article]) {
    const r = await feed.execute(UPSERT_ARTIFACT, row);
    if (!r.ok) throw new Error(`seed: artifact upsert failed: ${r.error.message}`);
  }
}

const UPSERT_ARTIFACT = `
INSERT INTO artifact
 (id, type, render_type, slug, headline, body_md, quote, attribution, tags,
  source_transcripts, hero_image_key, hero_image_sha256, hero_image_mime,
  audio_key, audio_sha256, audio_mime, video_url, audience, approval_status,
  platform, generation_model, critic_pass, quotes_verified, raw_artifact,
  generated_at, published_at, publisher_did, schema_version)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
 ON CONFLICT(id) DO UPDATE SET
  headline=excluded.headline, body_md=excluded.body_md, quote=excluded.quote,
  tags=excluded.tags, published_at=excluded.published_at`;

function makeTweetRow(publisher: string): SqlValue[] {
  const id = "seed-tweet-001";
  const generated_at = isoDaysAgo(1);
  const published_at = isoDaysAgo(1);
  const raw = {
    id,
    type: "quote-card",
    headline: "Verifiable beats trusted, every time.",
    quote: "We stopped asking users to trust us and started letting them verify.",
    attribution: "TinyCloud engineering sync",
    tags: ["seeded", "verifiability", "product"],
    source_transcripts: ["conv-demo-001"],
    generated_at,
    generation_model: "seed",
    quality: { critic_pass: true, quotes_verified: true },
    seeded: true,
  };
  return [
    id, "quote-card", "tweet", "verifiable-beats-trusted",
    "Verifiable beats trusted, every time.", null,
    "We stopped asking users to trust us and started letting them verify.",
    "TinyCloud engineering sync",
    JSON.stringify(["seeded", "verifiability", "product"]),
    JSON.stringify(["conv-demo-001"]),
    null, null, null, null, null, null, null,
    "public", "approved", "x", "seed", 1, 1,
    JSON.stringify(raw), generated_at, published_at, publisher, 1,
  ];
}

function makeArticleRow(publisher: string): SqlValue[] {
  const id = "seed-article-001";
  const generated_at = isoDaysAgo(2);
  const published_at = isoDaysAgo(2);
  const body_md =
    "The hard part of a local-first network is not storage — it is **proof**. " +
    "Every read and write in TinyCloud is capability-scoped and signature-checked, " +
    "so a client can confirm what happened without trusting the node that served it.\n\n" +
    "## Why this matters\n\nReaders interact with the feed, and those interactions " +
    "are themselves nonce-protected events — replay-safe by construction, not by " +
    "convention. This is the closed loop the artifact pipeline was built around.";
  const raw = {
    id,
    type: "article",
    headline: "Proof, not trust: how the artifact feed stays honest",
    body: body_md,
    tags: ["seeded", "architecture", "cryptography"],
    source_transcripts: ["conv-demo-001", "conv-demo-002"],
    hero_image: "hero.jpg",
    generated_at,
    generation_model: "seed",
    quality: { critic_pass: true, quotes_verified: false },
    seeded: true,
  };
  return [
    id, "article", "article", "proof-not-trust",
    "Proof, not trust: how the artifact feed stays honest",
    body_md, null, null,
    JSON.stringify(["seeded", "architecture", "cryptography"]),
    JSON.stringify(["conv-demo-001", "conv-demo-002"]),
    HERO_KEY, HERO_SHA, "image/jpeg",
    null, null, null, null,
    "internal", "approved", null, "seed", 1, 0,
    JSON.stringify(raw), generated_at, published_at, publisher, 1,
  ];
}
