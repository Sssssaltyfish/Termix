import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function worker() {
  const handlers = new Map<string, (event: any) => void>();
  const ownResponse = { source: "termix" };
  const foreignResponse = { source: "editor" };
  const names = new Set([
    "termix-static-old",
    "termix-static-test",
    "editor-static",
    "hapi-assets",
    "portal-assets",
  ]);
  const caches = {
    keys: async () => [...names],
    delete: vi.fn(async (name: string) => names.delete(name)),
    match: vi.fn(async (_request: unknown, options?: { cacheName?: string }) =>
      options?.cacheName === "termix-static-test"
        ? ownResponse
        : foreignResponse,
    ),
  };
  const fetch = vi.fn();
  const source = readFileSync(resolve("public/sw.js"), "utf8")
    .replaceAll("__TERMIX_CACHE_VERSION__", "test")
    .replaceAll("__TERMIX_SW_BASE_PATH__", "/termix");
  runInNewContext(source, {
    caches,
    fetch,
    URL,
    self: {
      location: { origin: "https://example.test" },
      clients: { claim: vi.fn() },
      addEventListener: (name: string, handler: (event: any) => void) =>
        handlers.set(name, handler),
    },
  });
  return { handlers, caches, names, ownResponse, fetch };
}

describe("Termix worker cache isolation", () => {
  it("activates without deleting caches owned by other applications", async () => {
    const f = worker();
    let activation!: Promise<unknown>;
    f.handlers.get("activate")!({
      waitUntil: (promise: Promise<unknown>) => {
        activation = promise;
      },
    });
    await activation;
    expect([...f.names]).toEqual([
      "termix-static-test",
      "editor-static",
      "hapi-assets",
      "portal-assets",
    ]);
  });

  it("reads static responses from its own cache even if another app cached the same URL", async () => {
    const f = worker();
    const request = {
      url: "https://example.test/termix/favicon.ico",
      method: "GET",
      mode: "cors",
    };
    let response!: Promise<unknown>;
    f.handlers.get("fetch")!({
      request,
      respondWith: (promise: Promise<unknown>) => {
        response = promise;
      },
    });
    expect(await response).toBe(f.ownResponse);
    expect(f.caches.match).toHaveBeenCalledWith(request, {
      cacheName: "termix-static-test",
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
