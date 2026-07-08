const GUARD_INSTALLED = Symbol.for("tinycloud.feed.noSpendGuardInstalled");
const FORBIDDEN_ENV_MARKERS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "TAVILY_API_KEY",
  "FAL_KEY",
  "REDPILL_API_KEY",
  "PHALA_CLOUD_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "TAVILY_BASE_URL",
  "FAL_BASE_URL",
  "PHALA_CLOUD_BASE_URL",
  "api.openai.com",
  "api.anthropic.com",
  "api.tavily.com",
  "queue.fal.run",
  "rest.alpha.fal.ai",
];

function assertNoForbiddenEnv(): void {
  const leaked = new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string" || value.trim().length === 0) continue;
    if (FORBIDDEN_ENV_MARKERS.some((marker) => key.includes(marker) || value.includes(marker))) {
      leaked.add(key);
    }
  }
  if (leaked.size > 0) {
    throw new Error(`no-spend guard: forbidden provider env present: ${[...leaked].join(", ")}`);
  }
}

function toUrl(input: string | URL | Request): URL | null {
  if (input instanceof URL) return input;
  if (typeof Request !== "undefined" && input instanceof Request) return new URL(input.url);
  if (typeof input !== "string") return null;
  try {
    return new URL(input);
  } catch {
    try {
      return new URL(input, "http://127.0.0.1");
    } catch {
      return null;
    }
  }
}

function isAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "tinycloud.xyz" ||
    host.endsWith(".tinycloud.xyz")
  );
}

function wrapFetch(fetchImpl: typeof fetch): typeof fetch {
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = toUrl(input);
    if (url && (url.protocol === "http:" || url.protocol === "https:")) {
      if (!isAllowedHost(url.hostname)) {
        throw new Error(`no-spend guard: blocked external fetch to ${url.origin}`);
      }
    }
    return fetchImpl(input as never, init);
  }) as typeof fetch;
  return wrapped;
}

function installNoSpendGuard(): void {
  if ((globalThis as typeof globalThis & { [GUARD_INSTALLED]?: true })[GUARD_INSTALLED]) return;

  if (process.env.CI || process.env.NO_SPEND_GUARD_STRICT === "1") {
    assertNoForbiddenEnv();
  }

  globalThis.fetch = wrapFetch(globalThis.fetch.bind(globalThis));

  (globalThis as typeof globalThis & { [GUARD_INSTALLED]?: true })[GUARD_INSTALLED] = true;
}

installNoSpendGuard();
