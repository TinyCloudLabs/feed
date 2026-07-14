import { closeSync, chmodSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Wallet } from "ethers";

const KEY_FILE = "host-key.json";

type StoredHostKey = {
  privateKey: string;
};

/**
 * Loads the Feed Host identity from a private state directory, creating it on
 * first boot. A named container volume keeps the delegate DID stable without
 * putting the private key in Compose or the Phala deployment environment.
 */
export function ensureFeedHostPrivateKey(stateDir: string): string {
  if (!stateDir.trim()) throw new Error("FEED_HOST_STATE_DIR must not be empty");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);

  const keyPath = join(stateDir, KEY_FILE);
  try {
    return readStoredKey(keyPath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const privateKey = Wallet.createRandom().privateKey;
  let fd: number | undefined;
  try {
    fd = openSync(keyPath, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify({ privateKey } satisfies StoredHostKey)}\n`, "utf8");
  } catch (error) {
    if (!isExistingFile(error)) throw error;
    return readStoredKey(keyPath);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  chmodSync(keyPath, 0o600);
  return privateKey;
}

function readStoredKey(keyPath: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(keyPath, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) throw error;
    throw new Error(`Feed Host key file is unreadable: ${keyPath}`, { cause: error });
  }
  const privateKey = (parsed as Partial<StoredHostKey> | null)?.privateKey;
  if (typeof privateKey !== "string") {
    throw new Error(`Feed Host key file is invalid: ${keyPath}`);
  }
  try {
    return new Wallet(privateKey).privateKey;
  } catch (error) {
    throw new Error(`Feed Host key file contains an invalid private key: ${keyPath}`, { cause: error });
  }
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function isExistingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "EEXIST";
}
