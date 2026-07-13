import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { Wallet } from "ethers";

const TEST_WALLET_NAME = "TinyCloud Test Wallet";
const FEED_HOST_URL = `http://127.0.0.1:${process.env.FEED_SMOKE_HOST_PORT ?? "8787"}`;
const ETHERS_UMD_PATH = fileURLToPath(new URL("../../node_modules/ethers/dist/ethers.umd.min.js", import.meta.url));

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

test("one sign-in sets up Feed automatically and streams the first artifact", async ({ page }) => {
  const wallet = createTestWallet();
  const actorId = wallet.actorId;
  await installWallet(page, wallet);
  const policy = await page.request.get(`${FEED_HOST_URL}/delegation-policy`).then((response) => response.json()) as {
    delegateDID: string;
  };

  let feedRequests = 0;
  let delegationSubmissions = 0;
  let releaseFirstFeed: (() => void) | undefined;
  const firstFeedReady = new Promise<void>((resolve) => {
    releaseFirstFeed = resolve;
  });
  await page.route(/\/feed(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    feedRequests += 1;
    if (feedRequests === 1) {
      await firstFeedReady;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        body: JSON.stringify({ items: [], nextCursor: undefined }),
      });
      return;
    }
    await route.fallback();
  });
  await page.route(/\/api\/delegations$/, async (route) => {
    if (route.request().method() === "POST") delegationSubmissions += 1;
    await route.fallback();
  });

  await page.goto("/");
  await signInWithWallet(page, wallet);

  await expect(page.getByRole("heading", { name: /setting up your feed/i })).toBeVisible();
  await expect(page.getByText(/no additional approvals are needed/i)).toBeVisible();
  await expect(page.getByText(/approve the default bundle/i)).toHaveCount(0);
  await expect(page.getByText(/first-run-approval/i)).toHaveCount(0);
  releaseFirstFeed?.();
  await expect(page.getByRole("heading", { name: /nothing here yet/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Activation moved; the bottleneck did too" })).toBeVisible({ timeout: 120000 });
  await expect(page.getByRole("heading", { name: "The onboarding experiment changed where users stall" })).toBeVisible();
  await expect(page.getByText(/first collaborative action is now the dominant stall point/i)).toBeVisible();
  await page.getByText("Open full artifact").first().click();
  await expect(page.getByText("From The onboarding experiment changed where users stall").first()).toBeVisible();
  await expect(page.getByText(/complete analysis remains type-specific/i).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Hide" }).first()).toBeVisible();
  await expect.poll(() => delegationSubmissions).toBe(1);
  const feedHostSignaturePrompts = await page.evaluate(
    (delegateDID) => ((window as any).__walletSignedMessages as string[])
      .filter((message) => message.includes(`URI: ${delegateDID}`)),
    policy.delegateDID,
  );
  expect(feedHostSignaturePrompts).toHaveLength(0);

  await page.getByRole("button", { name: "Access & automation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Access & automation" })).toBeVisible();
  await page.getByLabel("Skill ID").fill("smoke-new-skill");
  await page.getByLabel("New skill provider").fill("openai");
  await page.getByLabel("New skill secret reference").fill("vault/secrets/smoke/openai");
  await page.getByRole("button", { name: "Attach credential" }).click();
  await expect(page.getByText("smoke-new-skill", { exact: true })).toBeVisible();
  await expect(page.getByText("credential attached", { exact: true })).toBeVisible();

  await expect
    .poll(async () => {
      try {
        const response = await page.request.get(`${FEED_HOST_URL}/admin/state`, {
          headers: { "x-feed-actor-id": actorId },
        });
        const state = await response.json();
        return state.artifacts >= 1 && state.projections >= 1;
      } catch {
        return false;
      }
    })
    .toBe(true);
});

test("Feed failure state only clears after a successful reload", async ({ page }) => {
  const wallet = createTestWallet();
  await installWallet(page, wallet);

  let feedRequests = 0;
  let releaseRetryResponse: (() => void) | undefined;
  const retryResponse = new Promise<void>((resolve) => {
    releaseRetryResponse = resolve;
  });
  await page.route(/\/feed(\?.*)?$/, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    feedRequests += 1;
    if (feedRequests === 2) {
      await route.fulfill({
        status: 503,
        headers: { "content-type": "text/plain", "access-control-allow-origin": "*" },
        body: "bundle offline",
      });
      return;
    }
    if (feedRequests === 3) {
      await retryResponse;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
        body: JSON.stringify({ items: [] }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      body: JSON.stringify({ items: [] }),
    });
  });

  await page.route(/\/feed\/events(\?.*)?$/, async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
      body: "",
    });
  });

  await page.goto("/");
  await signInWithWallet(page, wallet);

  await expect(page.getByRole("heading", { name: /nothing here yet/i })).toBeVisible();

  await page.getByRole("button", { name: /check again/i }).click();
  await expect(page.getByRole("heading", { name: /feed failed to load/i })).toBeVisible({ timeout: 120000 });
  await expect(page.getByRole("heading", { name: /nothing here yet/i })).toHaveCount(0);

  await page.waitForTimeout(6500);
  await expect(page.getByRole("heading", { name: /feed failed to load/i })).toBeVisible();
  expect(feedRequests).toBe(2);

  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => feedRequests).toBe(3);
  await expect(page.getByRole("heading", { name: /feed failed to load/i })).toBeVisible();
  releaseRetryResponse?.();
  await expect(page.getByRole("heading", { name: /nothing here yet/i })).toBeVisible({ timeout: 60000 });
  expect(feedRequests).toBe(3);
});

test("a restored session repairs stale cached access without another wallet prompt", async ({ page }) => {
  const wallet = createTestWallet();
  await installWallet(page, wallet);

  await page.goto("/");
  await signInWithWallet(page, wallet);
  await expect(page.getByRole("heading", { name: "Activation moved; the bottleneck did too" })).toBeVisible({ timeout: 120000 });

  await page.evaluate(() => {
    localStorage.setItem("feed:v1:hostDelegations", JSON.stringify({ actorId: "stale-policy" }));
  });
  await page.reload();

  await expect(page.getByRole("heading", { name: "Activation moved; the bottleneck did too" })).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole("button", { name: /sign in with openkey/i })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (
    ((window as any).__walletRequests as string[]).filter((method) => method === "personal_sign").length
  ))).toBe(0);
});
