import type { ArtifactExpansionSection } from "../../shared/feed-item.ts";

type ArtifactBodyProps = {
  body: unknown;
  targetSection?: ArtifactExpansionSection;
};

const MAX_RENDER_DEPTH = 8;

export function ArtifactBody({ body, targetSection }: ArtifactBodyProps) {
  const targetHeadingId = targetSection ? `section-${encodeURIComponent(targetSection.sectionId)}` : undefined;
  return (
    <div className="artifact-body">
      {targetSection && (
        <section className="artifact-section" aria-labelledby={targetHeadingId}>
          <h3 id={targetHeadingId}>{targetSection.title ?? "Related section"}</h3>
          <p>{targetSection.text}</p>
        </section>
      )}
      {targetSection ? (
        <details className="artifact-complete">
          <summary>Show all sections</summary>
          <StructuredValue value={body} depth={0} />
        </details>
      ) : (
        <section className="artifact-complete" aria-label="Complete artifact">
          <StructuredValue value={body} depth={0} />
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
