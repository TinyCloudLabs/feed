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
          <h3>Learned preferences</h3>
          <p className="prefs-note">
            Learned preferences are distilled server-side from your interactions
            and shape what the agent generates. They&rsquo;ll appear here once the
            preferences store lands; for now your interaction history below is the
            signal driving it.
          </p>
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
