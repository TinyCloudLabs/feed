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

type EditorialMoment = {
  text: string;
  attribution?: string;
  source?: string;
  loc?: string;
};

// One normalized editorial view over the two body shapes in the wild:
// the Feed v1 contract ({ markdown, sections }) and migrated distillery
// artifacts, whose body nests the whole legacy object ({ headline,
// body: markdown, quote, attribution, tags, quality, ... }).
export type EditorialMetadata = {
  markdown?: string;
  sections: EditorialSection[];
  quote?: { text: string; attribution?: string };
  tags: string[];
  quality?: EditorialQuality;
  moments: EditorialMoment[];
};

const MAX_RENDER_DEPTH = 8;

// Keys the editorial view consumes from a legacy body; whatever remains
// shows under "More detail" instead of being silently dropped.
const EDITORIAL_CONSUMED_KEYS = new Set([
  "type", "headline", "body", "markdown", "sections", "quote", "attribution", "tags", "quality",
  "id", "generated_at", "producer", "approval_status", "hero_image",
  "hero_image_mime", "sourceQuotes", "generation_model", "legacyArtifactId",
  "legacyArtifactType", "source_transcripts", "source_quotes",
]);

export function hasHeroReference(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const hero = (body as Record<string, unknown>).hero_image;
  if (typeof hero === "string") return hero.trim().length > 0;
  if (!hero || typeof hero !== "object" || Array.isArray(hero)) return false;
  return Object.values(hero).some((value) => typeof value === "string" && value.trim().length > 0);
}

export function editorialMetadata(body: unknown): EditorialMetadata {
  if (typeof body === "string" && body.trim()) {
    return { markdown: body, sections: [], tags: [], moments: [] };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { sections: [], tags: [], moments: [] };
  }
  const record = body as Record<string, unknown>;
  const markdown = typeof record.markdown === "string" && record.markdown.trim() ? record.markdown : undefined;
  const sections = editorialSections(body);
  // Migrated/distillery bodies put markdown under `body`; worker-produced
  // Feed bodies put the same editorial metadata next to `markdown`. Read the
  // metadata independently of the prose shape so the modern path cannot
  // early-return and silently discard it.
  const legacyMarkdown = typeof record.headline === "string" && typeof record.body === "string" && record.body.trim()
    ? record.body
    : undefined;
  const quote = editorialQuote(record.quote, record.attribution);
  const rawQuality = record.quality && typeof record.quality === "object" && !Array.isArray(record.quality)
    ? record.quality as Record<string, unknown>
    : undefined;
  const quality = rawQuality
    ? {
        criticPass: booleanField(rawQuality, "critic_pass", "criticPass"),
        quotesVerified: booleanField(rawQuality, "quotes_verified", "quotesVerified"),
      }
    : undefined;
  return {
    markdown: markdown ?? legacyMarkdown,
    sections,
    quote,
    tags: stringArray(record.tags),
    quality,
    moments: quality?.quotesVerified === true
      ? editorialMoments(record.sourceQuotes ?? record.source_quotes)
      : [],
  };
}

function editorialQuote(value: unknown, attribution: unknown): EditorialMetadata["quote"] {
  if (typeof value === "string" && value.trim()) {
    return {
      text: value.trim(),
      ...(typeof attribution === "string" && attribution.trim() ? { attribution: attribution.trim() } : {}),
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const text = [record.text, record.quote].find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  if (!text) return undefined;
  const quoteAttribution = [record.attribution, record.speaker, attribution]
    .find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  return { text: text.trim(), ...(quoteAttribution ? { attribution: quoteAttribution.trim() } : {}) };
}

function booleanField(record: Record<string, unknown>, snake: string, camel: string): boolean | undefined {
  const value = record[snake] ?? record[camel];
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim()))];
}

function editorialMoments(value: unknown): EditorialMoment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const text = [record.quote, record.text]
      .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
    if (!text) return [];
    const attribution = [record.attribution, record.speaker]
      .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
    // Legacy sourceQuotes can carry local transcript paths. Those paths are
    // private implementation detail, not user-facing citation labels.
    const source = [record.sourceRefId, record.source]
      .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
    const loc = [record.loc, record.timestamp]
      .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
    return [{
      text: text.trim(),
      ...(attribution ? { attribution: attribution.trim() } : {}),
      ...(source ? { source: source.trim() } : {}),
      ...(loc ? { loc: loc.trim() } : {}),
    }];
  });
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
function residualBody(body: unknown, editorial: boolean): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const rest = Object.fromEntries(
    Object.entries(record).filter(([key]) =>
      editorial
        ? !EDITORIAL_CONSUMED_KEYS.has(key)
        : !["markdown", "sections", "hero_image", "hero_image_mime"].includes(key)),
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
  const view = editorialMetadata(body);
  const isEditorial = Boolean(view.markdown || view.sections.length > 0);
  const residual = residualBody(body, isEditorial);
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
      {(view.quality?.criticPass === true || view.quality?.quotesVerified === true) && (
        <p className="artifact-foot">
          {view.quality.criticPass === true && "✓ critic"}
          {view.quality.criticPass === true && view.quality.quotesVerified === true && " · "}
          {view.quality.quotesVerified === true && "✓ quotes"}
        </p>
      )}
      {view.moments.length > 0 && (
        <section className="artifact-moments" aria-labelledby="verified-moments-title">
          <h3 id="verified-moments-title">Verified moments</h3>
          {view.moments.map((moment, index) => (
            <blockquote className="pull source-quote" key={`${moment.source ?? "moment"}:${moment.loc ?? index}:${moment.text}`}>
              <p>&ldquo;{moment.text}&rdquo;</p>
              {(moment.attribution || moment.source || moment.loc || view.quality?.quotesVerified === true) && (
                <cite>
                  {[moment.attribution, moment.source, moment.loc, view.quality?.quotesVerified === true ? "verified" : undefined]
                    .filter(Boolean)
                    .join(" · ")}
                </cite>
              )}
            </blockquote>
          ))}
        </section>
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
