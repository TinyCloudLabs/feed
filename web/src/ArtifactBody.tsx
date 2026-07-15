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

const MAX_RENDER_DEPTH = 8;

function editorialMarkdown(body: unknown): string | undefined {
  if (typeof body === "string" && body.trim()) return body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const markdown = (body as Record<string, unknown>).markdown;
    if (typeof markdown === "string" && markdown.trim()) return markdown;
  }
  return undefined;
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
function residualBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const { markdown: _markdown, sections: _sections, ...rest } = body as Record<string, unknown>;
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
  const markdown = editorialMarkdown(body);
  const sections = editorialSections(body);
  const residual = residualBody(body);
  const isEditorial = Boolean(markdown || sections.length > 0);
  const targetHeadingId = targetSection ? `section-${encodeURIComponent(targetSection.sectionId)}` : undefined;
  const otherSections = sections.filter((section) => section.sectionId !== targetSection?.sectionId);

  const complete = isEditorial ? (
    <>
      {markdown && <Markdown text={markdown} />}
      {otherSections.map((section, index) => (
        <Section key={section.sectionId ?? index} section={section} />
      ))}
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
