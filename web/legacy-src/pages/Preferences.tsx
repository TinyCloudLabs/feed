// Preferences.tsx — the `/preferences` page. There is no client-side learned-
// preferences store yet (the distill-preferences loop is server-side), so for
// the MVP we render the durable signal we DO have: the reader's interaction
// history from the interactions table, plus a placeholder noting where learned
// preferences will surface.

import { useEffect, useState } from "react";
import { loadInteractions } from "../feedClient.ts";
import { Shell } from "../Nav.tsx";
import type { InteractionRow } from "../types.ts";
import type { Session } from "../session.ts";
import { confidenceText, summarizePreferenceSignals } from "../preferenceSignals.ts";

const ACTION_LABEL: Record<string, string> = {
  more: "More like this",
  less: "Less like this",
  save: "Saved",
  already_knew: "Already knew",
  wrong: "Flagged wrong",
  promote: "Promote",
};

export function PreferencesPage({ session }: { session: Session }) {
  const [rows, setRows] = useState<InteractionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const summary = summarizePreferenceSignals(rows);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    loadInteractions(session.appsSpaceUri)
      .then((r) => {
        if (alive) setRows(r);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [session.appsSpaceUri]);

  return (
    <Shell title="Preferences" sub="interaction history">
      <div className="prefs">
        <section className="prefs-section">
          <h3>Signal summary</h3>
          <p className="prefs-note">
            Feed captures these interactions; Artifactory reads them before the
            next run as weak backpressure. Early feedback is noisy, so the agent
            preserves exploration until signals repeat.
          </p>
          {!loading && !error && rows.length > 0 && (
            <div className="signal-summary">
              <div className="signal-summary-head">
                <strong>{confidenceText(summary.confidence)}</strong>
                <span>
                  {summary.total} event{summary.total === 1 ? "" : "s"} ·{" "}
                  {summary.positive} positive · {summary.negative} suppressive
                  {summary.notes > 0 ? ` · ${summary.notes} note${summary.notes === 1 ? "" : "s"}` : ""}
                </span>
              </div>
              {summary.actionLines.length > 0 && (
                <p className="signal-line">{summary.actionLines.join(" · ")}</p>
              )}
              {summary.typeSignals.length > 0 && (
                <ul className="signal-types" aria-label="Artifact type signals">
                  {summary.typeSignals.slice(0, 5).map((signal) => (
                    <li key={signal.artifactType}>
                      <span>{signal.artifactType}</span>
                      <span>
                        +{signal.positive} / -{signal.negative} · {signal.total}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>

        <section className="prefs-section">
          <h3>Interaction history</h3>
          {error && <div className="feed-error">{error}</div>}
          {loading ? (
            <p className="prefs-note" role="status">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="prefs-note">
              No interactions yet. More / Less / Save on feed cards to teach the
              agent what you want.
            </p>
          ) : (
            <ul>
              {rows.map((row) => (
                <li key={row.id} className="learned">
                  <span className="prefs-text">
                    {ACTION_LABEL[row.action] ?? row.action}
                    {row.note ? ` — ${row.note}` : ""}
                  </span>
                  <span className="prefs-evidence">
                    {row.artifact_type} · {new Date(row.recorded_at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Shell>
  );
}
