import { describe, expect, test } from "bun:test";
import type { DelegatedAccess } from "@tinycloud/node-sdk";
import {
  relativeKeyForLegacyAbsoluteRead,
  resourceKv,
  ResourceKvKeyError,
  validateRelativeKvKey,
} from "./resource-kv.ts";

const RESOURCE = "xyz.tinycloud.artifacts/artifacts";

function fakeAccess(implicitPrefix?: string) {
  const data = new Map<string, unknown>();
  const calls: Array<{ operation: string; key?: string; options?: Record<string, unknown> }> = [];
  const fullKey = (key: string, options?: Record<string, unknown>) => {
    const prefix = options?.prefix === undefined ? implicitPrefix ?? "" : String(options.prefix);
    return prefix ? `${prefix.replace(/\/$/, "")}/${key}` : key;
  };
  const kv = {
    get: async (key: string, options?: Record<string, unknown>) => {
      const physical = fullKey(key, options);
      calls.push({ operation: "get", key: physical, options });
      return data.has(physical)
        ? { ok: true as const, data: { data: data.get(physical), headers: {} } }
        : { ok: false as const, error: { code: "KV_NOT_FOUND", message: "not found", service: "kv" } };
    },
    put: async (key: string, value: unknown, options?: Record<string, unknown>) => {
      const physical = fullKey(key, options);
      calls.push({ operation: "put", key: physical, options });
      data.set(physical, value);
      return { ok: true as const, data: { data: undefined, headers: {} } };
    },
    delete: async (key: string, options?: Record<string, unknown>) => {
      const physical = fullKey(key, options);
      calls.push({ operation: "delete", key: physical, options });
      data.delete(physical);
      return { ok: true as const, data: undefined };
    },
    list: async (options?: Record<string, unknown>) => {
      calls.push({ operation: "list", options });
      const prefix = String(options?.prefix ?? implicitPrefix ?? "");
      return {
        ok: true as const,
        data: { keys: [...data.keys()].filter((key) => key.startsWith(prefix)) },
      };
    },
  };
  return { access: { kv } as unknown as DelegatedAccess, data, calls };
}

describe("resource-scoped KV", () => {
  test("rejects every absolute or unsafe relative-key smell with a typed error", () => {
    for (const [key, reason] of [
      ["", "empty"],
      ["/runs/doc.json", "leading_slash"],
      ["runs/../doc.json", "traversal"],
      ["https://example.test/doc.json", "uri_scheme"],
      [`${RESOURCE}/runs/doc.json`, "absolute_namespace"],
      ["xyz.tinycloud.feed/settings/value.json", "absolute_namespace"],
    ] as const) {
      expect(() => validateRelativeKvKey(key)).toThrow(ResourceKvKeyError);
      try {
        validateRelativeKvKey(key);
      } catch (error) {
        expect(error).toMatchObject({ code: "invalid_storage_key", status: 400, reason });
      }
    }
  });

  test("computes physical keys once and lists only the canonical resource prefix", async () => {
    const fake = fakeAccess();
    const kv = resourceKv(fake.access, `${RESOURCE}/`);

    await kv.put("runs/doc.json", { ok: true });
    expect(fake.data.get(`${RESOURCE}/runs/doc.json`)).toEqual({ ok: true });
    expect((await kv.get("runs/doc.json")).ok).toBe(true);
    await kv.list();
    await kv.delete("runs/doc.json");

    expect(fake.calls.find((call) => call.operation === "list")?.options).toMatchObject({
      prefix: `${RESOURCE}/`,
      removePrefix: false,
    });
    expect(fake.calls.filter((call) => call.key).map((call) => call.key)).toEqual([
      `${RESOURCE}/runs/doc.json`,
      `${RESOURCE}/runs/doc.json`,
      `${RESOURCE}/runs/doc.json`,
    ]);
  });

  for (const [name, implicitPrefix] of [
    ["arity-0 identity", undefined],
    ["arity-1 implicit prefix", RESOURCE],
  ] as const) {
    test(`lands and reads the canonical physical key under ${name} SDK behavior`, async () => {
      const fake = fakeAccess(implicitPrefix);
      const kv = resourceKv(fake.access, RESOURCE);
      const relative = "runs/run-1/doc.json";

      expect((await kv.put(relative, "value")).ok).toBe(true);
      expect([...fake.data.keys()]).toEqual([`${RESOURCE}/${relative}`]);
      const read = await kv.get<string>(relative);
      expect(read.ok && read.data.data).toBe("value");
      expect(() => kv.put(`${RESOURCE}/${relative}`, "doubled")).toThrow(ResourceKvKeyError);
      expect([...fake.data.keys()]).not.toContain(`${RESOURCE}/${RESOURCE}/${relative}`);
    });
  }

  test("legacy absolute reads strip this namespace exactly once", () => {
    expect(relativeKeyForLegacyAbsoluteRead(RESOURCE, `${RESOURCE}/runs/doc.json`)).toBe("runs/doc.json");
    expect(relativeKeyForLegacyAbsoluteRead(RESOURCE, "runs/doc.json")).toBe("runs/doc.json");
    expect(() => relativeKeyForLegacyAbsoluteRead(RESOURCE, `${RESOURCE}/${RESOURCE}/runs/doc.json`))
      .toThrow(ResourceKvKeyError);
  });
});
