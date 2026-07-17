// Interaction audit: signs in against a live node, then exercises every
// control in the signed-in app, recording whether each works and how long it
// takes to settle. Diagnostic, not a pass/fail gate — it always "passes" and
// prints a report so we can see what is broken or slow. Run with a real node:
//   TINYCLOUD_HOST=http://127.0.0.1:8001 VITE_TINYCLOUD_HOST=http://127.0.0.1:8001 \
//   FEED_SMOKE_HOST_PORT=8897 FEED_SMOKE_WEB_PORT=4299 \
//   bunx playwright test e2e/specs/interaction-audit.pw.ts
import { test, type Locator, type Page } from "@playwright/test";
import { createTestWallet, installWallet, signInWithWallet } from "../support/wallet.ts";

type Row = { surface: string; control: string; ok: boolean; ms: number; note: string };

test("interaction audit — every control, measured", async ({ page }) => {
  test.skip(!process.env.RUN_INTERACTION_AUDIT, "diagnostic; set RUN_INTERACTION_AUDIT=1 to run");
  test.setTimeout(600000);
  const rows: Row[] = [];
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 200)));

  // Time an interaction: click, then wait for the network to go quiet or a
  // timeout, and record whether an error surfaced.
  const probe = async (surface: string, control: string, target: Locator, settleMs = 8000) => {
    const exists = await target.count();
    if (exists === 0) {
      rows.push({ surface, control, ok: false, ms: 0, note: "control not found" });
      return;
    }
    const before = Date.now();
    try {
      await target.first().click({ timeout: 5000 });
    } catch (error) {
      rows.push({ surface, control, ok: false, ms: Date.now() - before, note: `click failed: ${(error as Error).message.slice(0, 80)}` });
      return;
    }
    // Settle: wait for either a visible error message or network idle.
    try {
      await page.waitForLoadState("networkidle", { timeout: settleMs });
    } catch {
      /* still busy — record the elapsed time anyway */
    }
    const ms = Date.now() - before;
    const errorText = await page.locator(".error, .availability-message, [role=alert]").allInnerTexts().catch(() => []);
    const note = errorText.find((t) => /fail|unavailable|error|try again/i.test(t)) ?? "";
    rows.push({ surface, control, ok: !note, ms, note: note.slice(0, 80) });
  };

  const wallet = createTestWallet();
  await installWallet(page, wallet);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");

  const signInStart = Date.now();
  await signInWithWallet(page, wallet);
  // Wait for real feed content — a card — not just any heading.
  const gotCards = await page.locator(".feed-card").first().waitFor({ timeout: 300000 }).then(() => true).catch(() => false);
  rows.push({ surface: "auth", control: "sign-in → first card visible", ok: gotCards, ms: Date.now() - signInStart, note: gotCards ? "" : "no .feed-card after 300s" });
  await page.screenshot({ path: "/tmp/audit-feed.png" }).catch(() => undefined);

  // ---- Mobile bottom navigation ----
  const bottomNav = page.getByRole("navigation", { name: "Primary navigation" });
  await probe("bottom nav", "Saved", bottomNav.getByRole("button", { name: "Saved", exact: true }));
  await probe("bottom nav", "For you", bottomNav.getByRole("button", { name: "For you", exact: true }));

  // ---- First card: face, provenance, overflow, and headline tap-through ----
  const card = page.locator(".feed-card").first();
  await probe("card", "Save", card.getByRole("button", { name: /^(Save|Saved)$/ }));
  await probe("card", "Helpful", card.getByRole("button", { name: "Helpful", exact: true }));
  await probe("card", "Add note", card.getByRole("button", { name: "Add note", exact: true }));
  await probe("card", "Why this?", card.getByText("Why this?", { exact: true }));
  await probe("card", "Advanced details", card.getByText(/advanced details/i));
  await probe("card overflow", "More actions", card.getByRole("button", { name: "More actions", exact: true }));
  await probe("card overflow", "Not helpful", card.getByRole("button", { name: "Not helpful", exact: true }));
  await probe("card overflow", "Show fewer like this", card.getByRole("button", { name: /show fewer/i }));
  const overflowHideStart = Date.now();
  const overflowHideVisible = await card.getByRole("button", { name: "Hide", exact: true }).isVisible().catch(() => false);
  rows.push({
    surface: "card overflow",
    control: "Hide reachable",
    ok: overflowHideVisible,
    ms: Date.now() - overflowHideStart,
    note: overflowHideVisible ? "" : "control not visible after opening More actions",
  });
  await probe("card", "Headline → artifact page", card.getByRole("link").first());

  // ---- Artifact page: sources + the full feedback row ----
  const artifactPage = page.locator(".artifact-page");
  // The page hydrates its artifact after navigation; wait for the provenance
  // section before probing so timing doesn't read as missing controls.
  const pageSettled = await artifactPage.getByRole("heading", { name: "Why you're seeing this" })
    .waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
  rows.push({ surface: "artifact page", control: "page hydrated", ok: pageSettled, ms: 0, note: pageSettled ? "" : "provenance section never appeared" });
  await probe("artifact page", "View sources and quoted moments", artifactPage.getByText("View sources and quoted moments", { exact: true }));
  await probe("artifact page", "Save", artifactPage.getByRole("button", { name: /^(Save|Saved)$/ }));
  await probe("artifact page", "Helpful", artifactPage.getByRole("button", { name: "Helpful", exact: true }));
  await probe("artifact page", "Add note (open)", artifactPage.getByRole("button", { name: "Add note", exact: true }));
  await probe("artifact page", "Not helpful", artifactPage.getByRole("button", { name: "Not helpful", exact: true }));
  await probe("artifact page", "Show fewer like this", artifactPage.getByRole("button", { name: /show fewer/i }));
  await probe("artifact page", "Hide", artifactPage.getByRole("button", { name: "Hide", exact: true }));

  // ---- Activity stub from mobile primary navigation ----
  await probe("bottom nav", "Activity", bottomNav.getByRole("button", { name: "Activity", exact: true }));
  const activitySettled = await page.getByRole("heading", { name: "Activity", exact: true })
    .waitFor({ timeout: 5000 }).then(() => true).catch(() => false);
  rows.push({ surface: "activity", control: "stub loaded", ok: activitySettled, ms: 0, note: activitySettled ? "" : "Activity heading did not appear" });
  await probe("activity", "Back to Feed", page.getByRole("link", { name: "← Feed" }));

  // ---- Ask Feed (top bar) ----
  await probe("topbar", "Ask Feed", page.getByRole("button", { name: "Ask Feed", exact: true }));

  // ---- Menu → Access & automation ----
  await probe("menu", "Menu open", bottomNav.getByRole("button", { name: "Menu", exact: true }));
  await probe("menu", "Access & automation", page.getByRole("button", { name: "Access & automation", exact: true }));

  // Routines load async via the panel's reload() (listWorkflows). Wait for the
  // section to settle before judging whether routines rendered.
  const routineSettleStart = Date.now();
  await page.locator(".routine-row").first().waitFor({ timeout: 20000 }).catch(() => undefined);
  rows.push({ surface: "routine", control: "routines list load", ok: (await page.locator(".routine-row").count()) > 0, ms: Date.now() - routineSettleStart, note: (await page.locator(".routine-row").count()) > 0 ? "" : "no routines after 20s" });

  // ---- Routines ----
  const firstRoutine = page.locator(".routine-row").first();
  if (await firstRoutine.count()) {
    await probe("routine", "Edit routine (open)", firstRoutine.getByText("Edit routine", { exact: true }));
    await probe("routine", "Run now", firstRoutine.getByRole("button", { name: "Run now", exact: true }));
    await probe("routine", "Ask Feed (routine)", firstRoutine.getByRole("button", { name: "Ask Feed", exact: true }));
    await probe("routine", "Pause/Enable", firstRoutine.getByRole("button", { name: /^(Pause|Enable)$/ }));
    await probe("routine", "Reset", firstRoutine.getByRole("button", { name: "Reset", exact: true }));
  } else {
    rows.push({ surface: "routine", control: "routine list", ok: false, ms: 0, note: "no routines rendered" });
  }

  // ---- Report ----
  const report = {
    generatedNote: "interaction audit vs local node",
    rows,
    consoleErrors: [...new Set(consoleErrors)],
    pageErrors: [...new Set(pageErrors)],
  };
  const lines = rows.map((r) => `${r.ok ? "OK " : "FAIL"} | ${String(r.ms).padStart(6)}ms | ${r.surface}/${r.control}${r.note ? ` — ${r.note}` : ""}`);
  console.log("\n===== INTERACTION AUDIT =====\n" + lines.join("\n"));
  console.log("\nconsole errors (unique): " + report.consoleErrors.length);
  report.consoleErrors.forEach((e) => console.log("  · " + e));
  console.log("page errors (unique): " + report.pageErrors.length);
  report.pageErrors.forEach((e) => console.log("  · " + e));
  console.log("\nAUDIT_JSON=" + JSON.stringify(report));
});
