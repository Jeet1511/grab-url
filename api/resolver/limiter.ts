/**
 * Abuse controls for /api/unwrap.
 *  - per-client sliding-window rate limit
 *  - global concurrency cap (each resolution holds sockets, memory, and
 *    potentially a browser process)
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Global concurrency cap (MAX_CONCURRENT_JOBS). Each resolution job owns a
 * Chromium process — default 1 keeps memory flat on small deployments
 * (e.g. Render free tier). Raise via env on bigger instances.
 */
const MAX_CONCURRENT = envInt("MAX_CONCURRENT_JOBS", 1);

interface ClientWindow {
  timestamps: number[];
}

const clients = new Map<string, ClientWindow>();
let inflight = 0;

export function checkRateLimit(clientKey: string): boolean {
  const now = Date.now();
  let entry = clients.get(clientKey);
  if (!entry) {
    entry = { timestamps: [] };
    clients.set(clientKey, entry);
  }
  entry.timestamps = entry.timestamps.filter((t) => now - t < WINDOW_MS);
  if (entry.timestamps.length >= MAX_REQUESTS_PER_WINDOW) return false;
  entry.timestamps.push(now);

  // Opportunistic cleanup so the map does not grow unboundedly.
  if (clients.size > 4096) {
    for (const [key, value] of clients) {
      if (value.timestamps.every((t) => now - t >= WINDOW_MS)) clients.delete(key);
    }
  }
  return true;
}

/** Returns false when the resolver is saturated (caller answers 429). */
export function tryAcquire(): boolean {
  if (inflight >= MAX_CONCURRENT) return false;
  inflight += 1;
  return true;
}

export function release(): void {
  inflight = Math.max(0, inflight - 1);
}
