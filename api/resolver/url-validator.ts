/**
 * URL validation and normalization for untrusted user input.
 */

import { SAFE_PORTS, SsrfBlockError, assertHostnameAllowed } from "./ssrf-protection";

export class InvalidUrlError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidUrlError";
  }
}

const MAX_URL_LENGTH = 2048;

/**
 * Normalize raw user input into a URL object ready for resolution.
 * - trims whitespace
 * - accepts bare hosts (prepends https://)
 * - enforces http/https
 * - rejects credentials in URLs
 * - enforces safe ports and hostname-level SSRF rules
 * Throws InvalidUrlError for malformed input, SsrfBlockError for blocked input.
 */
export function normalizeInputUrl(rawInput: unknown): URL {
  if (typeof rawInput !== "string") throw new InvalidUrlError("url must be a string");
  let raw = rawInput.trim();
  if (!raw) throw new InvalidUrlError("url is empty");
  if (raw.length > MAX_URL_LENGTH) throw new InvalidUrlError("url is too long");
  // Control characters / whitespace inside the URL are never legitimate.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20]/.test(raw)) throw new InvalidUrlError("url contains whitespace or control characters");

  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    raw = `https://${raw}`;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidUrlError("could not parse url");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidUrlError(`unsupported protocol: ${url.protocol} (only http/https)`);
  }
  if (url.username || url.password) {
    throw new InvalidUrlError("credentials in URLs are not allowed");
  }
  if (!url.hostname) throw new InvalidUrlError("missing hostname");

  if (url.port && process.env.UNWRAP_ALLOW_PRIVATE !== "1") {
    const port = Number(url.port);
    if (!SAFE_PORTS.has(port)) {
      throw new InvalidUrlError(`port ${port} is not allowed`);
    }
  }

  // Hostname-level SSRF rules (suffixes, literals). DNS-level checks happen
  // per-request in the resolver.
  try {
    assertHostnameAllowed(url.hostname);
  } catch (err) {
    if (err instanceof SsrfBlockError) throw err;
    throw new InvalidUrlError("invalid hostname");
  }

  return url;
}

/**
 * Resolve a Location header (or HTML/JS target) against a base URL.
 * Handles absolute, relative, protocol-relative and encoded targets.
 * Returns null when the target cannot be parsed at all.
 */
export function resolveRedirectTarget(base: URL, targetRaw: string): URL | null {
  let target = targetRaw.trim();
  if (!target) return null;
  // Location headers sometimes arrive surrounded by quotes.
  if (
    (target.startsWith('"') && target.endsWith('"')) ||
    (target.startsWith("'") && target.endsWith("'"))
  ) {
    target = target.slice(1, -1);
  }
  // Fully percent-encoded absolute URL (emitted by some shorteners).
  if (/^https?%3a%2f%2f/i.test(target)) {
    try {
      return new URL(decodeURIComponent(target));
    } catch {
      return null;
    }
  }
  try {
    return new URL(target, base);
  } catch {
    // Some servers emit percent-encoded relative targets.
    try {
      return new URL(decodeURIComponent(target), base);
    } catch {
      return null;
    }
  }
}

/** Canonical key used for redirect-loop detection. */
export function loopKey(url: URL): string {
  const port =
    url.port && !(url.protocol === "http:" && url.port === "80") &&
    !(url.protocol === "https:" && url.port === "443")
      ? `:${url.port}`
      : "";
  return `${url.protocol}//${url.hostname.toLowerCase()}${port}${url.pathname}${url.search}`;
}
