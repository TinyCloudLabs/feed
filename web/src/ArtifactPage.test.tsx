import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FeedArtifact } from "../../../artifactory/skills/_shared/lib/feed-v1.ts";
import fixture from "../../shared/fixtures/rich-artifact.json";
import { ArtifactPage } from "./ArtifactPage.tsx";

const noop = () => undefined;
const feedback = async () => true;

test("renders the complete rich artifact with hero, verified moments, and private source titles", () => {
  const artifact = structuredClone(fixture) as unknown as FeedArtifact;
  (artifact.body as Record<string, unknown>).hero_image =
    `xyz.tinycloud.artifacts/media/${artifact.artifactId}/hero.png.b64`;
  (artifact.sourceRefs[0] as unknown as Record<string, unknown>).title = "Product review conversation";
  const post = artifact.posts![0]!;
  const feedItemId = `${artifact.artifactId}::${encodeURIComponent(post.postId)}`;

  const html = renderToStaticMarkup(
    <ArtifactPage
      feedItemId={feedItemId}
      artifactId={artifact.artifactId}
      artifact={artifact}
      postId={post.postId}
      state="ready"
      heroUrl={`http://feed.test/artifacts/${artifact.artifactId}/hero`}
      busyAction={null}
      onBack={noop}
      onRetry={noop}
      onFeedback={feedback}
      onResetAttempt={noop}
    />,
  );

  expect(html).toContain(`src="http://feed.test/artifacts/${artifact.artifactId}/hero"`);
  expect(html).toContain("Activation moved; the bottleneck did too");
  expect(html).toContain("Setup completion is up");
  expect(html).toContain("Why you&#x27;re seeing this");
  expect(html).toContain("View sources and quoted moments");
  expect(html).toContain("Product review conversation");
  expect(html).toContain("src-product-review · L42-L47 · verified");
  expect(html).toContain("The complete analysis remains type-specific");
  // Body sections must render on the page (the pre-page suite asserted
  // section content; the page must be equivalent or stronger).
  expect(html).toContain("Where activation now stalls");
  expect(html).toContain("A reversible next test");
  expect(html).toContain("Test an invite preview inside setup");
});

test("renders the gone state with the specified 424 copy", () => {
  const html = renderToStaticMarkup(
    <ArtifactPage
      feedItemId="legacy:gone"
      artifactId="gone"
      artifact={null}
      state="gone"
      heroUrl="http://feed.test/artifacts/gone/hero"
      busyAction={null}
      onBack={noop}
      onRetry={noop}
      onFeedback={feedback}
      onResetAttempt={noop}
    />,
  );

  expect(html).toContain("This artifact is no longer available.");
  expect(html).toContain("← Feed");
});
