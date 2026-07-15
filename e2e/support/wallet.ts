// Shared wallet mock + sign-in helpers for e2e specs that need a real
// signed-in session against a live node. Mirrors the inline helpers in the
// openkey-wallet-feed-flow smoke spec; extracted so the interaction audit can
// reuse them without touching that spec.
import { expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { Wallet } from "ethers";

export const TEST_WALLET_NAME = "TinyCloud Test Wallet";
export const ETHERS_UMD_PATH = fileURLToPath(
  new URL("../../node_modules/ethers/dist/ethers.umd.min.js", import.meta.url),
);

export type TestWallet = {
  privateKey: string;
  address: string;
  actorId: string;
};

export function createTestWallet(): TestWallet {
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
              icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28'%3E%3Crect/%3E%3C/svg%3E",
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

export async function installWallet(page: Page, wallet: TestWallet): Promise<void> {
  await page.addInitScript(exposeTestShadowRoots());
  await page.addInitScript({ path: ETHERS_UMD_PATH });
  await page.addInitScript(mockBrowserWalletProvider(), {
    address: wallet.address,
    privateKey: wallet.privateKey,
    walletName: TEST_WALLET_NAME,
  });
}

export async function signInWithWallet(page: Page, wallet: TestWallet): Promise<void> {
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
