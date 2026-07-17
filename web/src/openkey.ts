import OpenKey from "@openkey/sdk";
import { providers } from "ethers";
import { OPENKEY_HOST } from "./config.ts";

export interface ConnectWalletResult {
  address: string;
  keyId: string;
  web3Provider: providers.Web3Provider;
  /** Checks connector state without opening auth or wallet UI. */
  canSignSilently: () => Promise<boolean>;
}

class OpenKeyEIP1193Provider {
  constructor(
    private openkey: OpenKey,
    private address: string,
    private keyId: string,
    private chainId: string,
  ) {}

  on(): void {}
  removeListener(): void {}

  async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
    switch (method) {
      case "eth_accounts":
      case "eth_requestAccounts":
        return [this.address];
      case "eth_chainId":
        return this.chainId;
      case "personal_sign": {
        const message = hexToString(params?.[0]);
        const result = await this.openkey.signMessage({ message, keyId: this.keyId });
        return result.signature;
      }
      case "eth_getBalance":
        return "0x0";
      default:
        throw new Error(`Unsupported wallet method: ${method}`);
    }
  }
}

function hexToString(value: unknown): string {
  if (typeof value !== "string") throw new Error("personal_sign missing message");
  if (!value.startsWith("0x")) return value;
  const bytes = value.slice(2).match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) ?? [];
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export async function connectWallet(): Promise<ConnectWalletResult> {
  const openkey = new OpenKey({ host: OPENKEY_HOST, appName: "Feed" });
  const authResult = await openkey.connect();
  const eip1193 = new OpenKeyEIP1193Provider(openkey, authResult.address, authResult.keyId, "0x1");
  return {
    address: authResult.address,
    keyId: authResult.keyId,
    web3Provider: new providers.Web3Provider(eip1193),
    // OpenKey's isConnected() reports auth state, not whether the next
    // signature is prompt-free. signMessage() opens an iframe and may fall
    // back to a popup, so this SDK version cannot promise silent signing.
    canSignSilently: async () => false,
  };
}
