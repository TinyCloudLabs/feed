import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { Wallet } from "ethers";

const FEED = "/Users/hunterhorsfall/conductor/workspaces/new-feed-project/gwangju/repos/feed";
const ETHERS_UMD = `${FEED}/node_modules/ethers/dist/ethers.umd.min.js`;
const scheme = (process.env.SHOT_SCHEME ?? "dark") as "dark" | "light";
const wallet = Wallet.createRandom();

const browser = await chromium.launch();
const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 420, height: 1400 } });
const page = await ctx.newPage();
await page.addInitScript(() => {
  const orig = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init: ShadowRootInit) { return orig.call(this, { ...init, mode: "open" }); };
});
await page.addInitScript({ path: ETHERS_UMD });
await page.addInitScript(({ address, privateKey }) => {
  const ethers = (window as any).ethers;
  const w = new ethers.Wallet(privateKey);
  const provider: any = {
    selectedAddress: address, chainId: "0x1",
    request: async ({ method, params }: any) => {
      switch (method) {
        case "eth_requestAccounts": case "eth_accounts": return [address];
        case "eth_chainId": return "0x1";
        case "personal_sign": {
          const m = params?.[0];
          return m.startsWith("0x") ? w.signMessage(ethers.utils.arrayify(m)) : w.signMessage(m);
        }
        case "wallet_getPermissions": case "wallet_requestPermissions": return [{ parentCapability: "eth_accounts" }];
        default: return null;
      }
    },
    on: () => provider, removeListener: () => provider, isConnected: () => true,
  };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
    detail: { info: { uuid: "8fd9b04a-e8a0-4c43-9d87-5af504aa1f0d", name: "TinyCloud Test Wallet", icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", rdns: "xyz.tinycloud.test-wallet" }, provider },
  }));
  Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}, { address: wallet.address, privateKey: wallet.privateKey });

await page.goto(`http://127.0.0.1:${process.env.WEB_PORT ?? "4298"}`);
await page.getByRole("button", { name: /sign in with openkey/i }).click();
await page.frameLocator('iframe[src*="openkey.so/widget/embed/connect"]').getByText(/or use an external wallet/i).click();
await page.getByText("TinyCloud Test Wallet").click();
await page.getByRole("button", { name: /create tinycloud space/i }).click({ timeout: 15000 }).catch(() => undefined);
await page.locator(".feed-card").first().waitFor({ timeout: 300000 });
await page.getByText("Open complete artifact").first().click();
await page.getByText("Show all sections").first().click().catch(() => undefined);
await page.waitForTimeout(1200);
await page.screenshot({ path: `/tmp/editorial-${scheme}.png` });
await browser.close();
console.log(`saved /tmp/editorial-${scheme}.png`);
