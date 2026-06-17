import { marked } from "marked";
import DOMPurify from "dompurify";
import { useEffect, useState, type ReactNode } from "react";
import type { FeedCard, InteractionAction } from "./types.ts";
import { typeLabel } from "./formats.ts";
import { hydrateMedia, releaseMedia, recordInteraction } from "./feedClient.ts";

marked.setOptions({ gfm: true, breaks: false });

export function cardHref(card: FeedCard): string {
  return `/a/${encodeURIComponent(card.slug)}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Render markdown to HTML, then sanitize with a strict allowlist before it can
 *  reach dangerouslySetInnerHTML. `body_md` / `raw_artifact` are
 *  attacker-influenceable (an interaction or a compromised producer could embed
 *  <script>/<img onerror>), so marked's unsanitized output must never be
 *  injected raw — DOMPurify strips scripts, event handlers, and unsafe URIs. */
function md(text: string): string {
  const html = marked.parse(text, { async: false });
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

/** First markdown paragraph, for article excerpts on the card face. */
function firstParagraph(text: string): string {
  return text.split(/\n\s*\n/).find((p) => p.trim()) ?? text;
}

/* ---- glyphs: 1.6px-stroke outline icons in currentColor ---- */

type GlyphName = InteractionAction | "arrow" | "back";

export function Glyph({ name, size = 17 }: { name: GlyphName; size?: number }) {
  const paths: Record<GlyphName, ReactNode> = {
    more: <path d="M12 5v14M5 12h14" />,
    less: <path d="M5 12h14" />,
    save: <path d="M6 4h12v17l-6-4.5L6 21V4z" />,
    already_knew: <path d="M4 12.5l5.5 5.5L20 6.5" />,
    wrong: <path d="M6 6l12 12M18 6L6 18" />,
    promote: <path d="M7 17L17 7M9 7h8v8" />,
    arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
    back: <path d="M19 12H5M11 18l-6-6 6-6" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

/* ---- kicker: TYPE · DATE · N TRANSCRIPTS ---- */

function Kicker({ card }: { card: FeedCard }) {
  const sources = card.source_transcripts.length;
  const seeded = card.raw.seeded === true;
  return (
    <div className="kicker">
      <span className="kicker-type">{typeLabel(card.type)}</span>
      <span className="kicker-dot" aria-hidden="true" />
      <span>{fmtDate(card.published_at)}</span>
      {sources > 0 && (
        <>
          <span className="kicker-dot" aria-hidden="true" />
          <span>
            {sources} transcript{sources === 1 ? "" : "s"}
          </span>
        </>
      )}
      {seeded && (
        <span className="novelty">
          <span className="novelty-pip" aria-hidden="true" />
          Seeded
        </span>
      )}
    </div>
  );
}

function Body({ text }: { text: string }) {
  return <div className="card-body" dangerouslySetInnerHTML={{ __html: md(text) }} />;
}

/* ---- hero: hydrated from KV (media key -> base64 -> blob URL) ---- */

function Hero({ card, appsSpaceUri }: { card: FeedCard; appsSpaceUri: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const key = card.hero_image_key;
  useEffect(() => {
    if (!key) return;
    let alive = true;
    let acquired = false;
    hydrateMedia(appsSpaceUri, key)
      .then((u) => {
        if (!alive) {
          // Unmounted before resolve — release the reference we just took so the
          // blob URL is revoked (no leak).
          if (u) releaseMedia(key);
          return;
        }
        if (u) acquired = true;
        setUrl(u);
      })
      .catch((e) => {
        // Hide the figure (no silent broken-image frame), but SURFACE the error —
        // a non-404 hydrate failure is a real problem, not a missing hero.
        console.error(`hero hydrate failed (${key}):`, e);
        if (alive) setUrl(null);
      });
    return () => {
      alive = false;
      // Drop this mount's reference; revokes the blob URL when no card holds it.
      if (acquired) releaseMedia(key);
    };
  }, [key, appsSpaceUri]);

  if (!key || !url) return null;
  return (
    <figure className="hero">
      <img src={url} alt="" loading="lazy" decoding="async" />
    </figure>
  );
}

function VideoMedia({ card, appsSpaceUri }: { card: FeedCard; appsSpaceUri: string }) {
  const [url, setUrl] = useState<string | null>(card.video_url);
  const key = card.video_key;
  useEffect(() => {
    setUrl(card.video_url);
    if (!key) return;
    let alive = true;
    let acquired = false;
    hydrateMedia(appsSpaceUri, key, card.video_mime ?? "video/mp4")
      .then((u) => {
        if (!alive) {
          if (u) releaseMedia(key);
          return;
        }
        if (u) acquired = true;
        setUrl(u ?? card.video_url);
      })
      .catch((e) => {
        console.error(`video hydrate failed (${key}):`, e);
        if (alive) setUrl(card.video_url);
      });
    return () => {
      alive = false;
      if (acquired) releaseMedia(key);
    };
  }, [key, card.video_mime, card.video_url, appsSpaceUri]);

  if (!url) {
    return <Hero card={card} appsSpaceUri={appsSpaceUri} />;
  }
  return (
    <figure className="video-media">
      <video
        src={url}
        autoPlay
        loop
        muted
        controls
        playsInline
        preload="metadata"
      />
    </figure>
  );
}

/* ---- pull quote: red left rule, serif italic, mono cite ---- */

function QuoteBlock({ card }: { card: FeedCard }) {
  if (!card.quote) return null;
  return (
    <blockquote className="pull">
      <p>&ldquo;{card.quote}&rdquo;</p>
      {card.attribution && <cite>{card.attribution}</cite>}
    </blockquote>
  );
}

function Tags({
  card,
  activeTag,
  onTagFilter,
}: {
  card: FeedCard;
  activeTag: string | null;
  onTagFilter: (tag: string | null) => void;
}) {
  if (card.tags.length === 0) return null;
  return (
    <div className="tags">
      {card.tags.map((t) => {
        const active = activeTag === t;
        return (
          <button
            key={t}
            type="button"
            className={`tag${active ? " active" : ""}`}
            aria-pressed={active}
            onClick={() => onTagFilter(active ? null : t)}
          >
            {t}
          </button>
        );
      })}
    </div>
  );
}

/* ---- feedback: v1 subset — more / less / save.
   more  positive + generalize        (one-tap)
   less  negative + generalize        (optional note; hides card)
   save  utility                      (one-tap) */

const FB_ACTIONS: readonly InteractionAction[] = ["more", "less", "save"];

const FB_LABELS: Record<InteractionAction, string> = {
  more: "More",
  less: "Less",
  save: "Save",
  already_knew: "Knew it",
  wrong: "Wrong",
  promote: "Promote",
};

const FB_CONFIRM: Record<InteractionAction, string> = {
  more: "✓ More like this",
  less: "✓ Less — removed from feed",
  save: "✓ Saved",
  already_knew: "✓ Novelty noted",
  wrong: "✓ Flagged wrong",
  promote: "▸ Queued for deeper artifact",
};

/** Actions that prompt for an optional free-text note before sending. */
const FB_NOTED: ReadonlySet<InteractionAction> = new Set(["less", "wrong"]);

type FbState =
  | { kind: "idle" }
  | { kind: "noting"; action: InteractionAction }
  | { kind: "sending"; action: InteractionAction }
  | { kind: "sent"; action: InteractionAction };

export function FeedbackBar({
  card,
  appsSpaceUri,
  readerDid,
  onHide,
}: {
  card: FeedCard;
  appsSpaceUri: string;
  readerDid: string;
  onHide?: (id: string) => void;
}) {
  const [state, setState] = useState<FbState>({ kind: "idle" });
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const send = async (action: InteractionAction, noteText?: string) => {
    setState({ kind: "sending", action });
    setError(null);
    try {
      await recordInteraction(appsSpaceUri, {
        artifactId: card.id,
        artifactType: card.type,
        action,
        readerDid,
        note: noteText,
      });
      setNote("");
      setState({ kind: "sent", action });
      if (action === "less") onHide?.(card.id); // hide immediately client-side
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState({ kind: "idle" });
    }
  };

  const tap = (action: InteractionAction) => {
    if (state.kind === "sending") return;
    if (FB_NOTED.has(action)) {
      setNote("");
      setState({ kind: "noting", action });
    } else {
      void send(action);
    }
  };

  if (state.kind === "noting") {
    const action = state.action;
    return (
      <div className="fb">
        <div className="fb-note">
          <span className="fb-note-label">{FB_LABELS[action]}</span>
          <input
            type="text"
            value={note}
            placeholder="optional note…"
            aria-label={`Optional note for ${FB_LABELS[action]}`}
            autoFocus
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void send(action, note);
              if (e.key === "Escape") setState({ kind: "idle" });
            }}
          />
          <button type="button" className="quiet-link" onClick={() => void send(action, note)}>
            Send
          </button>
          <button type="button" className="quiet-link" onClick={() => setState({ kind: "idle" })}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fb">
      <div className="fb-row fb-row-3" role="group" aria-label="Feedback">
        {FB_ACTIONS.map((action) => {
          const on = state.kind === "sent" && state.action === action;
          return (
            <button
              key={action}
              type="button"
              className={`fb-action${on ? " is-on" : ""}`}
              aria-pressed={on}
              disabled={state.kind === "sending"}
              title={action}
              onClick={() => tap(action)}
            >
              <Glyph name={action} size={17} />
              <span>{FB_LABELS[action]}</span>
            </button>
          );
        })}
      </div>
      <div aria-live="polite">
        {state.kind === "sent" && <div className="fb-status">{FB_CONFIRM[state.action]}</div>}
        {error && <div className="fb-status error">Interaction failed ({error})</div>}
      </div>
    </div>
  );
}

/* ---- provenance microline ---- */

function Foot({ card }: { card: FeedCard }) {
  return (
    <div className="card-foot">
      <span>
        {card.critic_pass ? "✓" : "✗"} critic · {card.quotes_verified ? "✓" : "✗"} quotes
      </span>
      <span>{card.generation_model ?? ""}</span>
    </div>
  );
}

export function Card({
  card,
  appsSpaceUri,
  readerDid,
  activeTag,
  onTagFilter,
  onHide,
}: {
  card: FeedCard;
  appsSpaceUri: string;
  readerDid: string;
  activeTag: string | null;
  onTagFilter: (tag: string | null) => void;
  onHide?: (id: string) => void;
}) {
  const isArticle = card.render_type === "article";
  const isVideo = card.render_type === "video";
  const body = card.body_md
    ? isArticle
      ? firstParagraph(card.body_md)
      : card.body_md
    : undefined;

  return (
    <article className="card">
      <Kicker card={card} />
      <h2 className="headline">
        {isArticle ? <a href={cardHref(card)}>{card.headline}</a> : card.headline}
      </h2>
      {isVideo ? (
        <VideoMedia card={card} appsSpaceUri={appsSpaceUri} />
      ) : (
        <Hero card={card} appsSpaceUri={appsSpaceUri} />
      )}
      <QuoteBlock card={card} />
      {body && <Body text={body} />}
      {isArticle && card.body_md && (
        <a className="quiet-link read-link" href={cardHref(card)}>
          Continue reading <Glyph name="arrow" size={14} />
        </a>
      )}
      <Tags card={card} activeTag={activeTag} onTagFilter={onTagFilter} />
      <FeedbackBar
        card={card}
        appsSpaceUri={appsSpaceUri}
        readerDid={readerDid}
        onHide={onHide}
      />
      <Foot card={card} />
    </article>
  );
}

/** Full-page view for an article (or any card opened directly). */
export function FullCard({
  card,
  appsSpaceUri,
  readerDid,
  onHide,
}: {
  card: FeedCard;
  appsSpaceUri: string;
  readerDid: string;
  onHide?: (id: string) => void;
}) {
  const isVideo = card.render_type === "video";
  return (
    <article className="card article">
      <Kicker card={card} />
      <h1 className="headline">{card.headline}</h1>
      {isVideo ? (
        <VideoMedia card={card} appsSpaceUri={appsSpaceUri} />
      ) : (
        <Hero card={card} appsSpaceUri={appsSpaceUri} />
      )}
      <QuoteBlock card={card} />
      {card.body_md && <Body text={card.body_md} />}
      {card.tags.length > 0 && (
        <div className="tags">
          {card.tags.map((t) => (
            <span key={t} className="tag" role="presentation">
              {t}
            </span>
          ))}
        </div>
      )}
      <FeedbackBar
        card={card}
        appsSpaceUri={appsSpaceUri}
        readerDid={readerDid}
        onHide={onHide}
      />
      <Foot card={card} />
    </article>
  );
}
