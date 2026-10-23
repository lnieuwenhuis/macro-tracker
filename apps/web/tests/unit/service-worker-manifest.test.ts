/** @vitest-environment node */
// UI-12: executes the actual service-worker source in Node's vm module
// against an old cache/new manifest to prove freshness behavior.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const SW_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../public/sw.js",
);
const swSource = readFileSync(SW_PATH, "utf8");

type FakeRequest = {
  method: string;
  mode: string;
  destination: string;
  url: string;
};

type FakeResponse = {
  ok: boolean;
  redirected: boolean;
  headers: { get(name: string): string | null };
  body: string;
  clone(): FakeResponse;
};

function fakeResponse(
  body: string,
  headers: Record<string, string> = {},
  opts: { ok?: boolean; redirected?: boolean } = {},
): FakeResponse {
  const map = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    ok: opts.ok ?? true,
    redirected: opts.redirected ?? false,
    headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null },
    body,
    clone: () => fakeResponse(body, headers, opts),
  };
}

function manifestRequest(): FakeRequest {
  return {
    method: "GET",
    mode: "no-cors",
    destination: "manifest",
    url: "https://example.com/manifest.webmanifest",
  };
}

type SwEvent = {
  request: FakeRequest;
  respondWith: (promise: Promise<FakeResponse>) => void;
  waitUntil: (promise: Promise<unknown>) => void;
};

type SwListener = (event: SwEvent) => void;

function runWorker(network: (request: FakeRequest) => Promise<FakeResponse>) {
  const listeners = new Map<string, SwListener[]>();
  const entries = new Map<string, Map<string, FakeResponse>>();
  const puts: string[] = [];
  const caches = {
    open: async (name: string) => {
      if (!entries.has(name)) entries.set(name, new Map());
      const store = entries.get(name)!;
      return {
        put: async (request: FakeRequest, response: FakeResponse) => {
          store.set(request.url, response);
          puts.push(request.url);
        },
        match: async (request: FakeRequest | string) => {
          const url = typeof request === "string" ? request : request.url;
          return store.get(url);
        },
      };
    },
    keys: async () => [...entries.keys()],
    delete: async (name: string) => entries.delete(name),
    match: async (request: FakeRequest) => {
      for (const store of entries.values()) {
        const hit = store.get(request.url);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  const self: Record<string, unknown> = {
    location: { origin: "https://example.com" },
    skipWaiting: () => {},
    clients: { claim: () => {} },
    addEventListener: (type: string, fn: SwListener) => {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
  };
  runInNewContext(swSource, { self, caches, fetch: network, URL, console });
  return { listeners, entries, puts, caches };
}

async function dispatchFetch(
  listeners: Map<string, SwListener[]>,
  request: FakeRequest,
) {
  let respondWith: Promise<FakeResponse> | undefined;
  const background: Array<Promise<unknown>> = [];
  const event = {
    request,
    respondWith: (promise: Promise<FakeResponse>) => {
      respondWith = promise;
    },
    waitUntil: (promise: Promise<unknown>) => {
      background.push(promise);
    },
  };
  for (const fn of listeners.get("fetch") ?? []) fn(event);
  if (!respondWith) return undefined;
  const response = await respondWith;
  await Promise.allSettled(background);
  await new Promise((resolve) => setImmediate(resolve));
  return response;
}

async function dispatchActivate(listeners: Map<string, SwListener[]>) {
  const background: Array<Promise<unknown>> = [];
  const event: SwEvent = {
    request: manifestRequest(),
    respondWith: () => {},
    waitUntil: (promise: Promise<unknown>) => background.push(promise),
  };
  for (const fn of listeners.get("activate") ?? []) {
    fn(event);
  }
  await Promise.allSettled(background);
}

const MANIFEST_URL = "https://example.com/manifest.webmanifest";

describe("UI-12 service-worker manifest freshness", () => {
  it("serves the updated manifest and stores it (was: stale copy, zero puts)", async () => {
    const worker = runWorker(async () =>
      fakeResponse('{"name":"v2"}', { "cache-control": "public, max-age=3600" }),
    );
    const cache = await worker.caches.open("macro-tracker-v3");
    await cache.put(manifestRequest(), fakeResponse('{"name":"v1"}'));
    worker.puts.length = 0;

    const response = await dispatchFetch(worker.listeners, manifestRequest());

    expect(response?.body).toBe('{"name":"v2"}');
    expect(worker.puts).toContain(MANIFEST_URL);
    expect((await worker.caches.match(manifestRequest()))?.body).toBe(
      '{"name":"v2"}',
    );
  });

  it("serves but does not store a no-store manifest", async () => {
    const worker = runWorker(async () =>
      fakeResponse('{"name":"v2"}', { "cache-control": "no-store" }),
    );
    const cache = await worker.caches.open("macro-tracker-v3");
    await cache.put(manifestRequest(), fakeResponse('{"name":"v1"}'));
    worker.puts.length = 0;

    const response = await dispatchFetch(worker.listeners, manifestRequest());

    expect(response?.body).toBe('{"name":"v2"}');
    expect(worker.puts).toHaveLength(0);
    expect((await worker.caches.match(manifestRequest()))?.body).toBe(
      '{"name":"v1"}',
    );
  });

  it("falls back to the cached manifest when offline", async () => {
    const worker = runWorker(async () => {
      throw new TypeError("offline");
    });
    const cache = await worker.caches.open("macro-tracker-v3");
    await cache.put(manifestRequest(), fakeResponse('{"name":"v1"}'));

    const response = await dispatchFetch(worker.listeners, manifestRequest());

    expect(response?.body).toBe('{"name":"v1"}');
  });

  it("ignores non-GET requests and cleans up old cache versions", async () => {
    const worker = runWorker(async () => fakeResponse("never"));
    await (await worker.caches.open("macro-tracker-v2")).put(
      manifestRequest(),
      fakeResponse("old"),
    );
    await worker.caches.open("macro-tracker-v3");

    const post = await dispatchFetch(worker.listeners, {
      ...manifestRequest(),
      method: "POST",
    });
    expect(post).toBeUndefined();

    await dispatchActivate(worker.listeners);
    expect(await worker.caches.keys()).toEqual(["macro-tracker-v3"]);
  });
});
