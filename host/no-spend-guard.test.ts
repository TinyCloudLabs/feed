import { afterEach, expect, test } from "bun:test";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("no-spend guard blocks provider egress and does not interfere with mocked local/TinyCloud fetches", async () => {
  await expect(globalThis.fetch("https://api.openai.com/v1/models")).rejects.toThrow(
    /no-spend guard: blocked external fetch/,
  );

  globalThis.fetch = ((async () => new Response("ok", { status: 200 })) as unknown) as typeof fetch;

  const tinycloud = await globalThis.fetch("https://node.tinycloud.xyz/health");
  expect(tinycloud.status).toBe(200);
  expect(await tinycloud.text()).toBe("ok");

  const local = await globalThis.fetch("http://127.0.0.1/health");
  expect(local.status).toBe(200);
  expect(await local.text()).toBe("ok");
});
