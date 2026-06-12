import { kvGet, sqlQuery, type TcOptions } from "./tc.ts";

/**
 * Reader for the Listen data source as written by listen-importer.
 *
 * Listen stores everything in the owner's TinyCloud space under the app id
 * `xyz.tinycloud.listen`:
 *   - SQL db   `xyz.tinycloud.listen/conversations`  -> conversation, participant
 *   - KV       `xyz.tinycloud.listen/transcript/<id>` -> ListenTranscriptSentence[]
 *
 * See repositories/listen-importer/src/{upload,config}.ts for the writer side.
 */

export const LISTEN_APP_ID = process.env.FEED_LISTEN_APP_ID ?? "xyz.tinycloud.listen";
export const LISTEN_SQL_DB =
  process.env.FEED_LISTEN_SQL_DB ?? `${LISTEN_APP_ID}/conversations`;
export const LISTEN_KV_PREFIX = process.env.FEED_LISTEN_KV_PREFIX ?? LISTEN_APP_ID;

/**
 * Listen is a manifest app with `defaults: true`, so the SDK manifest resolver
 * routes its canonical SQL + KV into the owner's `applications` space (not the
 * primary `default` space). Override with FEED_LISTEN_SPACE if needed.
 */
export const LISTEN_SPACE = process.env.FEED_LISTEN_SPACE ?? "applications";

/** Apply the Listen space unless the caller explicitly set one. */
function withSpace<T extends TcOptions>(options: T): T {
  return options.space ? options : { ...options, space: LISTEN_SPACE };
}

/** A row from the Listen `conversation` table. */
export interface Conversation {
  id: string;
  title: string | null;
  source: string;
  source_id: string | null;
  source_url: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_secs: number | null;
  summary: string | null;
  /** Stored as a JSON string in SQLite. */
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

/** A row from the Listen `participant` table. */
export interface Participant {
  id: string;
  conversation_id: string;
  name: string;
  email: string | null;
  speaker_label: string | null;
}

/** One transcript sentence, as written to `transcript/<id>` KV. */
export interface TranscriptSentence {
  index: number;
  speaker_id: string;
  speaker_name: string;
  text: string;
  start_time: number | null;
  end_time: number | null;
  language: string | null;
}

export interface ListConversationsOptions extends TcOptions {
  limit?: number;
  source?: string;
}

export function listConversations(
  options: ListConversationsOptions = {},
): Conversation[] {
  const where = options.source ? "WHERE source = ?" : "";
  const params = options.source ? [options.source] : [];
  const limit = options.limit && options.limit > 0 ? `LIMIT ${Math.floor(options.limit)}` : "";
  const sql =
    `SELECT id, title, source, source_id, source_url, started_at, ended_at, ` +
    `duration_secs, summary, metadata, created_at, updated_at ` +
    `FROM conversation ${where} ORDER BY started_at DESC ${limit}`.trim();
  return sqlQuery(LISTEN_SQL_DB, sql, params, withSpace(options)) as unknown as Conversation[];
}

export function countConversations(options: TcOptions = {}): number {
  const rows = sqlQuery(
    LISTEN_SQL_DB,
    "SELECT count(*) AS n FROM conversation",
    [],
    withSpace(options),
  );
  const n = rows[0]?.n;
  return typeof n === "number" ? n : Number(n ?? 0);
}

export function getParticipants(
  conversationId: string,
  options: TcOptions = {},
): Participant[] {
  return sqlQuery(
    LISTEN_SQL_DB,
    "SELECT id, conversation_id, name, email, speaker_label FROM participant WHERE conversation_id = ?",
    [conversationId],
    withSpace(options),
  ) as unknown as Participant[];
}

/** Fetch and parse the transcript for a conversation. Returns [] when absent. */
export function getTranscript(
  conversationId: string,
  options: TcOptions = {},
): TranscriptSentence[] {
  const raw = kvGet(`${LISTEN_KV_PREFIX}/transcript/${conversationId}`, withSpace(options));
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? (parsed as TranscriptSentence[]) : [];
}

/** Collapse a transcript into a single plain-text body for analysis. */
export function transcriptToText(transcript: TranscriptSentence[]): string {
  return transcript
    .map((s) => {
      const speaker = s.speaker_name?.trim();
      const text = s.text?.trim();
      if (!text) return "";
      return speaker ? `${speaker}: ${text}` : text;
    })
    .filter(Boolean)
    .join("\n");
}

export function parseMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
