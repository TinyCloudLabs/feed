export function runLogTail(log: readonly string[] | undefined, limit = 6): string[] {
  if (!log || limit <= 0) return [];
  return log.slice(-limit);
}

export function formatRunAge(startedAt: number | undefined, now = Date.now()): string | null {
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  const elapsed = Math.max(0, now - startedAt);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "less than 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours} hr` : `${hours} hr ${rem} min`;
}
