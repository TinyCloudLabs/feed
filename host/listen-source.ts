import { disableTinyCloudDebug, type DelegatedAccess, type SqlValue } from "@tinycloud/node-sdk";
import { createHash } from "node:crypto";
import { withStorageSpan } from "./observability.ts";
import { FeedHostError } from "./storage.ts";

export const LISTEN_CONVERSATIONS_DB_PATH = "xyz.tinycloud.listen/conversations";
export const LISTEN_TRANSCRIPT_KV_PREFIX = "xyz.tinycloud.listen/transcript/";
export const DEFAULT_LISTEN_SOURCE_LIMIT = 5;
export const MAX_LISTEN_SOURCE_LIMIT = 10;
export const MAX_LISTEN_SOURCE_ITEM_BYTES = 128 * 1024;
/** Hard cap for the complete serialized response body, not just transcript text. */
export const MAX_LISTEN_SOURCE_BATCH_BYTES = 384 * 1024;
const MAX_LISTEN_SOURCE_SCAN = 100;
const LISTEN_SOURCE_SCAN_PAGE = 25;
const MAX_CONVERSATION_ID_CHARS = 512;
const MAX_TITLE_CHARS = 512;

export type ListenSourceCursor = {
  startedAt: string | null;
  conversationId: string;
};

export type ListenSourceItem = {
  conversationId: string;
  title: string;
  startedAt: string | null;
  transcript: string;
  transcriptBytes: number;
  transcriptSha256: string;
  truncated: boolean;
};

export type ListenSourceBatch = {
  items: ListenSourceItem[];
  nextCursor: ListenSourceCursor | null;
  count: number;
  bytes: number;
};

type ConversationColumns = {
  id: string;
  title?: string;
  startedAt?: string;
};

type ConversationCandidate = {
  id: string;
  title: string;
  startedAt: string | null;
};

type ServiceResult = {
  ok?: boolean;
  data?: { columns?: string[]; rows?: unknown[]; data?: unknown };
  error?: { code?: unknown; message?: unknown };
};

const TITLE_COLUMNS = ["title", "name", "subject", "summary"] as const;
const START_COLUMNS = ["started_at", "start_time", "date", "created_at"] as const;
const CONVERSATION_COLUMN_CANDIDATES: ConversationColumns[] = [
  { id: "id", title: TITLE_COLUMNS[0], startedAt: START_COLUMNS[0] },
  { id: "id", title: TITLE_COLUMNS[0] },
  { id: "id" },
];
const INLINE_TRANSCRIPT_CANDIDATES = [
  { transcriptJson: "transcript_json", transcriptText: "transcript_text" },
  { transcriptJson: "transcript_json", transcriptText: undefined },
  { transcriptJson: undefined, transcriptText: "transcript_text" },
] as const;

export function parseListenSourceCursor(value: unknown): ListenSourceCursor | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FeedHostError("source cursor must be an object", 400, "invalid_worker_request");
  }
  const cursor = value as Record<string, unknown>;
  if (Object.keys(cursor).some((key) => key !== "startedAt" && key !== "conversationId")) {
    throw new FeedHostError("source cursor contains unsupported fields", 400, "invalid_worker_request");
  }
  if (
    typeof cursor.conversationId !== "string" ||
    cursor.conversationId.length === 0 ||
    cursor.conversationId.length > MAX_CONVERSATION_ID_CHARS
  ) {
    throw new FeedHostError("source cursor conversationId is invalid", 400, "invalid_worker_request");
  }
  if (cursor.startedAt !== null && !isRfc3339Timestamp(cursor.startedAt)) {
    throw new FeedHostError("source cursor startedAt is invalid", 400, "invalid_worker_request");
  }
  return { startedAt: cursor.startedAt as string | null, conversationId: cursor.conversationId };
}

export async function readListenSourceBatchWithTelemetry(input: {
  actorId: string;
  sqlAccess: DelegatedAccess;
  transcriptAccess: DelegatedAccess;
  limit?: number;
  cursor?: ListenSourceCursor;
}): Promise<ListenSourceBatch> {
  // The TinyCloud SDK's opt-in debug stream includes raw SQL paths, KV keys,
  // and fetch URLs. Source IDs are private, so this host boundary deliberately
  // keeps SDK debug disabled even when a process-wide debug flag was supplied.
  disableSourceContentDebugging();
  return withStorageSpan({
    op: "listen_source_batch",
    actorId: input.actorId,
    resourcePath: LISTEN_CONVERSATIONS_DB_PATH,
    run: () => readListenSourceBatch(input),
    resultCode: () => "ok",
    metrics: (batch) => ({ batchCount: batch.count, batchBytes: batch.bytes }),
    errorMetrics: { batchCount: 0, batchBytes: 0 },
  });
}

export async function readListenSourceBatch(input: {
  sqlAccess: DelegatedAccess;
  transcriptAccess: DelegatedAccess;
  limit?: number;
  cursor?: ListenSourceCursor;
}): Promise<ListenSourceBatch> {
  const limit = input.limit ?? DEFAULT_LISTEN_SOURCE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LISTEN_SOURCE_LIMIT) {
    throw new FeedHostError(`source limit must be an integer from 1 to ${MAX_LISTEN_SOURCE_LIMIT}`, 400, "invalid_worker_request");
  }
  disableSourceContentDebugging();
  const database = input.sqlAccess.sql.db(LISTEN_CONVERSATIONS_DB_PATH);
  const items: ListenSourceItem[] = [];
  let scanned = 0;
  let cursor = input.cursor;
  let lastScanned: ListenSourceCursor | undefined;
  let reachedEnd = false;
  let stoppedForBounds = false;
  let conversationColumns: ConversationColumns | undefined;
  let inlineColumns: (typeof INLINE_TRANSCRIPT_CANDIDATES)[number] | null | undefined;

  while (items.length < limit && scanned < MAX_LISTEN_SOURCE_SCAN) {
    const pageLimit = Math.min(LISTEN_SOURCE_SCAN_PAGE, MAX_LISTEN_SOURCE_SCAN - scanned);
    const pageResult = await readConversationCandidates(database, conversationColumns, cursor, pageLimit);
    const page = pageResult.rows;
    conversationColumns = pageResult.columns;
    if (page.length === 0) {
      reachedEnd = true;
      break;
    }
    for (const candidate of page) {
      const candidateCursor = { startedAt: candidate.startedAt, conversationId: candidate.id };
      scanned += 1;
      if (candidate.id.length > MAX_CONVERSATION_ID_CHARS) {
        // The SQL predicate excludes these in production. Keep a defensive
        // in-request boundary for nonconforming adapters, but never expose an
        // ID that parseListenSourceCursor would reject in a public cursor.
        cursor = candidateCursor;
        continue;
      }

      const transcriptResult = await readTranscript(
        input.transcriptAccess,
        database,
        inlineColumns,
        candidate.id,
      );
      inlineColumns = transcriptResult.inlineColumns;
      const transcript = transcriptResult.text;
      if (!transcript.trim()) {
        lastScanned = candidateCursor;
        cursor = candidateCursor;
        continue;
      }
      const item = fitListenSourceItem(items, candidate, transcript, candidateCursor);
      if (!item) {
        stoppedForBounds = true;
        break;
      }
      items.push(item);
      lastScanned = candidateCursor;
      cursor = candidateCursor;
      if (items.length >= limit || serializedBatchBytes(items, candidateCursor) >= MAX_LISTEN_SOURCE_BATCH_BYTES) {
        stoppedForBounds = true;
        break;
      }
    }
    if (stoppedForBounds) break;
    if (page.length < pageLimit) {
      reachedEnd = true;
      break;
    }
  }

  return finalizeBatch(items, reachedEnd ? null : lastScanned ?? input.cursor ?? null);
}

async function readConversationCandidates(
  database: { query: Function },
  knownColumns: ConversationColumns | undefined,
  cursor: ListenSourceCursor | undefined,
  limit: number,
): Promise<{ rows: ConversationCandidate[]; columns: ConversationColumns }> {
  if (knownColumns) {
    return { rows: await queryConversationCandidates(database, knownColumns, cursor, limit), columns: knownColumns };
  }
  let lastMissingColumn: ServiceResult | undefined;
  for (const columns of CONVERSATION_COLUMN_CANDIDATES) {
    const result = await queryConversationCandidatesResult(database, columns, cursor, limit);
    if (result.ok === true) return { rows: conversationRows(result), columns };
    if (!isMissingColumnResult(result)) throwServiceError(result, "Listen conversations could not be read");
    lastMissingColumn = result;
  }
  throwServiceError(lastMissingColumn ?? {}, "Listen conversation schema is not supported");
}

async function queryConversationCandidates(
  database: { query: Function },
  columns: ConversationColumns,
  cursor: ListenSourceCursor | undefined,
  limit: number,
): Promise<ConversationCandidate[]> {
  return conversationRows(await queryConversationCandidatesResult(database, columns, cursor, limit));
}

async function queryConversationCandidatesResult(
  database: { query: Function },
  columns: ConversationColumns,
  cursor: ListenSourceCursor | undefined,
  limit: number,
): Promise<ServiceResult> {
  const id = sqlIdentifier(columns.id);
  const title = columns.title ? sqlIdentifier(columns.title) : id;
  const startedAt = columns.startedAt ? sqlIdentifier(columns.startedAt) : undefined;
  const selectedStart = startedAt ? `${startedAt} AS started_at` : "NULL AS started_at";
  const params: SqlValue[] = [];
  const predicates = [`length(${id}) <= ?`];
  params.push(MAX_CONVERSATION_ID_CHARS);
  if (cursor) {
    if (startedAt && cursor.startedAt !== null) {
      predicates.push(`(${startedAt} < ? OR ${startedAt} IS NULL OR (${startedAt} = ? AND ${id} < ?))`);
      params.push(cursor.startedAt, cursor.startedAt, cursor.conversationId);
    } else if (startedAt) {
      predicates.push(`${startedAt} IS NULL`, `${id} < ?`);
      params.push(cursor.conversationId);
    } else {
      predicates.push(`${id} < ?`);
      params.push(cursor.conversationId);
    }
  }
  const where = `WHERE ${predicates.join(" AND ")}`;
  const order = startedAt
    ? `CASE WHEN ${startedAt} IS NULL THEN 1 ELSE 0 END ASC, ${startedAt} DESC, ${id} DESC`
    : `${id} DESC`;
  params.push(limit);
  return database.query(
    `SELECT ${id} AS id, ${title} AS title, ${selectedStart} FROM conversation ${where} ORDER BY ${order} LIMIT ?`,
    params,
  ) as Promise<ServiceResult>;
}

function conversationRows(result: ServiceResult): ConversationCandidate[] {
  return serviceRows(result, "Listen conversations could not be read").flatMap((row) => {
    const idValue = optionalText(valueFromRow(row, result.data?.columns, "id", 0));
    if (!idValue) return [];
    return [{
      id: idValue,
      title: optionalText(valueFromRow(row, result.data?.columns, "title", 1)) ?? idValue,
      startedAt: optionalText(valueFromRow(row, result.data?.columns, "started_at", 2)) ?? null,
    }];
  });
}

async function readTranscript(
  transcriptAccess: DelegatedAccess,
  database: { query: Function },
  knownInlineColumns: (typeof INLINE_TRANSCRIPT_CANDIDATES)[number] | null | undefined,
  conversationId: string,
): Promise<{ text: string; inlineColumns: (typeof INLINE_TRANSCRIPT_CANDIDATES)[number] | null | undefined }> {
  const kvResult = await transcriptAccess.kv.get(conversationId, { raw: true }) as ServiceResult;
  if (kvResult.ok === true) {
    const text = transcriptText(kvResult.data?.data);
    if (text.trim()) return { text, inlineColumns: knownInlineColumns };
  } else if (!isNotFound(kvResult)) {
    throwServiceError(kvResult, "Listen transcript could not be read");
  }
  if (knownInlineColumns === null) return { text: "", inlineColumns: null };
  if (knownInlineColumns) {
    return {
      text: await queryInlineTranscript(database, knownInlineColumns, conversationId),
      inlineColumns: knownInlineColumns,
    };
  }
  for (const columns of INLINE_TRANSCRIPT_CANDIDATES) {
    const result = await queryInlineTranscriptResult(database, columns, conversationId);
    if (result.ok === true) return { text: transcriptFromInlineRows(result), inlineColumns: columns };
    if (!isMissingColumnResult(result)) throwServiceError(result, "Listen inline transcript could not be read");
  }
  return { text: "", inlineColumns: null };
}

async function queryInlineTranscript(
  database: { query: Function },
  columns: (typeof INLINE_TRANSCRIPT_CANDIDATES)[number],
  conversationId: string,
): Promise<string> {
  return transcriptFromInlineRows(await queryInlineTranscriptResult(database, columns, conversationId));
}

async function queryInlineTranscriptResult(
  database: { query: Function },
  columns: (typeof INLINE_TRANSCRIPT_CANDIDATES)[number],
  conversationId: string,
): Promise<ServiceResult> {
  const selected = [
    columns.transcriptJson ? `${sqlIdentifier(columns.transcriptJson)} AS transcript_json` : "NULL AS transcript_json",
    columns.transcriptText ? `${sqlIdentifier(columns.transcriptText)} AS transcript_text` : "NULL AS transcript_text",
  ];
  return database.query(
    `SELECT ${selected.join(", ")} FROM conversation WHERE "id" = ? LIMIT 1`,
    [conversationId],
  ) as Promise<ServiceResult>;
}

function transcriptFromInlineRows(result: ServiceResult): string {
  const rows = serviceRows(result, "Listen inline transcript could not be read");
  const row = rows[0];
  if (!row) return "";
  const inlineJson = valueFromRow(row, result.data?.columns, "transcript_json", 0);
  const fromJson = transcriptText(inlineJson);
  if (fromJson.trim()) return fromJson;
  return optionalText(valueFromRow(row, result.data?.columns, "transcript_text", 1)) ?? "";
}

function transcriptText(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed !== value) {
        const rendered = transcriptText(parsed);
        if (rendered) return rendered;
      }
    } catch {
      return trimmed;
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => transcriptEntryText(entry)).filter(Boolean).join("\n").trim();
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["turns", "segments", "utterances", "transcript"]) {
      const rendered = transcriptText(record[key]);
      if (rendered) return rendered;
    }
    return transcriptEntryText(record);
  }
  return "";
}

function transcriptEntryText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  const text = [record.text, record.content, record.transcript].find((entry) => typeof entry === "string") as string | undefined;
  if (!text?.trim()) return "";
  const speaker = [record.speaker_name, record.speakerName, record.speaker].find((entry) => typeof entry === "string") as string | undefined;
  return speaker?.trim() ? `${speaker.trim()}: ${text.trim()}` : text.trim();
}

function serviceRows(result: ServiceResult, message: string): unknown[] {
  if (result.ok !== true) throwServiceError(result, message);
  return Array.isArray(result.data?.rows) ? result.data.rows : [];
}

function throwServiceError(result: ServiceResult, message: string): never {
  const code = typeof result.error?.code === "string" ? result.error.code : "unknown";
  const detail = typeof result.error?.message === "string" ? result.error.message : "";
  if (code === "AUTH_UNAUTHORIZED" || /unauthorized action/i.test(detail)) {
    throw new FeedHostError("Listen delegated access was denied", 403, "source_access_denied");
  }
  throw new FeedHostError(message, 502, "source_read_failed");
}

function isNotFound(result: ServiceResult): boolean {
  return result.error?.code === "KV_NOT_FOUND" || result.error?.code === "NOT_FOUND";
}

function isMissingColumnResult(result: ServiceResult): boolean {
  const code = typeof result.error?.code === "string" ? result.error.code : "";
  const message = typeof result.error?.message === "string" ? result.error.message : "";
  return code === "SQL_SCHEMA_ERROR" || /no such column|unknown column/i.test(message);
}

function valueFromRow(row: unknown, columns: string[] | undefined, name: string, fallbackIndex: number): unknown {
  if (row && typeof row === "object" && !Array.isArray(row)) return (row as Record<string, unknown>)[name];
  if (!Array.isArray(row)) return undefined;
  const index = columns?.indexOf(name) ?? -1;
  return row[index >= 0 ? index : fallbackIndex];
}

function optionalText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function sqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new FeedHostError("Listen conversation schema contains an unsafe column", 502, "source_schema_invalid");
  }
  return `"${value}"`;
}

function truncateCharacters(value: string, maximum: number): string {
  return [...value].slice(0, maximum).join("");
}

function truncateUtf8(value: string, maximumBytes: number): { text: string; bytes: number } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maximumBytes) return { text: value, bytes: encoded.byteLength };
  let end = maximumBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
  const text = encoded.subarray(0, end).toString("utf8").trimEnd();
  return { text, bytes: Buffer.byteLength(text, "utf8") };
}

function fitListenSourceItem(
  existingItems: ListenSourceItem[],
  candidate: ConversationCandidate,
  transcript: string,
  nextCursor: ListenSourceCursor,
): ListenSourceItem | undefined {
  const fullBytes = Buffer.byteLength(transcript, "utf8");
  const itemBase = {
    conversationId: candidate.id,
    title: truncateCharacters(candidate.title || candidate.id, MAX_TITLE_CHARS),
    startedAt: candidate.startedAt,
    transcriptSha256: `sha256:${createHash("sha256").update(transcript).digest("hex")}`,
  };
  let low = 1;
  let high = Math.min(fullBytes, MAX_LISTEN_SOURCE_ITEM_BYTES);
  let best: ListenSourceItem | undefined;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const capped = truncateUtf8(transcript, midpoint);
    if (!capped.text.trim()) {
      low = midpoint + 1;
      continue;
    }
    const item: ListenSourceItem = {
      ...itemBase,
      transcript: capped.text,
      transcriptBytes: capped.bytes,
      truncated: capped.bytes < fullBytes,
    };
    if (serializedBatchBytes([...existingItems, item], nextCursor) <= MAX_LISTEN_SOURCE_BATCH_BYTES) {
      best = item;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return best;
}

function finalizeBatch(items: ListenSourceItem[], nextCursor: ListenSourceCursor | null): ListenSourceBatch {
  return { items, nextCursor, count: items.length, bytes: serializedBatchBytes(items, nextCursor) };
}

function serializedBatchBytes(items: ListenSourceItem[], nextCursor: ListenSourceCursor | null): number {
  let bytes = 0;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const measured = Buffer.byteLength(JSON.stringify({ items, nextCursor, count: items.length, bytes }), "utf8");
    if (measured === bytes) return bytes;
    bytes = measured;
  }
  return bytes;
}

function isRfc3339Timestamp(value: unknown): value is string {
  return typeof value === "string" &&
    value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function disableSourceContentDebugging(): void {
  process.env.TinyCloud_debug = "0";
  (globalThis as typeof globalThis & { TinyCloud_debug?: boolean }).TinyCloud_debug = false;
  disableTinyCloudDebug({ persist: false });
}
