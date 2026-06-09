import { spawnSync } from "node:child_process";

/**
 * Thin wrapper around the TinyCloud `tc` CLI.
 *
 * Feed is a read-only explorer: it shells out to `tc` exactly like
 * listen-importer's src/tc.ts does for writes, but only uses the read paths
 * (`sql query`, `kv get`, `kv list`). The active `tc` profile / session decides
 * which space and identity we read from.
 */

export interface TcOptions {
  /** tc profile name (`tc --profile <name>`). Falls back to the active profile. */
  profile?: string;
  /** Override the node URL (`tc --host <url>`). */
  host?: string;
}

export interface TcRunResult {
  stdout: string;
  stderr: string;
}

/** The `tc` binary to invoke. Override with FEED_TC_BIN (e.g. a tc-local shim). */
const TC_BIN = process.env.FEED_TC_BIN || "tc";

export function runTc(args: string[], options: TcOptions = {}): TcRunResult {
  const fullArgs = [
    ...(options.profile ? ["--profile", options.profile] : []),
    ...(options.host ? ["--host", options.host] : []),
    ...args,
  ];
  const result = spawnSync(TC_BIN, fullArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `tc exited ${result.status}`;
    throw new Error(`${TC_BIN} ${fullArgs.join(" ")} failed: ${detail}`);
  }

  return { stdout: result.stdout, stderr: result.stderr };
}

/** Parse a `tc --json` style response, surfacing structured error envelopes. */
function parseJson<T>(raw: string, context: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${context}: could not parse tc output as JSON:\n${raw}`);
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    "error" in parsed &&
    (parsed as { error: unknown }).error
  ) {
    const err = (parsed as { error: { message?: string; hint?: string } }).error;
    const hint = err.hint ? `\nhint: ${err.hint}` : "";
    throw new Error(`${context}: ${err.message ?? "tc error"}${hint}`);
  }
  return parsed as T;
}

export function authStatus(options: TcOptions = {}): Record<string, unknown> {
  const { stdout } = runTc(["--json", "auth", "status"], options);
  return parseJson(stdout, "auth status");
}

export interface SqlQueryResult {
  rows?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** Run a read-only SELECT against a space SQL database. */
export function sqlQuery(
  db: string,
  sql: string,
  params: unknown[] = [],
  options: TcOptions = {},
): Array<Record<string, unknown>> {
  const args = ["--json", "sql", "query", sql, "--db", db];
  if (params.length > 0) args.push("--params", JSON.stringify(params));
  const { stdout } = runTc(args, options);
  const parsed = parseJson<SqlQueryResult | Array<Record<string, unknown>>>(
    stdout,
    `sql query (${db})`,
  );
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.rows)) return parsed.rows;
  // Some CLI versions nest under { result: { rows } } or similar; be permissive.
  const nested = (parsed as Record<string, unknown>).result;
  if (nested && typeof nested === "object" && Array.isArray((nested as SqlQueryResult).rows)) {
    return (nested as SqlQueryResult).rows!;
  }
  return [];
}

/** Get a raw KV value as text. Returns null when the key does not exist. */
export function kvGet(key: string, options: TcOptions = {}): string | null {
  const result = spawnSync(
    TC_BIN,
    [
      ...(options.profile ? ["--profile", options.profile] : []),
      ...(options.host ? ["--host", options.host] : []),
      "kv",
      "get",
      key,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status === 0) return result.stdout;
  const stderr = (result.stderr || "").toLowerCase();
  if (stderr.includes("not found") || stderr.includes("404")) return null;
  throw new Error(`tc kv get ${key} failed: ${result.stderr.trim() || result.stdout.trim()}`);
}

/** List KV keys under a prefix. */
export function kvList(prefix: string, options: TcOptions = {}): string[] {
  const { stdout } = runTc(["--json", "kv", "list", "--prefix", prefix], options);
  const parsed = parseJson<unknown>(stdout, `kv list (${prefix})`);
  if (Array.isArray(parsed)) {
    return parsed.map((entry) =>
      typeof entry === "string" ? entry : String((entry as { key?: string }).key ?? ""),
    );
  }
  const keys = (parsed as { keys?: unknown }).keys;
  if (Array.isArray(keys)) {
    return keys.map((entry) =>
      typeof entry === "string" ? entry : String((entry as { key?: string }).key ?? ""),
    );
  }
  return [];
}
