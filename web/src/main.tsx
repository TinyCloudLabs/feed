import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { loadAgentConfig } from "./agentConfig.ts";
import { applyTheme, readThemePreference } from "./theme.ts";
import "./styles.css";

applyTheme(readThemePreference());

// Load the RUNTIME agent config (/agent-config.json) ONCE, BEFORE the first
// render. This is the no-race guarantee: by the time any component mounts (and
// reads the synchronous agentConfigured() / agentHost() / guard DID), the config
// is already settled. In a built/prod context a missing or malformed config
// REJECTS here — we render a loud error state instead of a silently-unconfigured
// (or stale) agent. agentFetch additionally awaits this same single-flight load,
// so even a stray pre-mount call can't run against an unloaded config.
const root = createRoot(document.getElementById("root")!);

loadAgentConfig()
  .then(() => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  })
  .catch((err: unknown) => {
    // Prod missing/malformed /agent-config.json (or an invalid host) lands here.
    // Surface it plainly rather than booting a blank/wrong agent. No fallback.
    const message = err instanceof Error ? err.message : String(err);
    root.render(
      <StrictMode>
        <div className="feed-status">
          <p className="feed-status-line">Agent configuration error</p>
          <p className="feed-status-sub">{message}</p>
          <p className="prefs-note">
            The app could not load <code>/agent-config.json</code>. Deploy a valid
            agent-config.json (with at least a <code>host</code>) and reload.
          </p>
        </div>
      </StrictMode>,
    );
  });
