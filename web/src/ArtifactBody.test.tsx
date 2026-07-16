// The two artifact body shapes in the wild must both render editorially:
// the Feed v1 contract ({ markdown, sections }) and migrated distillery
// artifacts whose body nests the whole legacy object. The structured
// key/value dump is a fallback, never the reading surface for known shapes.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactBody } from "./ArtifactBody.tsx";

const LEGACY_BODY = {
  type: "insight-card",
  headline: "A synthetic legacy insight",
  body: "*The lede sets the thesis.*\n\n## A serif subhead\n\nProse under it.",
  quote: "The quote reads like it was said out loud.",
  attribution: "Hunter",
  tags: ["rendering", "legacy-shape"],
  quality: { critic_pass: true, quotes_verified: true },
  id: "legacy-check",
  generated_at: "2026-06-23T00:00:00.000Z",
  producer: "check",
  approval_status: "approved",
  source_transcripts: ["t1"],
  source_quotes: [],
};

test("migrated distillery bodies render as an article, not a field dump", () => {
  const html = renderToStaticMarkup(<ArtifactBody body={LEGACY_BODY} />);
  expect(html).toContain('class="pull"');
  expect(html).toContain("The quote reads like it was said out loud.");
  expect(html).toContain("<cite>Hunter</cite>");
  expect(html).toContain("artifact-prose");
  expect(html).toContain("A serif subhead");
  expect(html).toContain('class="artifact-tags"');
  expect(html).toContain("✓ critic · ✓ quotes");
  // The consumed legacy fields must not resurface as a raw dump.
  expect(html).not.toContain("Approval status");
  expect(html).not.toContain("Generated at");
});

test("contract bodies render markdown and sections editorially", () => {
  const html = renderToStaticMarkup(
    <ArtifactBody body={{ markdown: "# Title\n\nProse.", sections: [{ sectionId: "s1", title: "Section one", text: "Text." }] }} />,
  );
  expect(html).toContain("artifact-prose");
  expect(html).toContain("Section one");
  expect(html).not.toContain("artifact-fields");
});

test("unknown structured bodies still fall back to the structured view", () => {
  const html = renderToStaticMarkup(<ArtifactBody body={{ some: "thing", other: 2 }} />);
  expect(html).toContain("artifact-fields");
});
