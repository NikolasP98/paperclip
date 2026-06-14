import { randomUUID } from "node:crypto";
import {
  cached as cachedRaw,
  configureCache,
  createBackend,
  createBackendAsync,
  invalidateTags as invalidateTagsRaw,
  keys,
  tags,
  MemoryBackend,
  type Backend,
  type CacheBackend,
  type CacheOptions,
} from "@minion-stack/cache";
import { logger } from "./middleware/logger.js";

/**
 * Stable per-process id used for cache-event self-dedup. Paperclip does not
 * broadcast invalidations cross-runtime (no broadcaster configured), so this is
 * informational only, but configureCache requires it when a source is set.
 */
const sourceId = process.env.PAPERCLIP_DEPLOYMENT_ID ?? randomUUID();

let initialized = false;

/**
 * Resolve the cache backend from the environment.
 *
 * Selection (highest precedence first):
 *   1. CACHE_BACKEND env if set ('memory' | 'valkey' | 'noop')
 *   2. 'valkey' when VALKEY_URL is set
 *   3. 'memory' in dev, 'noop' in production
 *
 * Caching is transparent: correctness never depends on the backend. With no
 * Valkey configured in dev we get an in-process memory cache; in production
 * with nothing configured we fall back to noop (every read goes to the DB).
 */
function resolveBackendName(): Backend {
  const explicit = process.env.CACHE_BACKEND as Backend | undefined;
  if (explicit) return explicit;
  if (process.env.VALKEY_URL) return "valkey";
  return process.env.NODE_ENV === "production" ? "noop" : "memory";
}

/**
 * One-time cache initialization. Idempotent — safe to call more than once.
 * Must be awaited once at server boot before any cached() call runs.
 *
 * Valkey is created via createBackendAsync because it dynamically imports its
 * driver; we block on it here at boot.
 */
export async function initCache(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const backendName = resolveBackendName();

  let backend: CacheBackend;
  if (backendName === "valkey") {
    if (!process.env.VALKEY_URL) {
      logger.warn("[cache] CACHE_BACKEND=valkey but VALKEY_URL unset — falling back to noop");
      backend = createBackend({ backend: "noop" });
    } else {
      backend = await createBackendAsync({
        backend: "valkey",
        url: process.env.VALKEY_URL,
        password: process.env.VALKEY_PASSWORD,
      });
    }
  } else {
    backend = createBackend({ backend: backendName });
  }

  const verbose = process.env.CACHE_LOG === "1" || process.env.NODE_ENV !== "production";

  configureCache({
    backend,
    namespace: "paperclip",
    source: "paperclip",
    sourceId,
    logger: verbose
      ? (evt) => logger.debug({ cache: evt }, "[cache] event")
      : undefined,
  });

  logger.info(
    { backend: backend.name, sourceId: sourceId.slice(0, 8) },
    "[cache] initialized",
  );
}

/**
 * Guarantee the cache is configured before use. If initCache() has not run
 * (e.g. a unit test instantiating a service directly, or an early code path),
 * configure a default in-process memory backend synchronously. This keeps
 * caching transparent: cached() never throws "Cache not configured", and
 * correctness is identical across memory/valkey/noop backends.
 */
function ensureConfigured(): void {
  if (initialized) return;
  initialized = true;
  configureCache({
    backend: new MemoryBackend(),
    namespace: "paperclip",
    source: "paperclip",
    sourceId,
  });
}

/**
 * Test-only: reset to a fresh empty in-process memory backend so each test
 * starts with a clean cache. Not used in production code paths.
 */
export function __resetCacheForTests(): void {
  initialized = true;
  configureCache({
    backend: new MemoryBackend(),
    namespace: "paperclip",
    source: "paperclip",
    sourceId,
  });
}

/**
 * Read-through cache. Thin wrapper over @minion-stack/cache `cached()` that
 * guarantees configuration exists first. Use for expensive, read-mostly,
 * tenant-scoped queries. Never wrap auth/permission-sensitive reads.
 */
export async function cached<T>(
  key: string,
  opts: CacheOptions,
  loader: () => Promise<T>,
): Promise<T> {
  ensureConfigured();
  return cachedRaw(key, opts, loader);
}

/** Invalidate every cache entry carrying any of the given tags. */
export async function invalidateTags(tagList: string[]): Promise<void> {
  ensureConfigured();
  return invalidateTagsRaw(tagList);
}

/** Re-exported builders so callers import cache helpers from one place. */
export { keys, tags };
