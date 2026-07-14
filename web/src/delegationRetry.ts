export function isRetryableDelegationConflict(error: unknown): boolean {
  const detail = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).toLowerCase();
  return detail.includes("could not serialize access") || detail.includes("epoch insert failed");
}

export function isRetryableSpaceCreationFailure(error: unknown): boolean {
  const detail = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return detail.includes("failed to create space:");
}
