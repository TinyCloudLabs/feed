// router.tsx — a tiny path-based router (history API) for the 5 feed routes.
//
// Replaces the old single hashchange route. Five routes:
//   /            Connect    (sign in + delegate to agent)
//   /feed        Feed       (artifact cards + interactions)
//   /a/:slug     Artifact   (full detail)
//   /agents      Agents     (delegation status + Generate/poll + run history)
//   /preferences Preferences
// CF Pages serves index.html for all of these via web/public/_redirects
// (`/* /index.html 200`), so deep links and refreshes resolve client-side.

import { useEffect, useState, type ReactNode } from "react";

export type Route =
  | { kind: "connect" }
  | { kind: "feed" }
  | { kind: "article"; slug: string }
  | { kind: "agents" }
  | { kind: "preferences" };

export function parseRoute(pathname: string): Route {
  const article = /^\/a\/([^/]+)\/?$/.exec(pathname);
  if (article) return { kind: "article", slug: decodeURIComponent(article[1]!) };
  if (pathname === "/feed" || pathname === "/feed/") return { kind: "feed" };
  if (pathname === "/agents" || pathname === "/agents/") return { kind: "agents" };
  if (pathname === "/preferences" || pathname === "/preferences/") {
    return { kind: "preferences" };
  }
  return { kind: "connect" };
}

/** Path for a route — the single source of truth for links + navigation. */
export function pathFor(route: Route): string {
  switch (route.kind) {
    case "connect":
      return "/";
    case "feed":
      return "/feed";
    case "article":
      return `/a/${encodeURIComponent(route.slug)}`;
    case "agents":
      return "/agents";
    case "preferences":
      return "/preferences";
  }
}

/** Imperatively navigate (pushState) and notify the router. */
export function navigate(route: Route): void {
  const path = pathFor(route);
  if (path !== location.pathname) {
    history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return route;
}

/** An anchor that routes client-side (pushState) instead of a full navigation,
 *  while staying a real <a href> for middle-click / open-in-new-tab. */
export function Link({
  to,
  className,
  children,
  "aria-label": ariaLabel,
}: {
  to: Route;
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
}) {
  const href = pathFor(to);
  return (
    <a
      href={href}
      className={className}
      aria-label={ariaLabel}
      onClick={(e) => {
        // Let modified clicks (new tab/window) fall through to the browser.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
