import { useEffect, useMemo, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "tinyfeed.theme";
const THEME_ORDER: readonly ThemePreference[] = ["system", "light", "dark"];

function prefersLight(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;
}

function validTheme(value: string | null): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === "system") return prefersLight() ? "light" : "dark";
  return preference;
}

export function readThemePreference(): ThemePreference {
  try {
    return validTheme(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function writeThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, preference);
    }
  } catch {
    // localStorage can be unavailable in private contexts; the in-memory theme
    // still applies for this page view.
  }
}

export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

export function nextThemePreference(preference: ThemePreference): ThemePreference {
  const index = THEME_ORDER.indexOf(preference);
  return THEME_ORDER[(index + 1) % THEME_ORDER.length] ?? "system";
}

export function useThemePreference() {
  const [preference, setPreference] = useState<ThemePreference>(() => readThemePreference());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => applyTheme(readThemePreference()));

  useEffect(() => {
    writeThemePreference(preference);
    setResolved(applyTheme(preference));
  }, [preference]);

  useEffect(() => {
    if (preference !== "system") return;
    const query = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!query) return;
    const onChange = () => setResolved(applyTheme("system"));
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [preference]);

  return useMemo(
    () => ({
      preference,
      resolved,
      setPreference,
      cycle: () => setPreference((current) => nextThemePreference(current)),
    }),
    [preference, resolved],
  );
}
