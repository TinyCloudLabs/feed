// formats.ts — browser-safe label registry, mirrored from distillery
// (skills/_shared/lib/formats.ts). The viewer only needs the kicker labels;
// this stays pure data (no node builtins) so it bundles for the browser.
// Keyed by distillery `type` (the 8-value enum), independent of `render_type`.

export const FORMAT_LABELS: Record<string, string> = {
  "insight-card": "Insight",
  article: "Article",
  podcast: "Podcast",
  digest: "Digest",
  "social-post": "Social post",
  "investor-update-snippet": "Investor snippet",
  "quote-card": "Quote card",
  "person-brief": "Person brief",
};

/** Human kicker label for a distillery `type`, prettifying unknown types. */
export function typeLabel(type: string): string {
  const known = FORMAT_LABELS[type];
  if (known) return known;
  const words = type.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (words.length === 0) return "Artifact";
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}
