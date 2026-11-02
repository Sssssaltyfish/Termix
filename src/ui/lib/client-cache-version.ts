import { getBasePath } from "@/lib/base-path";

const CLIENT_CACHE_VERSION_KEY = "termix_client_cache_version";
const CURRENT_CLIENT_VERSION = import.meta.env.VITE_APP_VERSION || "0.0.0";
const TERMIX_CACHE_PREFIX = "termix-static-";

async function clearCacheStorage(): Promise<void> {
  if (!("caches" in window)) return;

  const cacheNames = await window.caches.keys();
  await Promise.all(
    cacheNames
      .filter((name) => name.startsWith(TERMIX_CACHE_PREFIX))
      .map((name) => window.caches.delete(name)),
  );
}

async function clearServiceWorkers(scope: URL): Promise<void> {
  if (!("serviceWorker" in navigator)) return;

  const script = new URL("sw.js", scope);
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(
    registrations
      .filter((registration) => {
        if (registration.scope !== scope.href) return false;
        const workers = [
          registration.active,
          registration.waiting,
          registration.installing,
        ].filter((worker): worker is ServiceWorker => worker !== null);
        return (
          workers.length > 0 &&
          workers.every((worker) => {
            const url = new URL(worker.scriptURL);
            return (
              url.origin === script.origin && url.pathname === script.pathname
            );
          })
        );
      })
      .map((registration) => registration.unregister()),
  );
}

function storeCurrentVersion(key: string): void {
  try {
    localStorage.setItem(key, CURRENT_CLIENT_VERSION);
  } catch {
    // expected - storage can be unavailable in restricted contexts
  }
}

export async function prepareClientCacheVersion(): Promise<void> {
  if (typeof window === "undefined") return;

  // Match useServiceWorker's deployment path. A new scoped key also runs one
  // safe migration for clients that already stored the old origin-wide key.
  const scope = new URL(`${getBasePath()}/`, window.location.origin);
  const versionKey = `${CLIENT_CACHE_VERSION_KEY}:${scope.pathname}`;
  let storedVersion: string | null = null;
  try {
    storedVersion = localStorage.getItem(versionKey);
  } catch {
    storedVersion = null;
  }

  if (storedVersion === CURRENT_CLIENT_VERSION) {
    return;
  }

  const results = await Promise.allSettled([
    clearCacheStorage(),
    clearServiceWorkers(scope),
  ]);

  // Keep failed cleanups retryable on the next visit without blocking startup.
  if (results.every((result) => result.status === "fulfilled")) {
    storeCurrentVersion(versionKey);
  }
}
