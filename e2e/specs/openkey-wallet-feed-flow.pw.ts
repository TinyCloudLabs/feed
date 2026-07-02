import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const TEST_ACTOR_ID = `did:pkh:eip155:1:${TEST_ADDRESS}`;
const TEST_WALLET_NAME = "TinyCloud Test Wallet";
const FEED_HOST_URL = `http://127.0.0.1:${process.env.FEED_SMOKE_HOST_PORT ?? "8787"}`;
const ETHERS_UMD_PATH = fileURLToPath(
  new URL("../../node_modules/ethers/dist/ethers.umd.min.js", import.meta.url),
);

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
            if (message.startsWith("0x")) return wallet.signMessage(ethers.utils.arrayify(message));
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
    window.addEventListener("eip6963:requestProvider", announceProvider);
    announceProvider();
  };
}

test("signs in through OpenKey external wallet", async ({ page }) => {
  await page.addInitScript(exposeTestShadowRoots());
  await page.addInitScript({ path: ETHERS_UMD_PATH });
  await page.addInitScript(mockBrowserWalletProvider(), {
    address: TEST_ADDRESS,
    privateKey: TEST_PRIVATE_KEY,
    walletName: TEST_WALLET_NAME,
  });

  await page.goto("/");
  await page.getByRole("button", { name: /sign in with openkey/i }).click();
  await page
    .frameLocator('iframe[src*="openkey.so/widget/embed/connect"]')
    .getByText(/or use an external wallet/i)
    .click();
  await expect(page.getByText(TEST_WALLET_NAME)).toBeVisible();
  await page.getByText(TEST_WALLET_NAME).click();
  await expect.poll(() => page.evaluate(() => (window as any).__walletRequests), { timeout: 60000 }).toContain("personal_sign");
  await expect(page.getByRole("heading", { name: "Feed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("button", { name: /sign in with openkey/i })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Practice Fish First" })).toBeVisible();

  await page.getByRole("button", { name: "hide" }).click();
  await expect(page.locator("article.hidden-card")).toHaveCount(1);

  await page.getByRole("button", { name: "Ask Feed" }).click();
  await expect
    .poll(async () => {
      const response = await page.request.get(`${FEED_HOST_URL}/admin/state`, {
        headers: { "x-feed-actor-id": TEST_ACTOR_ID },
      });
      const state = await response.json();
      return (
        state.artifacts >= 1 &&
        state.projections >= 1 &&
        state.feedback >= 1 &&
        state.controlIntents >= 1 &&
        state.generationRequests >= 1
      );
    })
    .toBe(true);
});
