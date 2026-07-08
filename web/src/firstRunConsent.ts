import { DEFAULT_REVIEWED_BUNDLE } from "../../shared/default-reviewed-bundle.ts";

const FIRST_RUN_APPROVAL_PREFIX = "feed:v1:first-run-approval";

export function firstRunApprovalKey(hostOrigin: string): string {
  return [
    FIRST_RUN_APPROVAL_PREFIX,
    encodeURIComponent(DEFAULT_REVIEWED_BUNDLE.packageId),
    encodeURIComponent(hostOrigin),
    encodeURIComponent(DEFAULT_REVIEWED_BUNDLE.digest),
  ].join("/");
}
