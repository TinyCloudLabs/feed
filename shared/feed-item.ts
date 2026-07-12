import type {
  FeedArtifact,
  FeedArtifactProjection,
  FeedbackEvent,
} from "../../artifactory/skills/_shared/lib/feed-v1.ts";

/**
 * Feed's local projection contract while the cross-repository artifact
 * contract is being finalized. Artifacts remain the hydration truth; this
 * type only carries enough post material to rank and render a feed item.
 */
export type FeedPost = {
  postId: string;
  postFingerprint: string;
  kind: string;
  title?: string;
  body: string;
  evidence: Array<
    | {
        kind: "verified_quote";
        evidenceId: string;
        sourceRefId: string;
        quote: string;
        loc?: string;
        verification: { method: "worker_source_quote_match"; sourceObservedHash: string };
      }
    | { kind: "located_source"; evidenceId: string; sourceRefId: string; loc: string; excerpt?: string }
    | { kind: "parent_artifact"; evidenceId: string; artifactId: string; sectionId?: string }
    | { kind: "analytic_inference"; evidenceId: string; rationale: string; supportedBy: string[] }
  >;
  expansionTarget: { artifactId: string; sectionId?: string };
};

export const FEED_POST_TITLE_MAX_CHARS = 240;
export const FEED_POST_BODY_MAX_CHARS = 4_000;

export type FeedItemTarget =
  | { kind: "post"; artifactId: string; postId: string }
  | { kind: "artifact_preview"; artifactId: string };

export type FeedItemProjection = {
  feedItemId: string;
  target: FeedItemTarget;
  rankScore: number;
  disposition: FeedArtifactProjection["disposition"];
  visibility: FeedArtifactProjection["visibility"];
  freshnessLabel: FeedArtifactProjection["freshnessLabel"];
  reasonCodes: string[];
  packageId: string;
  sourceFingerprint: string;
  publishedAt: string;
  updatedAt: string;
  postTitle?: string;
  postBody?: string;
  sectionRef?: string;
};

export type FeedInteractionTarget =
  | { kind: "artifact"; artifactId: string }
  | { kind: "post"; artifactId: string; postId: string }
  | { kind: "feed_item"; feedItemId: string };

export type FeedTargetedInteractionEvent = Omit<FeedbackEvent, "artifactId"> & {
  target: FeedInteractionTarget;
};

export type PostArtifactBody = {
  text?: string;
  sections?: Array<{
    sectionId: string;
    title?: string;
    text: string;
  }>;
};

export function feedItemIdForPost(artifactId: string, postId: string): string {
  return `${artifactId}::${encodeURIComponent(postId)}`;
}

export function postsFromArtifact(artifact: FeedArtifact): FeedPost[] {
  const artifactContract = artifact as unknown as {
    feedSurface?: { mode?: "posts" | "artifact_preview" | "none" };
    derivedAccess?: { releasePolicy?: "private" | "delegated" | "public" };
    posts?: unknown;
  };
  if (artifactContract.feedSurface?.mode && artifactContract.feedSurface.mode !== "posts") return [];
  if (artifactContract.feedSurface?.mode === "posts" && !artifactContract.derivedAccess?.releasePolicy) return [];
  const posts = artifactContract.posts;
  if (!Array.isArray(posts)) return [];
  const seen = new Set<string>();
  const valid: FeedPost[] = [];
  for (const value of posts) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const postId = typeof record.postId === "string" ? record.postId.trim() : "";
    const postFingerprint = typeof record.postFingerprint === "string" ? record.postFingerprint.trim() : "";
    const body = typeof record.body === "string" ? record.body.trim() : "";
    const expansionTarget = record.expansionTarget;
    if (
      !postId ||
      !postFingerprint ||
      !body ||
      Array.from(body.normalize("NFC")).length > FEED_POST_BODY_MAX_CHARS ||
      seen.has(postId) ||
      !expansionTarget ||
      typeof expansionTarget !== "object" ||
      Array.isArray(expansionTarget) ||
      (expansionTarget as Record<string, unknown>).artifactId !== artifact.artifactId
    ) continue;
    const kind = typeof record.kind === "string" ? record.kind.trim() : "";
    if (!kind) continue;
    const title = typeof record.title === "string" ? record.title.trim() : undefined;
    if (title && Array.from(title.normalize("NFC")).length > FEED_POST_TITLE_MAX_CHARS) continue;
    seen.add(postId);
    valid.push({
      postId,
      postFingerprint,
      kind,
      body,
      evidence: Array.isArray(record.evidence) ? record.evidence as FeedPost["evidence"] : [],
      expansionTarget: {
        artifactId: artifact.artifactId,
        ...(typeof (expansionTarget as Record<string, unknown>).sectionId === "string"
          ? { sectionId: (expansionTarget as Record<string, unknown>).sectionId as string }
          : {}),
      },
      ...(title ? { title } : {}),
    });
  }
  return valid;
}

export type ArtifactExpansionSection = { sectionId: string; title?: string; text: string };

export function artifactExpansionSection(
  artifact: FeedArtifact,
  sectionRef?: string,
): ArtifactExpansionSection | undefined {
  if (!sectionRef) return undefined;
  const hinted = sectionFromRenderHints(artifact, sectionRef);
  return hinted ?? sectionFromBody(artifact.body, sectionRef);
}

export function artifactSectionText(artifact: FeedArtifact, sectionRef?: string): string | undefined {
  return artifactExpansionSection(artifact, sectionRef)?.text;
}

function sectionFromRenderHints(artifact: FeedArtifact, sectionRef: string): ArtifactExpansionSection | undefined {
  const hints = artifact.renderHints;
  if (!hints || typeof hints !== "object" || Array.isArray(hints)) return undefined;
  for (const key of ["sectionTargets", "sections", "anchors"]) {
    const entries = hints[key];
    if (!Array.isArray(entries)) continue;
    for (const value of entries) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if (![entry.sectionId, entry.id, entry.anchor].includes(sectionRef)) continue;
      const path = typeof entry.bodyPath === "string" ? entry.bodyPath : typeof entry.path === "string" ? entry.path : undefined;
      const target = path ? valueAtBodyPath(artifact.body, path) : entry;
      const section = sectionFromValue(target, sectionRef, entry.title);
      if (section) return section;
    }
  }
  return undefined;
}

function sectionFromBody(value: unknown, sectionRef: string): ArtifactExpansionSection | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const child of value) {
      const section = sectionFromBody(child, sectionRef);
      if (section) return section;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if ([record.sectionId, record.id, record.anchor].includes(sectionRef)) {
    const section = sectionFromValue(record, sectionRef, record.title);
    if (section) return section;
  }
  for (const child of Object.values(record)) {
    const section = sectionFromBody(child, sectionRef);
    if (section) return section;
  }
  return undefined;
}

function sectionFromValue(value: unknown, sectionId: string, hintedTitle?: unknown): ArtifactExpansionSection | undefined {
  if (typeof value === "string") return { sectionId, text: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const text = ["text", "markdown", "summary", "body", "content"]
    .map((key) => record[key])
    .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
  if (!text) return undefined;
  const title = typeof hintedTitle === "string" && hintedTitle.trim()
    ? hintedTitle.trim()
    : typeof record.title === "string" && record.title.trim()
      ? record.title.trim()
      : undefined;
  return { sectionId, text, ...(title ? { title } : {}) };
}

function valueAtBodyPath(body: unknown, path: string): unknown {
  const parts = path.startsWith("/")
    ? path.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    : path.split(".");
  let current = body;
  for (const part of parts.filter(Boolean)) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export type FeedContractValidation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const INTERACTION_SIGNALS = new Set([
  "save", "unsave", "hide", "unhide", "helpful", "unhelpful", "show_fewer", "text_note",
]);

export function validateFeedItemProjection(value: unknown): FeedContractValidation<FeedItemProjection> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["projection must be an object"] };
  const projection = value as Record<string, unknown>;
  const errors: string[] = [];
  const feedItemId = requiredString(projection.feedItemId, "feedItemId", errors);
  const target = validateFeedItemTarget(projection.target, errors);
  if (target && feedItemId) {
    const expected = target.kind === "post"
      ? feedItemIdForPost(target.artifactId, target.postId)
      : `legacy:${target.artifactId}`;
    if (feedItemId !== expected) errors.push("feedItemId: does not match target identity");
  }
  if (typeof projection.rankScore !== "number" || !Number.isFinite(projection.rankScore)) errors.push("rankScore: required finite number");
  if (!["default", "saved", "hidden"].includes(String(projection.disposition))) errors.push("disposition: invalid");
  if (!["ranked", "deferred", "capped", "hidden", "repair_only"].includes(String(projection.visibility))) errors.push("visibility: invalid");
  for (const field of ["freshnessLabel", "packageId", "sourceFingerprint", "publishedAt", "updatedAt"] as const) {
    requiredString(projection[field], field, errors);
  }
  if (!Array.isArray(projection.reasonCodes) || !projection.reasonCodes.every((entry) => typeof entry === "string")) {
    errors.push("reasonCodes: required string array");
  }
  for (const field of ["publishedAt", "updatedAt"] as const) {
    if (typeof projection[field] === "string" && Number.isNaN(Date.parse(projection[field]))) errors.push(`${field}: invalid date`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: value as FeedItemProjection };
}

export function validateFeedItemProjectionJoin(
  projection: FeedItemProjection,
  artifact: FeedArtifact,
): FeedContractValidation<{ projection: FeedItemProjection; artifact: FeedArtifact }> {
  const errors: string[] = [];
  const target = projection.target;
  if (target.artifactId !== artifact.artifactId) errors.push("target.artifactId: does not match hydrated artifact");
  if (target.kind === "post" && !postsFromArtifact(artifact).some((post) => post.postId === target.postId)) {
    errors.push("target.postId: missing from hydrated artifact");
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: { projection, artifact } };
}

export function validateFeedTargetedInteractionEvent(value: unknown): FeedContractValidation<FeedTargetedInteractionEvent> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["interaction must be an object"] };
  const event = value as Record<string, unknown>;
  const errors: string[] = [];
  for (const field of ["eventId", "actorId", "readerNonce", "createdAt"] as const) requiredString(event[field], field, errors);
  validateInteractionTarget(event.target, errors);
  if (!INTERACTION_SIGNALS.has(String(event.signal))) errors.push("signal: invalid");
  if (typeof event.createdAt === "string" && Number.isNaN(Date.parse(event.createdAt))) errors.push("createdAt: invalid date");
  return errors.length ? { ok: false, errors } : { ok: true, value: value as FeedTargetedInteractionEvent };
}

function validateFeedItemTarget(value: unknown, errors: string[]): FeedItemTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push("target: required object");
    return null;
  }
  const target = value as Record<string, unknown>;
  const artifactId = requiredString(target.artifactId, "target.artifactId", errors);
  if (target.kind === "artifact_preview") {
    if (Object.keys(target).some((key) => !["kind", "artifactId"].includes(key))) errors.push("target: artifact preview contains unsupported fields");
    if (target.postId !== undefined) errors.push("target.postId: forbidden for artifact preview");
    return artifactId ? { kind: "artifact_preview", artifactId } : null;
  }
  if (target.kind === "post") {
    if (Object.keys(target).some((key) => !["kind", "artifactId", "postId"].includes(key))) errors.push("target: post contains unsupported fields");
    const postId = requiredString(target.postId, "target.postId", errors);
    return artifactId && postId ? { kind: "post", artifactId, postId } : null;
  }
  errors.push("target.kind: invalid");
  return null;
}

function validateInteractionTarget(value: unknown, errors: string[]): FeedInteractionTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push("target: required object");
    return null;
  }
  const target = value as Record<string, unknown>;
  if (target.kind === "artifact") {
    if (Object.keys(target).some((key) => !["kind", "artifactId"].includes(key))) errors.push("target: artifact contains unsupported fields");
    if (target.postId !== undefined || target.feedItemId !== undefined) errors.push("target: artifact target has conflicting fields");
    const artifactId = requiredString(target.artifactId, "target.artifactId", errors);
    return artifactId ? { kind: "artifact", artifactId } : null;
  }
  if (target.kind === "post") {
    if (Object.keys(target).some((key) => !["kind", "artifactId", "postId"].includes(key))) errors.push("target: post contains unsupported fields");
    if (target.feedItemId !== undefined) errors.push("target: post target has conflicting fields");
    const artifactId = requiredString(target.artifactId, "target.artifactId", errors);
    const postId = requiredString(target.postId, "target.postId", errors);
    return artifactId && postId ? { kind: "post", artifactId, postId } : null;
  }
  if (target.kind === "feed_item") {
    if (Object.keys(target).some((key) => !["kind", "feedItemId"].includes(key))) errors.push("target: feed item contains unsupported fields");
    if (target.artifactId !== undefined || target.postId !== undefined) errors.push("target: feed item target has conflicting fields");
    const feedItemId = requiredString(target.feedItemId, "target.feedItemId", errors);
    return feedItemId ? { kind: "feed_item", feedItemId } : null;
  }
  errors.push("target.kind: invalid");
  return null;
}

function requiredString(value: unknown, path: string, errors: string[]): string | null {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path}: required string`);
    return null;
  }
  return value.trim();
}
