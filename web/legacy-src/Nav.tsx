// Nav.tsx — the app shell masthead with route links. Quiet-link nav matching
// the Folio aesthetic. Shown on every page once signed in; the active route is
// marked with the accent.

import type { ReactNode } from "react";
import { Link, type Route, useRoute } from "./router.tsx";
import { useThemePreference, type ResolvedTheme, type ThemePreference } from "./theme.ts";

const NAV_ITEMS: { route: Route; label: string }[] = [
  { route: { kind: "feed" }, label: "Feed" },
  { route: { kind: "agents" }, label: "Agents" },
  { route: { kind: "preferences" }, label: "Preferences" },
];

export function Shell({
  title,
  sub,
  actions,
  children,
}: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const route = useRoute();
  const theme = useThemePreference();
  return (
    <>
      <header className="masthead">
        <div>
          <Link to={{ kind: "feed" }} className="masthead-brand">
            TinyFeed
          </Link>
          <h1 className="masthead-title">
            <Link to={{ kind: "feed" }}>{title}</Link>
          </h1>
          {sub && <p className="masthead-sub">{sub}</p>}
        </div>
        <nav className="masthead-nav" aria-label="Primary">
          {NAV_ITEMS.map((item) => {
            const active = item.route.kind === route.kind;
            return (
              <Link
                key={item.label}
                to={item.route}
                className={`quiet-link${active ? " is-active" : ""}`}
                aria-label={`${item.label}${active ? " (current)" : ""}`}
              >
                {item.label}
              </Link>
            );
          })}
          <ThemeToggle
            preference={theme.preference}
            resolved={theme.resolved}
            onToggle={theme.cycle}
          />
          {actions}
        </nav>
      </header>
      {children}
    </>
  );
}

function ThemeToggle({
  preference,
  resolved,
  onToggle,
}: {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  onToggle: () => void;
}) {
  const label =
    preference === "system"
      ? `Theme: system (${resolved})`
      : preference === "light"
        ? "Theme: light"
        : "Theme: dark";
  return (
    <button
      type="button"
      className="theme-toggle"
      title={`${label}. Toggle theme`}
      aria-label={`${label}. Toggle theme`}
      onClick={onToggle}
    >
      <ThemeIcon preference={preference} resolved={resolved} />
    </button>
  );
}

function ThemeIcon({
  preference,
  resolved,
}: {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}) {
  if (preference === "system") {
    return (
      <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 5h14v10H5V5z" />
        <path d="M9 19h6" />
        <path d="M12 15v4" />
        {resolved === "light" ? <circle cx="17" cy="8" r="2" /> : <path d="M17 6.5a3 3 0 0 0 1.5 5.6 3.6 3.6 0 1 1-1.5-5.6z" />}
      </svg>
    );
  }
  if (preference === "light") {
    return (
      <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" />
      </svg>
    );
  }
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M17.5 14.5A6.5 6.5 0 0 1 9.5 6.5 7.2 7.2 0 1 0 17.5 14.5z" />
    </svg>
  );
}
