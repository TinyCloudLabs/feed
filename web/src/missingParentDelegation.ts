const MISSING_PARENT_CODES = new Set([
  "MISSING_PARENT_DELEGATION",
  "PARENT_DELEGATION_NOT_FOUND",
]);

const MISSING_PARENT_MESSAGE = /\bcannot find parent delegation\b/i;

/**
 * Narrowly identifies the node failure emitted when a restored browser
 * session points at a parent delegation the node no longer knows about.
 */
export function isMissingParentDelegationError(error: unknown): boolean {
  const seen = new Set<object>();

  const matches = (value: unknown, depth: number): boolean => {
    if (depth > 5 || value == null) return false;
    if (typeof value === "string") {
      if (MISSING_PARENT_MESSAGE.test(value)) return true;
      const trimmed = value.trim();
      if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length <= 20_000) {
        try {
          return matches(JSON.parse(trimmed), depth + 1);
        } catch {
          return false;
        }
      }
      return false;
    }
    if (typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);

    const record = value as Record<string, unknown>;
    const code = record.code;
    if (typeof code === "string" && MISSING_PARENT_CODES.has(code.toUpperCase())) return true;

    return [
      record.message,
      record.cause,
      record.error,
      record.reason,
      record.body,
      record.data,
      record.response,
    ].some((candidate) => matches(candidate, depth + 1));
  };

  return matches(error, 0);
}

export type MissingParentRecoveryOutcome = "healed" | "reconnect_required";

export type MissingParentRecoveryResult<T> =
  | { status: "healed"; value: T }
  | { status: "reconnect_required"; error: unknown };

/**
 * Clears the dead session, attempts one silent bootstrap, and retries the
 * failed operation exactly once. UI/popup decisions stay in the injected
 * reauthenticate function so this coordinator cannot initiate a wallet flow.
 */
export async function recoverMissingParentDelegation<T>(input: {
  initialError: unknown;
  clearSession: () => Promise<void>;
  reauthenticateSilently: () => Promise<boolean>;
  retry: () => Promise<T>;
  onOutcome: (outcome: MissingParentRecoveryOutcome) => void;
}): Promise<MissingParentRecoveryResult<T>> {
  if (!isMissingParentDelegationError(input.initialError)) throw input.initialError;

  await input.clearSession();

  let reauthenticated = false;
  try {
    reauthenticated = await input.reauthenticateSilently();
  } catch {
    // A silent bootstrap that cannot complete must fall back to explicit,
    // user-initiated reconnect instead of opening or retrying another flow.
  }

  if (!reauthenticated) {
    input.onOutcome("reconnect_required");
    return { status: "reconnect_required", error: input.initialError };
  }

  try {
    const value = await input.retry();
    input.onOutcome("healed");
    return { status: "healed", value };
  } catch (error) {
    if (!isMissingParentDelegationError(error)) throw error;
    // Do not leave the second dead session cached. This is cleanup, not a
    // third attempt; retry() is intentionally never called again.
    await input.clearSession();
    input.onOutcome("reconnect_required");
    return { status: "reconnect_required", error };
  }
}
