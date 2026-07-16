import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_DOC_NAMESPACE,
  repairDoublePrefixedDocs,
  type RepairArtifactIndex,
  type RepairArtifactIndexRow,
  type RepairKv,
} from "./repair-double-prefixed-docs.ts";

const NS = ARTIFACT_DOC_NAMESPACE;

describe("repairDoublePrefixedDocs", () => {
  test("copies a double-prefixed document with full physical keys and normalizes the index", async () => {
    const raw = JSON.stringify({ artifactId: "artifact-1", title: "repaired" });
    const kv = new FullPhysicalKv(NS, [[`${NS}/${NS}/runs/artifact-1.json`, raw]], true);
    const index = new FakeIndex([{ artifactId: "artifact-1", docKey: `${NS}/runs/artifact-1.json` }]);
    const logs: string[] = [];

    const summary = await repairDoublePrefixedDocs({ kv, index, dryRun: false, log: (line) => logs.push(line) });

    expect(summary).toMatchObject({ candidates: 1, verified: 1, alreadyRepaired: 0, written: 1, normalized: 1, refused: 0, invalid: 0 });
    expect(kv.physical.get(`${NS}/runs/artifact-1.json`)).toBe(raw);
    expect(kv.physical.get(`${NS}/${NS}/runs/artifact-1.json`)).toBe(raw);
    expect(index.rows.get("artifact-1")?.docKey).toBe("runs/artifact-1.json");
    expect(kv.getKeys).toContain(`${NS}/${NS}/runs/artifact-1.json`);
    expect(kv.getKeys).toContain(`${NS}/runs/artifact-1.json`);
    expect(kv.getKeys.every((key) => key.startsWith(`${NS}/`))).toBe(true);
    expect(kv.listCalls).toEqual([{ prefix: `${NS}/`, removePrefix: false }]);
    expect(logs.some((line) => line.includes(`full-physical GET: ${NS}/${NS}/runs/artifact-1.json`))).toBe(true);
    expect(await kv.get("runs/artifact-1.json")).toMatchObject({ ok: false, error: { code: "AUTH_UNAUTHORIZED" } });
  });

  test("refuses to overwrite a non-identical canonical target", async () => {
    const source = JSON.stringify({ artifactId: "artifact-1", title: "source" });
    const target = JSON.stringify({ artifactId: "artifact-1", title: "different" });
    const kv = new FullPhysicalKv(NS, [
      [`${NS}/${NS}/artifact-1.json`, source],
      [`${NS}/artifact-1.json`, target],
    ]);
    const index = new FakeIndex([{ artifactId: "artifact-1", docKey: `${NS}/artifact-1.json` }]);

    const summary = await repairDoublePrefixedDocs({ kv, index, dryRun: false, log: () => {} });

    expect(summary).toMatchObject({ refused: 1, written: 0, normalized: 0, verified: 0 });
    expect(kv.physical.get(`${NS}/artifact-1.json`)).toBe(target);
    expect(index.rows.get("artifact-1")?.docKey).toBe(`${NS}/artifact-1.json`);
  });

  test("is idempotent when the canonical copy and relative index already exist", async () => {
    const raw = JSON.stringify({ artifactId: "artifact-1", title: "same" });
    const kv = new FullPhysicalKv(NS, [[`${NS}/${NS}/artifact-1.json`, raw]]);
    const index = new FakeIndex([{ artifactId: "artifact-1", docKey: `${NS}/artifact-1.json` }]);

    await repairDoublePrefixedDocs({ kv, index, dryRun: false, log: () => {} });
    const writesAfterFirstRun = kv.putKeys.length;
    const logs: string[] = [];
    const second = await repairDoublePrefixedDocs({ kv, index, dryRun: false, log: (line) => logs.push(line) });

    expect(second).toMatchObject({ candidates: 1, verified: 1, alreadyRepaired: 1, written: 0, normalized: 0, refused: 0 });
    expect(kv.putKeys).toHaveLength(writesAfterFirstRun);
    expect(index.normalizeCalls).toBe(1);
    expect(logs.some((line) => line.includes("ALREADY REPAIRED artifact-1"))).toBe(true);
  });

  test("defaults to dry-run and reports actions without KV or index writes", async () => {
    const raw = JSON.stringify({ artifactId: "artifact-1", title: "dry" });
    const kv = new FullPhysicalKv(NS, [[`${NS}/${NS}/artifact-1.json`, raw]]);
    const index = new FakeIndex([{ artifactId: "artifact-1", docKey: `${NS}/artifact-1.json` }]);

    const summary = await repairDoublePrefixedDocs({ kv, index, log: () => {} });

    expect(summary).toMatchObject({ dryRun: true, verified: 1, written: 0, normalized: 0 });
    expect(kv.physical.has(`${NS}/artifact-1.json`)).toBe(false);
    expect(kv.putKeys).toHaveLength(0);
    expect(index.normalizeCalls).toBe(0);
    expect(index.rows.get("artifact-1")?.docKey).toBe(`${NS}/artifact-1.json`);
  });

  test("rejects a document whose content id resolves to a different key-derived target", async () => {
    const raw = JSON.stringify({ artifactId: "artifact-1", title: "misbound" });
    const kv = new FullPhysicalKv(NS, [[`${NS}/${NS}/wrong-key.json`, raw]]);
    const index = new FakeIndex([{ artifactId: "artifact-1", docKey: `${NS}/artifact-1.json` }]);

    const summary = await repairDoublePrefixedDocs({ kv, index, dryRun: false, log: () => {} });

    expect(summary).toMatchObject({ invalid: 1, written: 0, normalized: 0, verified: 0 });
    expect(kv.physical.has(`${NS}/artifact-1.json`)).toBe(false);
  });

  test("logs a zero-row index normalization instead of claiming success", async () => {
    const raw = JSON.stringify({ artifactId: "artifact-1", title: "raced" });
    const kv = new FullPhysicalKv(NS, [[`${NS}/${NS}/artifact-1.json`, raw]]);
    const index = new FakeIndex([{ artifactId: "artifact-1", docKey: `${NS}/artifact-1.json` }], 0);
    const logs: string[] = [];

    const summary = await repairDoublePrefixedDocs({ kv, index, dryRun: false, log: (line) => logs.push(line) });

    expect(summary.normalized).toBe(0);
    expect(logs.some((line) => line.includes("NORMALIZE SKIPPED artifact-1"))).toBe(true);
  });

  for (const joinArity of [0, 2] as const) {
    test(`startup probe aborts when prefix-joining arity-${joinArity} cannot read the listed full key`, async () => {
      const kv = new PrefixJoiningKv(NS, joinArity);
      const index = new FakeIndex([]);

      await expect(repairDoublePrefixedDocs({ kv, index, dryRun: false, log: () => {} }))
        .rejects.toThrow(/Full-physical KV startup probe failed.*aborting repair/);
    });
  }
});

class FullPhysicalKv implements RepairKv {
  readonly physical: Map<string, string>;
  readonly getKeys: string[] = [];
  readonly putKeys: string[] = [];
  readonly listCalls: Array<{ prefix: string; removePrefix?: boolean }> = [];

  constructor(
    readonly prefix: string,
    entries: Array<[string, string]>,
    readonly duplicateListResults = false,
  ) {
    this.physical = new Map(entries);
  }

  async list(options: { prefix: string; removePrefix?: boolean }): Promise<{ ok: true; data: { keys: string[] } }> {
    this.listCalls.push({ ...options });
    if (options.prefix !== `${this.prefix}/`) throw new Error(`unauthorized list prefix: ${options.prefix}`);
    const keys = [...this.physical.keys()].filter((key) => key.startsWith(options.prefix));
    return {
      ok: true,
      data: { keys: this.duplicateListResults ? keys.flatMap((key) => [key, key]) : keys },
    };
  }

  async get(key: string): Promise<{ ok: true; data: { data: string } } | { ok: false; error: { code: string; message: string } }> {
    this.getKeys.push(key);
    if (!key.startsWith(`${this.prefix}/`)) {
      return { ok: false, error: { code: "AUTH_UNAUTHORIZED", message: `unauthorized full path: ${key}` } };
    }
    const value = this.physical.get(key);
    return value === undefined
      ? { ok: false, error: { code: "KV_NOT_FOUND", message: "not found" } }
      : { ok: true, data: { data: value } };
  }

  async put(key: string, value: string): Promise<{ ok: true; data: undefined } | { ok: false; error: { code: string; message: string } }> {
    this.putKeys.push(key);
    if (!key.startsWith(`${this.prefix}/`)) {
      return { ok: false, error: { code: "AUTH_UNAUTHORIZED", message: `unauthorized full path: ${key}` } };
    }
    this.physical.set(key, value);
    return { ok: true, data: undefined };
  }
}

class PrefixJoiningKv implements RepairKv {
  private readonly listedKey: string;

  constructor(readonly prefix: string, readonly joinArity: 0 | 2) {
    this.listedKey = `${prefix}/${prefix}/artifact-1.json`;
  }

  async list(): Promise<{ ok: true; data: { keys: string[] } }> {
    return { ok: true, data: { keys: [this.listedKey] } };
  }

  async get(key: string): Promise<{ ok: false; error: { code: string; message: string } }> {
    const resolved = this.joinArity === 0
      ? key.replace(new RegExp(`^(?:${escapeRegExp(this.prefix)}/)+`), "")
      : `${this.prefix}/${this.prefix}/${key}`;
    return {
      ok: false,
      error: {
        code: this.joinArity === 0 ? "AUTH_UNAUTHORIZED" : "KV_NOT_FOUND",
        message: `arity-${this.joinArity} resolved ${resolved}`,
      },
    };
  }

  async put(): Promise<{ ok: false; error: { code: string; message: string } }> {
    return { ok: false, error: { code: "AUTH_UNAUTHORIZED", message: "probe must abort before put" } };
  }
}

class FakeIndex implements RepairArtifactIndex {
  readonly rows = new Map<string, RepairArtifactIndexRow>();
  normalizeCalls = 0;

  constructor(rows: RepairArtifactIndexRow[], readonly normalizationChanges = 1) {
    for (const row of rows) this.rows.set(row.artifactId, { ...row });
  }

  async findByArtifactId(artifactId: string): Promise<RepairArtifactIndexRow | null> {
    const row = this.rows.get(artifactId);
    return row ? { ...row } : null;
  }

  async normalizeDocKey(artifactId: string, expectedDocKey: string, relativeDocKey: string): Promise<number> {
    const row = this.rows.get(artifactId);
    if (!row || row.docKey !== expectedDocKey) throw new Error("unexpected index state");
    this.normalizeCalls += 1;
    if (this.normalizationChanges === 1) this.rows.set(artifactId, { ...row, docKey: relativeDocKey });
    return this.normalizationChanges;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
