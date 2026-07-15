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
  await page.goto("/");

  const signInStart = Date.now();
  await signInWithWallet(page, wallet);
  // Wait for real feed content — a card — not just any heading.
  const gotCards = await page.locator(".feed-card").first().waitFor({ timeout: 300000 }).then(() => true).catch(() => false);
  rows.push({ surface: "auth", control: "sign-in → first card visible", ok: gotCards, ms: Date.now() - signInStart, note: gotCards ? "" : "no .feed-card after 300s" });
  await page.screenshot({ path: "/tmp/audit-feed.png" }).catch(() => undefined);

  // ---- Feed tabs (role=tab, not button) ----
  await probe("tabs", "Saved tab", page.getByRole("tab", { name: "Saved", exact: true }));
  await probe("tabs", "For you tab", page.getByRole("tab", { name: "For you", exact: true }));

  // ---- First card: expansions + non-destructive actions ----
  const card = page.locator(".feed-card").first();
  await probe("card", "Open complete artifact", card.getByText(/open (complete )?artifact/i));
  await probe("card", "Why this?", card.getByText("Why this?", { exact: true }));
  await probe("card", "Advanced details", card.getByText(/advanced details/i));
  await probe("card", "Save", card.getByRole("button", { name: /^Save$/ }));
  await probe("card", "Helpful", card.getByRole("button", { name: "Helpful", exact: true }));
  await probe("card", "Add note (open)", card.getByRole("button", { name: "Add note", exact: true }));
  await probe("card", "Not helpful", card.getByRole("button", { name: "Not helpful", exact: true }));
  await probe("card", "Show fewer like this", card.getByRole("button", { name: /show fewer/i }));

  // ---- Ask Feed (top bar) ----
  await probe("topbar", "Ask Feed", page.getByRole("button", { name: "Ask Feed", exact: true }));

  // ---- Menu → Access & automation ----
  await probe("menu", "Menu open", page.getByRole("button", { name: "Menu", exact: true }));
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
