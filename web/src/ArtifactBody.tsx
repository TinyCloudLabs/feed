// Editorial artifact rendering, following the distillery feed's reading
// experience: markdown renders as prose, sections read as serif-titled
// passages, and only artifacts with no recognizable editorial shape fall back
// to the structured key/value dump (kept for debuggability, not as the
// default reading surface).
import { marked } from "marked";
import type { ArtifactExpansionSection } from "../../shared/feed-item.ts";

marked.setOptions({ gfm: true, breaks: false });

type ArtifactBodyProps = {
  body: unknown;
  targetSection?: ArtifactExpansionSection;
};

type EditorialSection = { sectionId?: string; title?: string; text: string };

type EditorialQuality = { criticPass?: boolean; quotesVerified?: boolean };

// One normalized editorial view over the two body shapes in the wild:
// the Feed v1 contract ({ markdown, sections }) and migrated distillery
// artifacts, whose body nests the whole legacy object ({ headline,
// body: markdown, quote, attribution, tags, quality, ... }).
type Editorial = {
  markdown?: string;
  sections: EditorialSection[];
  quote?: { text: string; attribution?: string };
  tags: string[];
  quality?: EditorialQuality;
};

const MAX_RENDER_DEPTH = 8;

// Keys the editorial view consumes from a legacy body; whatever remains
// shows under "More detail" instead of being silently dropped.
const LEGACY_CONSUMED_KEYS = new Set([
  "type", "headline", "body", "quote", "attribution", "tags", "quality",
  "id", "generated_at", "producer", "approval_status", "hero_image",
  "source_transcripts", "source_quotes",
]);

function editorialView(body: unknown): Editorial {
  if (typeof body === "string" && body.trim()) {
    return { markdown: body, sections: [], tags: [] };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { sections: [], tags: [] };
  }
  const record = body as Record<string, unknown>;
  const markdown = typeof record.markdown === "string" && record.markdown.trim() ? record.markdown : undefined;
  const sections = editorialSections(body);
  if (markdown || sections.length > 0) {
    return { markdown, sections, tags: [] };
  }
  // Legacy/distillery shape: headline plus a markdown string under `body`.
  if (typeof record.headline === "string" && typeof record.body === "string" && record.body.trim()) {
    const rawQuality = record.quality as Record<string, unknown> | undefined;
    return {
      markdown: record.body,
      sections: [],
      quote: typeof record.quote === "string" && record.quote.trim()
        ? { text: record.quote, attribution: typeof record.attribution === "string" ? record.attribution : undefined }
        : undefined,
      tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === "string") : [],
      quality: rawQuality && typeof rawQuality === "object"
        ? {
            criticPass: typeof rawQuality.critic_pass === "boolean" ? rawQuality.critic_pass : undefined,
            quotesVerified: typeof rawQuality.quotes_verified === "boolean" ? rawQuality.quotes_verified : undefined,
          }
        : undefined,
    };
  }
  return { sections: [], tags: [] };
}

function editorialSections(body: unknown): EditorialSection[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const sections = (body as Record<string, unknown>).sections;
  if (!Array.isArray(sections)) return [];
  return sections.filter((section): section is EditorialSection =>
    Boolean(section && typeof section === "object" && typeof (section as EditorialSection).text === "string"));
}

// Everything the editorial view renders, so the structured fallback only
// shows what would otherwise be lost.
function residualBody(body: unknown, legacy: boolean): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const rest = Object.fromEntries(
    Object.entries(record).filter(([key]) =>
      legacy ? !LEGACY_CONSUMED_KEYS.has(key) : key !== "markdown" && key !== "sections"),
  );
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function Markdown({ text }: { text: string }) {
  // Artifact content comes from the user's own workflow pipeline (the same
  // trust boundary distillery shipped with).
  return <div className="artifact-prose" dangerouslySetInnerHTML={{ __html: marked.parse(text, { async: false }) }} />;
}

function Section({ section, headingId, labelled = false }: { section: EditorialSection; headingId?: string; labelled?: boolean }) {
  const id = headingId ?? (section.sectionId ? `section-${encodeURIComponent(section.sectionId)}` : undefined);
  // Only the targeted section becomes a named region — the same section can
  // render inside several cards' complete views, and duplicate region names
  // are both an a11y smell and ambiguous for assistive tech.
  return (
    <section className="artifact-section" aria-labelledby={labelled ? id : undefined}>
      {section.title && <h3 id={labelled ? id : undefined}>{section.title}</h3>}
      <p className="artifact-text">{section.text}</p>
    </section>
  );
}

export function ArtifactBody({ body, targetSection }: ArtifactBodyProps) {
  const view = editorialView(body);
  const isEditorial = Boolean(view.markdown || view.sections.length > 0);
  const isLegacyShape = isEditorial && Boolean(view.quote || view.tags.length > 0 || view.quality);
  const residual = residualBody(body, isLegacyShape);
  const targetHeadingId = targetSection ? `section-${encodeURIComponent(targetSection.sectionId)}` : undefined;
  const otherSections = view.sections.filter((section) => section.sectionId !== targetSection?.sectionId);

  const complete = isEditorial ? (
    <>
      {view.quote && (
        <blockquote className="pull">
          <p>&ldquo;{view.quote.text}&rdquo;</p>
          {view.quote.attribution && <cite>{view.quote.attribution}</cite>}
        </blockquote>
      )}
      {view.markdown && <Markdown text={view.markdown} />}
      {otherSections.map((section, index) => (
        <Section key={section.sectionId ?? index} section={section} />
      ))}
      {view.tags.length > 0 && (
        <div className="artifact-tags">
          {view.tags.map((tag) => <span key={tag}>{tag}</span>)}
        </div>
      )}
      {view.quality && (view.quality.criticPass !== undefined || view.quality.quotesVerified !== undefined) && (
        <p className="artifact-foot">
          {view.quality.criticPass !== undefined && `${view.quality.criticPass ? "✓" : "✗"} critic`}
          {view.quality.criticPass !== undefined && view.quality.quotesVerified !== undefined && " · "}
          {view.quality.quotesVerified !== undefined && `${view.quality.quotesVerified ? "✓" : "✗"} quotes`}
        </p>
      )}
      {residual !== undefined && (
        <details className="artifact-more">
          <summary>More detail</summary>
          <StructuredValue value={residual} depth={0} />
        </details>
      )}
    </>
  ) : (
    <StructuredValue value={body} depth={0} />
  );

  return (
    <div className="artifact-body">
      {targetSection && (
        <Section
          section={{ sectionId: targetSection.sectionId, title: targetSection.title ?? "Related section", text: targetSection.text }}
          headingId={targetHeadingId}
          labelled
        />
      )}
      {targetSection ? (
        <details className="artifact-complete">
          <summary>Show all sections</summary>
          {complete}
        </details>
      ) : (
        <section className="artifact-complete" aria-label="Complete artifact">
          {complete}
        </section>
      )}
    </div>
  );
}

function StructuredValue({ value, depth }: { value: unknown; depth: number }) {
  if (value === null || value === undefined) return null;
  if (depth >= MAX_RENDER_DEPTH) return <p className="artifact-text">Additional detail omitted.</p>;
  if (typeof value === "string") return <p className="artifact-text">{value}</p>;
  if (typeof value === "number" || typeof value === "boolean") return <span>{String(value)}</span>;
  if (Array.isArray(value)) {
    return (
      <ul className="artifact-list">
        {value.map((entry, index) => (
          <li key={stableEntryKey(entry, index)}><StructuredValue value={entry} depth={depth + 1} /></li>
        ))}
      </ul>
    );
  }
  if (typeof value !== "object") return null;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== null && entry !== undefined && entry !== "");
  if (entries.length === 0) return null;

  return (
    <dl className={depth === 0 ? "artifact-fields artifact-fields-root" : "artifact-fields"}>
      {entries.map(([key, entry]) => (
        <div key={key}>
          <dt>{readableKey(key)}</dt>
          <dd><StructuredValue value={entry} depth={depth + 1} /></dd>
        </div>
      ))}
    </dl>
  );
}

function readableKey(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : value;
}

function stableEntryKey(value: unknown, index: number): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of ["sectionId", "id", "title", "heading"]) {
      if (typeof record[key] === "string" && record[key]) return `${record[key]}-${index}`;
    }
  }
  return String(index);
}
