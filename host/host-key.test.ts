import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Wallet } from "ethers";
import { ensureFeedHostPrivateKey } from "./host-key.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Feed Host persistent identity", () => {
  test("creates a private key once and reuses it", () => {
    const stateDir = temporaryStateDir();
    const first = ensureFeedHostPrivateKey(stateDir);
    const second = ensureFeedHostPrivateKey(stateDir);

    expect(second).toBe(first);
    expect(new Wallet(first).privateKey).toBe(first);
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(stateDir, "host-key.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(stateDir, "host-key.json"), "utf8"))).toEqual({ privateKey: first });
  });

  test("rejects an invalid persisted key instead of rotating identity", () => {
    const stateDir = temporaryStateDir();
    writeFileSync(join(stateDir, "host-key.json"), '{"privateKey":"not-a-key"}\n', { mode: 0o600 });

    expect(() => ensureFeedHostPrivateKey(stateDir)).toThrow("contains an invalid private key");
  });
});

function temporaryStateDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "feed-host-key-"));
  directories.push(directory);
  return directory;
}
