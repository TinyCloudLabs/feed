import { describe, expect, test } from "bun:test";
import { confidenceText, summarizePreferenceSignals } from "./preferenceSignals.ts";
import type { InteractionAction, InteractionRow } from "./types.ts";

let nextId = 0;

function row(
  action: InteractionAction,
  artifactType = "article",
  note: string | null = null,
): InteractionRow {
  nextId += 1;
  const id = `${action}-${artifactType}-${nextId}`;
  return {
    id,
    artifact_id: `artifact-${id}`,
    artifact_type: artifactType,
    action,
    note,
    reader_did: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
    nonce: `nonce-${id}`,
    created_at: "2026-06-19T18:00:00.000Z",
    recorded_at: "2026-06-19T18:00:00.000Z",
  };
}

describe("preference signal summary", () => {
  test("keeps sparse feedback in early-signal mode", () => {
    const summary = summarizePreferenceSignals([
      row("more", "article"),
      row("save", "article", "useful"),
      row("less", "podcast", "thin"),
    ]);

    expect(summary.total).toBe(3);
    expect(summary.positive).toBe(2);
    expect(summary.negative).toBe(1);
    expect(summary.notes).toBe(2);
    expect(summary.confidence).toBe("early");
    expect(confidenceText(summary.confidence)).toBe("Early signal");
    expect(summary.actionLines).toEqual(["less 1", "more 1", "save 1"]);
    expect(summary.typeSignals[0]).toMatchObject({
      artifactType: "article",
      positive: 2,
      negative: 0,
      total: 2,
    });
  });

  test("only becomes directional after repeated aligned evidence", () => {
    const summary = summarizePreferenceSignals([
      row("more", "article"),
      row("more", "article"),
      row("save", "article"),
      row("save", "article"),
      row("promote", "digest"),
      row("more", "digest"),
      row("less", "podcast"),
      row("wrong", "social-post"),
    ]);

    expect(summary.total).toBe(8);
    expect(summary.positive).toBe(6);
    expect(summary.negative).toBe(2);
    expect(summary.confidence).toBe("directional");
    expect(confidenceText(summary.confidence)).toBe("Directional signal");
  });

  test("empty interaction history has no signal", () => {
    const summary = summarizePreferenceSignals([]);
    expect(summary.confidence).toBe("none");
    expect(summary.actionLines).toEqual([]);
    expect(summary.typeSignals).toEqual([]);
  });
});
