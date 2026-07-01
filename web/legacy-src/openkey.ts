// openkey.ts — OpenKey passkey wallet for the viewer's sign-in.
//
// Mirrors Listen's `@listen/client` openkey helper: OpenKey authenticates the
// user with a passkey (iframe + WebAuthn) and hands back an EIP-1193 provider
// that routes `personal_sign` to OpenKey. TinyCloudWeb treats it like any
// browser wallet, so signIn() runs the real SIWE/OpenKey delegation flow over
// the manifest instead of falling into session-only mode.

import OpenKey from "@openkey/sdk";
import { providers } from "ethers";

const OPENKEY_HOST = import.meta.env.VITE_OPENKEY_HOST || "https://openkey.so";

export interface ConnectWalletResult {
  address: string;
  keyId: string;
  web3Provider: providers.Web3Provider;
}

/**
 * EIP-1193 compatible provider that routes signing to OpenKey.
 * TinyCloudWeb treats this like any browser wallet.
 */
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
        const message = hexToString(params![0] as string);
        const result = await this.openkey.signMessage({ message, keyId: this.keyId });
        return result.signature;
      }
      case "eth_getBalance":
        return "0x0";
      default:
        throw new Error(`Unsupported method: ${method}`);
    }
  }
}

function hexToString(hex: string): string {
  const cleaned = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleaned.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
  return new TextDecoder().decode(bytes);
}

/**
 * Connect the wallet via OpenKey passkey authentication, returning an
 * ethers Web3Provider TinyCloudWeb can sign SIWE recaps with.
 */
export async function connectWallet(): Promise<ConnectWalletResult> {
  const openkey = new OpenKey({ host: OPENKEY_HOST, appName: "Feed" });
  const authResult = await openkey.connect();

  const eip1193 = new OpenKeyEIP1193Provider(openkey, authResult.address, authResult.keyId, "0x1");
  const web3Provider = new providers.Web3Provider(eip1193);

  return { address: authResult.address, keyId: authResult.keyId, web3Provider };
}
