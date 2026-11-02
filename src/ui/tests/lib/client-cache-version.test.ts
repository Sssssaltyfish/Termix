import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const VERSION = "26.10.5";
const ORIGIN = "https://example.test";
const LEGACY_KEY = "termix_client_cache_version";

function registration(scope: string, script: string | null) {
  return {
    scope: `${ORIGIN}${scope}`,
    active: script ? { scriptURL: `${ORIGIN}${script}` } : null,
    waiting: null,
    installing: null,
    unregister: vi.fn(async () => true),
  };
}

function browser(base = "/termix") {
  const cacheNames = new Set([
    "termix-static-previous",
    "termix-static-current",
    "editor-static-current",
    "hapi-assets",
    "portal-cache",
  ]);
  const cacheStorage = {
    keys: vi.fn(async () => [...cacheNames]),
    delete: vi.fn(async (name: string) => cacheNames.delete(name)),
  };
  const owned = registration(`${base}/`, `${base}/sw.js`);
  const others = [
    registration("/", "/portal-sw.js"),
    registration("/editor/", "/editor/sw.js"),
    registration("/hapi/", "/hapi/sw.js"),
    registration(`${base}-other/`, `${base}-other/sw.js`),
    registration(`${base}/nested/`, `${base}/nested/sw.js`),
    registration(`${base}/`, "/editor/sw.js"),
    registration(`${base}/`, null),
  ];
  const serviceWorker = {
    getRegistrations: vi.fn(async () => [owned, ...others]),
  };
  const stored = new Map<string, string>();
  vi.stubGlobal("window", {
    caches: cacheStorage,
    location: { origin: ORIGIN },
  });
  vi.stubGlobal("document", {
    querySelector: () => (base ? { content: base } : null),
  });
  vi.stubGlobal("navigator", { serviceWorker });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  });
  return { cacheNames, cacheStorage, owned, others, serviceWorker, stored };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_APP_VERSION", VERSION);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("client cache version isolation", () => {
  it("migrates the old same-version key while preserving every other app's cache and worker", async () => {
    const f = browser();
    f.stored.set(LEGACY_KEY, VERSION);
    const { prepareClientCacheVersion } =
      await import("../../lib/client-cache-version");
    await prepareClientCacheVersion();

    expect([...f.cacheNames]).toEqual([
      "editor-static-current",
      "hapi-assets",
      "portal-cache",
    ]);
    expect(f.owned.unregister).toHaveBeenCalledOnce();
    for (const other of f.others)
      expect(other.unregister).not.toHaveBeenCalled();
    expect(f.stored.get(`${LEGACY_KEY}:/termix/`)).toBe(VERSION);
    expect(f.stored.get(LEGACY_KEY)).toBe(VERSION);

    await prepareClientCacheVersion();
    expect(f.cacheStorage.keys).toHaveBeenCalledOnce();
    expect(f.serviceWorker.getRegistrations).toHaveBeenCalledOnce();
  });

  it.each([undefined, "previous"])(
    "handles first access or upgrade without service-worker support (%s)",
    async (prior) => {
      const f = browser();
      vi.stubGlobal("navigator", {});
      if (prior) f.stored.set(`${LEGACY_KEY}:/termix/`, prior);
      const { prepareClientCacheVersion } =
        await import("../../lib/client-cache-version");
      await expect(prepareClientCacheVersion()).resolves.toBeUndefined();
      expect(f.stored.get(`${LEGACY_KEY}:/termix/`)).toBe(VERSION);
      expect([...f.cacheNames]).toEqual([
        "editor-static-current",
        "hapi-assets",
        "portal-cache",
      ]);
      expect(f.serviceWorker.getRegistrations).not.toHaveBeenCalled();
    },
  );

  it("retries a failed cleanup on the next visit without preventing startup", async () => {
    const f = browser();
    f.cacheStorage.keys.mockRejectedValueOnce(
      new Error("temporarily unavailable"),
    );
    const { prepareClientCacheVersion } =
      await import("../../lib/client-cache-version");
    await expect(prepareClientCacheVersion()).resolves.toBeUndefined();
    expect(f.stored.has(`${LEGACY_KEY}:/termix/`)).toBe(false);
    await prepareClientCacheVersion();
    expect(f.stored.get(`${LEGACY_KEY}:/termix/`)).toBe(VERSION);
    for (const other of f.others)
      expect(other.unregister).not.toHaveBeenCalled();
  });

  it("also checks the worker script for a root deployment instead of unregistering all scopes", async () => {
    const f = browser("");
    const { prepareClientCacheVersion } =
      await import("../../lib/client-cache-version");
    await prepareClientCacheVersion();
    expect(f.owned.unregister).toHaveBeenCalledOnce();
    for (const other of f.others)
      expect(other.unregister).not.toHaveBeenCalled();
    expect(f.stored.get(`${LEGACY_KEY}:/`)).toBe(VERSION);
  });
});
