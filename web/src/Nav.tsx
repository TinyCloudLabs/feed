// Nav.tsx — the app shell masthead with route links. Quiet-link nav matching
// the Folio aesthetic. Shown on every page once signed in; the active route is
// marked with the accent.

import type { ReactNode } from "react";
import { Link, type Route, useRoute } from "./router.tsx";

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
          {actions}
        </nav>
      </header>
      {children}
    </>
  );
}
