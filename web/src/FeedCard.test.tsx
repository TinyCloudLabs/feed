import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CardThumbnail, FeedCard } from "./App.tsx";
import type { FeedItem } from "./feedModel.ts";

const noop = () => undefined;
const feedback = async () => true;

function cardItem(body: Record<string, unknown>): FeedItem {
  return {
    projection: {
      feedItemId: "legacy:editorial-card",
      target: { kind: "artifact_preview", artifactId: "editorial-card" },
      rankScore: 1,
      disposition: "default",
      visibility: "ranked",
      freshnessLabel: "fresh",
      reasonCodes: [],
      packageId: "editorial-worker",
      sourceFingerprint: "source:editorial-card",
      publishedAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    },
    artifact: {
      artifactId: "editorial-card",
      artifactType: "insight_card",
      title: "The card has a visible hero",
      body,
      sourceRefs: [
        { sourceKind: "listen_conversation" },
        { sourceKind: "listen_conversation" },
      ],
      freshness: { label: "fresh" },
      producedBy: { disclosure: {} },
    } as never,
  };
}

test("hero cards render a lazy fixed-aspect thumbnail and modern card metadata", () => {
  const html = renderToStaticMarkup(
    <FeedCard
      item={cardItem({
        markdown: "Modern body.",
        hero_image: "hero.png",
        quote: "A compact pull quote.",
        attribution: "Speaker",
        tags: ["one", "two", "three", "not-on-card"],
        quality: { critic_pass: true, quotes_verified: true },
      })}
      heroUrl="http://feed.test/artifacts/editorial-card/hero"
      busyAction={null}
      onPrioritize={noop}
      onFeedback={feedback}
      onResetAttempt={noop}
    />,
  );

  expect(html).toContain('class="card-thumbnail"');
  expect(html).toContain('style="aspect-ratio:4 / 3"');
  expect(html).toContain('src="http://feed.test/artifacts/editorial-card/hero"');
  expect(html).toContain('loading="lazy"');
  expect(html).toContain("2 sources");
  expect(html).toContain("A compact pull quote.");
  expect(html).toContain("✓ critic · ✓ quotes");
  expect(html).toContain(">one<");
  expect(html).toContain(">three<");
  expect(html).not.toContain("not-on-card");
});

test("a failed hero leaves no image or placeholder box", () => {
  const html = renderToStaticMarkup(
    <CardThumbnail
      src="http://feed.test/artifacts/missing/hero"
      failed
      onError={noop}
    />,
  );

  expect(html).toBe("");
  expect(html).not.toContain("img");
  expect(html).not.toContain("card-thumbnail");
});

test("false or absent quality fields do not render card badges", () => {
  const html = renderToStaticMarkup(
    <FeedCard
      item={cardItem({ markdown: "Modern body.", quality: { critic_pass: false, quotes_verified: false } })}
      heroUrl="http://feed.test/artifacts/editorial-card/hero"
      busyAction={null}
      onPrioritize={noop}
      onFeedback={feedback}
      onResetAttempt={noop}
    />,
  );

  expect(html).not.toContain("card-foot");
  expect(html).not.toContain("✓ critic");
  expect(html).not.toContain("✓ quotes");
});
