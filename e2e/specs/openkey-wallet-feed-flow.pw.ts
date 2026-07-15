import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const CREDENTIALLED_CORS_HEADERS = {
  "access-control-allow-origin": `http://127.0.0.1:${process.env.FEED_SMOKE_WEB_PORT ?? "4199"}`,
  "access-control-allow-credentials": "true",
};
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Wallet } from "ethers";

const TEST_WALLET_NAME = "TinyCloud Test Wallet";
const FEED_HOST_URL = `http://127.0.0.1:${process.env.FEED_SMOKE_HOST_PORT ?? "8787"}`;
const ETHERS_UMD_PATH = fileURLToPath(new URL("../../node_modules/ethers/dist/ethers.umd.min.js", import.meta.url));
const RICH_ARTIFACT = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../shared/fixtures/rich-artifact.json", import.meta.url)), "utf8"),
) as {
  artifactId: string;
  artifactType: string;
  freshness: { label: string };
  idempotency: { sourceFingerprint: string };
  producedBy: { packageId: string };
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
  posts: Array<{
    postId: string;
    title?: string;
    body: string;
    expansionTarget: { sectionId?: string };
  }>;
};

type TestWallet = {
  privateKey: string;
  address: string;
  actorId: string;
};

function createTestWallet(): TestWallet {
  const wallet = Wallet.createRandom();
  return {
    privateKey: wallet.privateKey,
    address: wallet.address,
    actorId: `did:pkh:eip155:1:${wallet.address}`,
  };
}

function exposeTestShadowRoots() {
  return () => {
    const originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function attachShadow(init: ShadowRootInit) {
      return originalAttachShadow.call(this, { ...init, mode: "open" });
    };
  };
}

function mockBrowserWalletProvider() {
  return ({ address, privateKey, walletName }: { address: string; privateKey: string; walletName: string }) => {
    const requests: string[] = [];
    const signedMessages: string[] = [];
    const ethers = (window as any).ethers;
    const wallet = new ethers.Wallet(privateKey);
    const provider = {
      selectedAddress: address,
      chainId: "0x1",
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        requests.push(method);
        switch (method) {
          case "eth_requestAccounts":
          case "eth_accounts":
            return [address];
          case "eth_chainId":
            return "0x1";
          case "personal_sign": {
            const message = params?.[0];
            if (typeof message !== "string") throw new Error("personal_sign missing message");
            if (message.startsWith("0x")) {
              const bytes = ethers.utils.arrayify(message);
              try {
                signedMessages.push(ethers.utils.toUtf8String(bytes));
              } catch {
                signedMessages.push(message);
              }
              return wallet.signMessage(bytes);
            }
            signedMessages.push(message);
            return wallet.signMessage(message);
          }
          case "wallet_getPermissions":
          case "wallet_requestPermissions":
            return [{ parentCapability: "eth_accounts" }];
          case "wallet_switchEthereumChain":
          case "wallet_addEthereumChain":
            return null;
          default:
            return null;
        }
      },
      on: () => provider,
      removeListener: () => provider,
      isConnected: () => true,
    };
    const announceProvider = () => {
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: {
            info: {
              uuid: "8fd9b04a-e8a0-4c43-9d87-5af504aa1f0d",
              name: walletName,
              icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28'%3E%3Crect width='28' height='28' rx='6' fill='%23111827'/%3E%3Ctext x='14' y='18' text-anchor='middle' font-size='11' font-family='Arial' fill='white'%3ETC%3C/text%3E%3C/svg%3E",
              rdns: "xyz.tinycloud.test-wallet",
            },
            provider,
          },
        }),
      );
    };

    Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
    Object.defineProperty(window, "__walletRequests", { value: requests, configurable: true });
    Object.defineProperty(window, "__walletSignedMessages", { value: signedMessages, configurable: true });
    window.addEventListener("eip6963:requestProvider", announceProvider);
    announceProvider();
  };
}

async function installWallet(page: Page, wallet: TestWallet): Promise<void> {
  await page.addInitScript(exposeTestShadowRoots());
  await page.addInitScript({ path: ETHERS_UMD_PATH });
  await page.addInitScript(mockBrowserWalletProvider(), {
    address: wallet.address,
    privateKey: wallet.privateKey,
    walletName: TEST_WALLET_NAME,
  });
}

async function signInWithWallet(page: Page, wallet: TestWallet): Promise<void> {
  await page.getByRole("button", { name: /sign in with openkey/i }).click();
  await page
    .frameLocator('iframe[src*="openkey.so/widget/embed/connect"]')
    .getByText(/or use an external wallet/i)
    .click();
  await expect(page.getByText(TEST_WALLET_NAME)).toBeVisible();
  await page.getByText(TEST_WALLET_NAME).click();
  await page.getByRole("button", { name: /create tinycloud space/i }).click({ timeout: 15000 }).catch(() => undefined);
  await expect.poll(() => page.evaluate(() => (window as any).__walletRequests), { timeout: 60000 }).toContain("personal_sign");
  await expect(page.getByRole("button", { name: /sign in with openkey/i })).toHaveCount(0);
}

async function expectMobileLayout(page: Page): Promise<void> {
  const layout = await page.evaluate(() => {
    const undersized = [...document.querySelectorAll<HTMLElement>("button, summary, input, textarea")]
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44);
      })
      .map((element) => element.textContent?.trim() || element.getAttribute("aria-label") || element.tagName);
    return {
      overflows: document.documentElement.scrollWidth > window.innerWidth,
      undersized,
    };
  });
  expect(layout.overflows).toBe(false);
  expect(layout.undersized).toEqual([]);
  const accessibility = await new AxeBuilder({ page })
    .include("main")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
}

test("one sign-in sets up Feed automatically and streams the first artifact", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const wallet = createTestWallet();
  await installWallet(page, wallet);
  const policy = await page.request.get(`${FEED_HOST_URL}/delegation-policy`).then((response) => response.json()) as {
    delegateDID: string;
  };

  let delegationSubmissions = 0;
  let recoveryMode = false;
  let recoveryFeedRequests = 0;
  let releaseRecoveryResponse: (() => void) | undefined;
  const recoveryResponse = new Promise<void>((resolve) => {
    releaseRecoveryResponse = resolve;
  });
  const savedFeedItemIds = new Set<string>();
  const noteAttempts: Array<{ eventId: string; readerNonce: string; signal: string; payload?: { note?: string } }> = [];
  const controlIntentBodies: Array<{ intentKind: string; targetRef: string; payload?: Record<string, unknown> }> = [];
  let routineTuneConflict = true;
  let weeklyDigestRemoved = true;
  const consoleMessages: string[] = [];
  const clientEventBodies: string[] = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  page.on("request", (request) => {
    if (request.url().endsWith("/api/client-events")) clientEventBodies.push(request.postData() ?? "");
  });
  await page.route(/\/api\/delegations$/, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    delegationSubmissions += 1;
    const submission = route.request().postDataJSON() as { actorId: string };
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", ...CREDENTIALLED_CORS_HEADERS },
      body: JSON.stringify({
        accepted: true,
        actorId: submission.actorId,
        resources: policy.resources.map((resource) => resource.path),
      }),
    });
  });
  await page.route(/\/feed(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    if (recoveryMode) {
      recoveryFeedRequests += 1;
      if (recoveryFeedRequests === 1) {
        await route.fulfill({
          status: 503,
          headers: { "content-type": "text/plain", ...CREDENTIALLED_CORS_HEADERS },
          body: "bundle offline",
        });
        return;
      }
      if (recoveryFeedRequests === 2) await recoveryResponse;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json", ...CREDENTIALLED_CORS_HEADERS },
        body: JSON.stringify({ items: [] }),
      });
      return;
    }
    const publishedAt = RICH_ARTIFACT.publishedAt ?? RICH_ARTIFACT.createdAt;
    const items = RICH_ARTIFACT.posts.map((post, index) => {
      const feedItemId = `${RICH_ARTIFACT.artifactId}::${encodeURIComponent(post.postId)}`;
      return {
        feedItemId,
        target: { kind: "post", artifactId: RICH_ARTIFACT.artifactId, postId: post.postId },
        rankScore: 1 - index * 0.1,
        disposition: savedFeedItemIds.has(feedItemId) ? "saved" : "default",
        visibility: "ranked",
        freshnessLabel: RICH_ARTIFACT.freshness.label,
        reasonCodes: ["recent"],
        packageId: RICH_ARTIFACT.producedBy.packageId,
        sourceFingerprint: RICH_ARTIFACT.idempotency.sourceFingerprint,
        publishedAt,
        updatedAt: RICH_ARTIFACT.updatedAt,
        ...(post.title ? { postTitle: post.title } : {}),
        postBody: post.body,
        ...(post.expansionTarget.sectionId ? { sectionRef: post.expansionTarget.sectionId } : {}),
      };
    });
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", ...CREDENTIALLED_CORS_HEADERS },
      body: JSON.stringify({ items }),
    });
  });
  await page.route(new RegExp(`/artifacts/${encodeURIComponent(RICH_ARTIFACT.artifactId)}$`), async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", ...CREDENTIALLED_CORS_HEADERS },
      body: JSON.stringify(RICH_ARTIFACT),
    });
  });
  await page.route(/\/feed\/events$/, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", ...CREDENTIALLED_CORS_HEADERS },
      body: "",
    });
  });
  await page.route(/\/feedback$/, async (route) => {
    const body = route.request().postDataJSON() as { eventId: string; readerNonce: string; signal: string; payload?: { note?: string } };
    if (body.signal !== "text_note") {
      const target = (route.request().postDataJSON() as { target?: { feedItemId?: string } }).target;
      if (target?.feedItemId && body.signal === "save") savedFeedItemIds.add(target.feedItemId);
      if (target?.feedItemId && body.signal === "unsave") savedFeedItemIds.delete(target.feedItemId);
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json", ...CREDENTIALLED_CORS_HEADERS },
        body: JSON.stringify({ accepted: true, eventId: body.eventId }),
      });
      return;
    }
    noteAttempts.push(body);
    if (noteAttempts.length === 1) {
      await route.fulfill({
        status: 503,
        headers: { "content-type": "text/plain", ...CREDENTIALLED_CORS_HEADERS },
        body: "uncertain response",
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", ...CREDENTIALLED_CORS_HEADERS },
      body: JSON.stringify({ accepted: true, eventId: body.eventId }),
    });
  });
  await page.route(/\/workflows(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", ...CREDENTIALLED_CORS_HEADERS },
      body: JSON.stringify({
        items: [
          {
            packageId: RICH_ARTIFACT.producedBy.packageId,
            displayName: "Daily Brief",
            version: "0.1.0",
            settingsVersion: 2,
            admissionState: "reviewed_first_party",
            disclosure: {
              userCopy: "Turns authorized conversations into a private brief.",
              credentialOwner: "none",
              providerClass: "none",
              egressClass: "none",
            },
            presentation: {
              schemaVersion: "feed.workflow_presentation.v1",
              purpose: "Turns authorized conversations into a private brief.",
              triggerLabel: "Runs once a day",
              cadenceLabel: "Daily",
              sourcesLabel: "3 conversations this week",
              audienceLabel: "Private to you",
              exampleTitles: ["Where activation now stalls"],
            },
            paused: false,
            disabled: false,
            cadence: "normal",
            settings: {
              sourceSelection: "recent_authorized",
              audience: "private",
              outputVolume: "standard",
            },
            enabledAt: "2026-07-14T20:00:00.000Z",
            updatedAt: "2026-07-14T20:00:00.000Z",
            example: {
              artifactId: RICH_ARTIFACT.artifactId,
              title: "Where activation now stalls",
              publishedAt: RICH_ARTIFACT.updatedAt,
            },
          },
          {
            packageId: "feed-weekly-digest",
            displayName: "Weekly Digest",
            version: "0.1.0",
            settingsVersion: 5,
            admissionState: "reviewed_first_party",
            disclosure: {
              userCopy: "Collects the week's authorized highlights into one digest.",
              credentialOwner: "none",
              providerClass: "none",
              egressClass: "none",
            },
            paused: false,
            disabled: weeklyDigestRemoved,
            cadence: "less",
            settings: {
              sourceSelection: "named_sources",
              audience: "team",
              outputVolume: "short",
            },
            enabledAt: null,
            updatedAt: "2026-07-14T20:00:00.000Z",
          },
        ],
      }),
    });
  });
  await page.route(/\/control-intents$/, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as { eventId: string; intentKind: string; targetRef: string; payload?: Record<string, unknown> };
    controlIntentBodies.push({ intentKind: body.intentKind, targetRef: body.targetRef, payload: body.payload });
    if (body.intentKind === "enable_package" && body.targetRef === "package:feed-weekly-digest") {
      weeklyDigestRemoved = false;
    }
    if (body.intentKind === "tune_package" && routineTuneConflict) {
      routineTuneConflict = false;
      await route.fulfill({
        status: 409,
        headers: { "content-type": "application/json", ...CREDENTIALLED_CORS_HEADERS },
        body: JSON.stringify({ error: { code: "version_conflict", message: "preference version conflict" } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", ...CREDENTIALLED_CORS_HEADERS },
      body: JSON.stringify({ accepted: true, eventId: body.eventId }),
    });
  });
  await page.route(/\/skills(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", ...CREDENTIALLED_CORS_HEADERS },
      body: JSON.stringify({ items: [] }),
    });
  });
  await page.route(/\/input-authorities(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", ...CREDENTIALLED_CORS_HEADERS },
      body: JSON.stringify({ items: [] }),
    });
  });
  await page.route(/\/skills\/smoke-new-skill\/credentials$/, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", ...CREDENTIALLED_CORS_HEADERS },
      body: JSON.stringify({
        updated: true,
        skill: {
          skillId: "smoke-new-skill",
          credentialMode: "user_byok_api_key",
          providerId: "openai",
          hasSecret: true,
          budget: {
            budgetId: "skill:smoke-new-skill",
            spent: 0,
            currency: "USD",
            disabled: false,
            status: "ready",
          },
          version: 1,
          updatedAt: new Date().toISOString(),
        },
      }),
    });
  });

  await page.goto("/");
  await signInWithWallet(page, wallet);

  await expect(page.getByText(/approve the default bundle/i)).toHaveCount(0);
  await expect(page.getByText(/first-run-approval/i)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Activation moved; the bottleneck did too" })).toBeVisible({ timeout: 180000 });
  // The phrase also appears inside the lazily hydrated inline artifact body
  // (which may be collapsed), so scope to the visible post card.
  await expect(page.locator("p.post-body", { hasText: /test an invite preview inside setup/i })).toBeVisible();
  await expect(page.getByText(/first collaborative action is now the dominant stall point/i).locator("visible=true").first()).toBeVisible();
  await expectMobileLayout(page);
  await page.getByText("Open complete artifact").first().click();
  await expect(page.getByText("From The onboarding experiment changed where users stall").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Where activation now stalls" })).toBeVisible();
  await expect(
    page.getByLabel("Where activation now stalls").getByText(/moving the main drop-off to the first collaborative action/i),
  ).toBeVisible();
  await page.getByText("Show all sections").first().click();
  await expect(page.getByText(/complete analysis remains type-specific/i).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Saved", exact: true }).first()).toBeVisible();
  await page.getByRole("tab", { name: "Saved" }).click();
  await expect(page.getByRole("heading", { name: "Activation moved; the bottleneck did too" })).toBeVisible();
  await page.getByRole("tab", { name: "For you" }).click();
  await page.getByRole("button", { name: "Add note" }).first().click();
  await page.getByLabel("Private note").fill("Follow up with the onboarding owner.");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page.getByText("Your note was not saved. Try again.")).toBeVisible();
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page.getByText("Note saved.")).toBeVisible();
  expect(noteAttempts).toHaveLength(2);
  expect(noteAttempts[0]?.readerNonce).toBe(noteAttempts[1]?.readerNonce);
  expect(noteAttempts[0]?.eventId).toBe(noteAttempts[1]?.eventId);
  expect(noteAttempts[1]?.payload?.note).toBe("Follow up with the onboarding owner.");
  expect(consoleMessages.join("\n")).not.toContain("Follow up with the onboarding owner.");
  expect(clientEventBodies.join("\n")).not.toContain("Follow up with the onboarding owner.");
  await expect.poll(() => delegationSubmissions).toBe(1);
  const feedHostSignaturePrompts = await page.evaluate(
    (delegateDID) => ((window as any).__walletSignedMessages as string[])
      .filter((message) => message.includes(`URI: ${delegateDID}`)),
    policy.delegateDID,
  );
  expect(feedHostSignaturePrompts).toHaveLength(0);

  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "Access & automation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Access & automation" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Routines" })).toBeVisible();
  await expect(page.getByText("Daily Brief", { exact: true })).toBeVisible();
  const dailyBriefRow = page.locator(".routine-row", { hasText: "Daily Brief" });
  await dailyBriefRow.getByText("Edit routine").click();
  await dailyBriefRow.getByLabel("Frequency").selectOption("more");
  await dailyBriefRow.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("This changed elsewhere. Refresh and try again.")).toBeVisible();
  await dailyBriefRow.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByText("Daily Brief is queued to run.")).toBeVisible();
  const weeklyDigestRow = page.locator(".routine-row", { hasText: "Weekly Digest" });
  await expect(weeklyDigestRow.getByText("Removed", { exact: true })).toBeVisible();
  await weeklyDigestRow.getByRole("button", { name: "Add back" }).click();
  await expect(page.getByText("Weekly Digest is active.")).toBeVisible();
  await expect(weeklyDigestRow.getByText("Active", { exact: true })).toBeVisible();
  await expect(weeklyDigestRow.getByRole("button", { name: "Add back" })).toHaveCount(0);
  const addBackIntent = controlIntentBodies.find(
    (body) => body.intentKind === "enable_package" && body.targetRef === "package:feed-weekly-digest",
  );
  expect(addBackIntent?.payload?.expectedVersion).toBe(5);
  expect(controlIntentBodies.map((body) => body.intentKind)).toContain("tune_package");
  expect(controlIntentBodies.map((body) => body.intentKind)).toContain("generate_new_request");
  expect(controlIntentBodies.find((body) => body.intentKind === "tune_package")?.payload?.expectedVersion).toBe(2);
  expect(controlIntentBodies.find((body) => body.intentKind === "generate_new_request")?.payload?.scope).toMatchObject({
    packageId: RICH_ARTIFACT.producedBy.packageId,
  });
  await page.getByLabel("Skill ID").fill("smoke-new-skill");
  await page.getByLabel("New skill provider").fill("openai");
  await page.getByLabel("New skill secret reference").fill("vault/secrets/smoke/openai");
  await page.getByRole("button", { name: "Attach credential" }).click();
  await expect(page.getByText("smoke-new-skill", { exact: true })).toBeVisible();
  await expect(page.getByText("credential attached", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  recoveryMode = true;
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("heading", { name: /feed failed to load/i })).toBeVisible({ timeout: 120000 });
  await expect(page.getByRole("heading", { name: "Activation moved; the bottleneck did too" })).toBeVisible();

  await page.waitForTimeout(6500);
  await expect(page.getByRole("heading", { name: /feed failed to load/i })).toBeVisible();
  expect(recoveryFeedRequests).toBe(1);

  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => recoveryFeedRequests).toBe(2);
  await expect(page.getByRole("heading", { name: /feed failed to load/i })).toBeVisible();
  releaseRecoveryResponse?.();
  await expect(page.getByRole("heading", { name: /nothing here yet/i })).toBeVisible({ timeout: 60000 });
  expect(recoveryFeedRequests).toBe(2);
  await expectMobileLayout(page);
});

test("a restored session silently re-establishes Host access without another wallet prompt", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const wallet = createTestWallet();
  await installWallet(page, wallet);

  await page.goto("/");
  await signInWithWallet(page, wallet);
  await expect(page.getByRole("heading", { name: "Activation moved; the bottleneck did too" })).toBeVisible({ timeout: 180000 });

  await expect.poll(() => page.evaluate(() => localStorage.getItem("feed:v1:hostDelegations"))).toBeNull();
  await page.reload();

  await expect(page.getByRole("heading", { name: "Activation moved; the bottleneck did too" })).toBeVisible({ timeout: 180000 });
  await expect(page.getByRole("button", { name: /sign in with openkey/i })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (
    ((window as any).__walletRequests as string[]).filter((method) => method === "personal_sign").length
  ))).toBe(0);
});
