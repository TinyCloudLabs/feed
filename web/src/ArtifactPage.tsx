import { useEffect, useState } from "react";
import type { FeedArtifact, FeedbackEvent } from "../../../artifactory/skills/_shared/lib/feed-v1.ts";
import { postsFromArtifact, type FeedItemProjection, type FeedPost } from "../../shared/feed-item.ts";
import { ArtifactBody } from "./ArtifactBody.tsx";
import { feedKickerSegments, readableSourceSummary } from "./feedModel.ts";

export type ArtifactPageState = "loading" | "ready" | "gone" | "error";

type ArtifactPageProps = {
  feedItemId: string;
  artifactId: string;
  artifact: FeedArtifact | null;
  projection?: FeedItemProjection;
  postId?: string;
  state: ArtifactPageState;
  error?: string;
  heroUrl: string;
  busyAction: string | null;
  onBack: () => void;
  onRetry: () => void;
  onFeedback: (
    signal: FeedbackEvent["signal"],
    payload?: unknown,
    attemptKey?: string,
  ) => Promise<boolean>;
  onResetAttempt: (attemptKey: string) => void;
};

export function ArtifactPage({
  feedItemId,
  artifactId,
  artifact,
  projection,
  postId,
  state,
  error,
  heroUrl,
  busyAction,
  onBack,
  onRetry,
  onFeedback,
  onResetAttempt,
}: ArtifactPageProps) {
  const [heroFailed, setHeroFailed] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [noteAttemptKey, setNoteAttemptKey] = useState(() => crypto.randomUUID());
  const [interactionStatus, setInteractionStatus] = useState<string | null>(null);

  useEffect(() => {
    setHeroFailed(false);
  }, [artifactId]);

  const backLink = (
    <a
      className="artifact-back"
      href="#"
      onClick={(event) => {
        event.preventDefault();
        onBack();
      }}
    >
      ← Feed
    </a>
  );

  if (state === "loading") {
    return <main className="artifact-page">{backLink}<p className="artifact-page-state" role="status">Loading…</p></main>;
  }

  if (state === "gone") {
    return (
      <main className="artifact-page">
        {backLink}
        <section className="artifact-page-message" aria-labelledby="artifact-gone-title">
          <p className="card-meta">Artifact unavailable</p>
          <h2 id="artifact-gone-title">This artifact is no longer available.</h2>
        </section>
      </main>
    );
  }

  if (state === "error") {
    return (
      <main className="artifact-page">
        {backLink}
        <section className="artifact-page-message" role="alert">
          <p className="card-meta">Artifact unavailable</p>
          <h2>This artifact is temporarily unavailable.</h2>
          {error && <p>{error}</p>}
          <button onClick={onRetry}>Retry</button>
        </section>
      </main>
    );
  }

  if (!artifact) {
    return <main className="artifact-page">{backLink}<p className="artifact-page-state" role="status">Loading…</p></main>;
  }

  const targetPostId = projection?.target.kind === "post" ? projection.target.postId : postId;
  const post = targetPostId
    ? postsFromArtifact(artifact).find((candidate) => candidate.postId === targetPostId)
    : undefined;
  const verifiedQuotes = post?.evidence.filter(
    (entry): entry is Extract<FeedPost["evidence"][number], { kind: "verified_quote" }> =>
      entry.kind === "verified_quote",
  ) ?? [];
  const pullQuote = verifiedQuotes[0];
  const publishedAt = projection?.publishedAt ?? artifact.createdAt;
  const headline = post?.title ?? projection?.postTitle ?? artifact.title;
  const showHero = hasHeroReference(artifact.body) && !heroFailed;
  const isSaved = projection?.disposition === "saved";
  const actionId = (signal: FeedbackEvent["signal"]) => `${feedItemId}:${signal}`;

  const act = async (signal: FeedbackEvent["signal"]) => {
    setInteractionStatus(null);
    const ok = await onFeedback(signal);
    setInteractionStatus(ok ? feedbackSuccessLabel(signal) : "That change did not go through. Try again.");
    if (ok && signal === "hide") onBack();
  };

  return (
    <main className="artifact-page">
      {backLink}
      <article>
        <p className="card-meta artifact-kicker">
          {feedKickerSegments({ artifact, post, publishedAt }).map((segment) => <span key={segment}>{segment}</span>)}
        </p>
        <h2 className="artifact-page-title">{headline}</h2>

        {showHero && (
          <figure className="hero">
            <img
              src={heroUrl}
              alt=""
              loading="lazy"
              crossOrigin="use-credentials"
              onError={() => setHeroFailed(true)}
            />
          </figure>
        )}

        {post && <p className="post-body artifact-page-lede">{post.body}</p>}
        {pullQuote && <VerifiedQuote quote={pullQuote} />}

        <ArtifactBody body={artifact.body} />

        <section className="artifact-sources" aria-labelledby="artifact-sources-title">
          <h3 id="artifact-sources-title">Why you&apos;re seeing this</h3>
          <dl className="provenance">
            <div><dt>Made by</dt><dd>Feed</dd></div>
            <div><dt>Sources</dt><dd>{readableSourceSummary(artifact.sourceRefs)}</dd></div>
            <div><dt>Freshness</dt><dd>{humanize(artifact.freshness.label)}</dd></div>
          </dl>
          {artifact.producedBy.disclosure.userCopy && <p>{artifact.producedBy.disclosure.userCopy}</p>}
          <details className="source-moments">
            <summary>View sources and quoted moments</summary>
            <div className="source-moments-content">
              {verifiedQuotes.map((quote) => (
                <VerifiedQuote
                  key={quote.evidenceId}
                  quote={quote}
                  small
                  sourceTitle={sourceTitle(artifact, quote.sourceRefId)}
                />
              ))}
              {sourceTitles(artifact).length > 0 && (
                <ul className="source-title-list">
                  {sourceTitles(artifact).map(({ id, title }) => <li key={id}>{title}</li>)}
                </ul>
              )}
              {verifiedQuotes.length === 0 && sourceTitles(artifact).length === 0 && (
                <p className="source-empty">No quoted moments are available for this post.</p>
              )}
            </div>
          </details>
        </section>

        <div className="card-actions artifact-page-actions">
          <div className="card-actions-primary">
            <button
              disabled={busyAction === actionId(isSaved ? "unsave" : "save")}
              onClick={() => void act(isSaved ? "unsave" : "save")}
            >
              {isSaved ? "Saved" : "Save"}
            </button>
            <button disabled={busyAction === actionId("helpful")} onClick={() => void act("helpful")}>Helpful</button>
            <button onClick={() => setNoteOpen((open) => !open)} aria-expanded={noteOpen}>Add note</button>
          </div>
          <div className="card-actions-secondary">
            <button disabled={busyAction === actionId("unhelpful")} onClick={() => void act("unhelpful")}>Not helpful</button>
            <button disabled={busyAction === actionId("show_fewer")} onClick={() => void act("show_fewer")}>Show fewer like this</button>
            <button disabled={busyAction === actionId("hide")} onClick={() => void act("hide")}>Hide</button>
          </div>
        </div>

        {noteOpen && (
          <form className="note-form" onSubmit={(event) => {
            event.preventDefault();
            const trimmed = note.trim();
            if (!trimmed) return;
            setInteractionStatus(null);
            void onFeedback("text_note", { note: trimmed }, noteAttemptKey).then((ok) => {
              if (ok) {
                setNote("");
                setNoteOpen(false);
                setNoteAttemptKey(crypto.randomUUID());
                setInteractionStatus("Note saved.");
              } else {
                setInteractionStatus("Your note was not saved. Try again.");
              }
            });
          }}>
            <label htmlFor={`artifact-note-${feedItemId}`}>Private note</label>
            <textarea
              id={`artifact-note-${feedItemId}`}
              value={note}
              maxLength={1024}
              onChange={(event) => {
                setNote(event.target.value);
                onResetAttempt(noteAttemptKey);
                setNoteAttemptKey(crypto.randomUUID());
              }}
            />
            <div className="note-meta"><span>Only you can see this note.</span><span>{note.length}/1024</span></div>
            <div className="panel-actions">
              <button type="submit" className="primary" disabled={!note.trim() || busyAction === actionId("text_note")}>Save note</button>
              <button type="button" onClick={() => {
                onResetAttempt(noteAttemptKey);
                setNoteAttemptKey(crypto.randomUUID());
                setNoteOpen(false);
                setNote("");
              }}>Cancel</button>
            </div>
          </form>
        )}
        {interactionStatus && (
          <p className={`interaction-status${interactionStatus.includes("not") || interactionStatus.includes("did not") ? " error" : ""}`} role="status" aria-live="polite">
            {interactionStatus}
          </p>
        )}
      </article>
    </main>
  );
}

function VerifiedQuote({
  quote,
  small = false,
  sourceTitle: title,
}: {
  quote: Extract<FeedPost["evidence"][number], { kind: "verified_quote" }>;
  small?: boolean;
  sourceTitle?: string;
}) {
  return (
    <blockquote className={`pull${small ? " source-quote" : ""}`}>
      <p>&ldquo;{quote.quote}&rdquo;</p>
      <cite>{quote.sourceRefId}{quote.loc ? ` · ${quote.loc}` : ""} · verified</cite>
      {title && <span className="source-title">{title}</span>}
    </blockquote>
  );
}

function hasHeroReference(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const hero = (body as Record<string, unknown>).hero_image;
  if (typeof hero === "string") return hero.trim().length > 0;
  if (!hero || typeof hero !== "object" || Array.isArray(hero)) return false;
  return Object.values(hero).some((value) => typeof value === "string" && value.trim().length > 0);
}

function sourceTitle(artifact: FeedArtifact, sourceRefId: string): string | undefined {
  const source = artifact.sourceRefs.find((candidate) => candidate.sourceRefId === sourceRefId) as unknown as Record<string, unknown> | undefined;
  if (!source) return undefined;
  for (const key of ["title", "displayName", "name"]) {
    if (typeof source[key] === "string" && source[key].trim()) return source[key].trim();
  }
  return undefined;
}

function sourceTitles(artifact: FeedArtifact): Array<{ id: string; title: string }> {
  return artifact.sourceRefs.flatMap((source) => {
    const title = sourceTitle(artifact, source.sourceRefId);
    return title ? [{ id: source.sourceRefId, title }] : [];
  });
}

function humanize(value: string): string {
  const normalized = value.trim().replaceAll(/[_-]+/g, " ").replaceAll(/\s+/g, " ");
  if (!normalized) return "Feed post";
  return normalized[0]!.toUpperCase() + normalized.slice(1).toLowerCase();
}

function feedbackSuccessLabel(signal: FeedbackEvent["signal"]): string {
  switch (signal) {
    case "save": return "Saved.";
    case "unsave": return "Removed from saved.";
    case "hide": return "Hidden from your Feed.";
    case "helpful": return "Marked helpful.";
    case "unhelpful": return "Thanks. Feed will use that feedback.";
    case "show_fewer": return "Feed will show fewer posts like this.";
    case "unhide": return "Returned to your Feed.";
    case "text_note": return "Note saved.";
  }
}
