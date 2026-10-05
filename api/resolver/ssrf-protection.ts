/**
 * SSRF protection.
 *
 * Every outbound connection made by the resolver (HTTP fetches, redirect
 * targets, and every request issued by the headless browser worker) goes
 * through the guards in this module.
 *
 * Defense in depth:
 *  - protocol allow-list (http/https only)
 *  - safe port allow-list
 *  - blocked hostname suffixes (localhost, *.internal, metadata endpoints, ...)
 *  - IP literal validation (blocks loopback/private/link-local/multicast/
 *    reserved/CGNAT/NAT64/6to4/Teredo and IPv4-mapped IPv6)
 *  - DNS resolution with *all* answers validated
 *  - DNS results are pinned into the HTTP agent via a custom lookup, so the
 *    address we validated is the address we connect to (anti DNS-rebinding)
 */

import dns from "node:dns/promises";
import net from "node:net";
import ipaddr from "ipaddr.js";

export const SAFE_PORTS = new Set([80, 443, 8080, 8443]);

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "169.254.169.254", // also caught by IP rules, listed for clarity
]);

const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".corp",
  ".intranet",
  ".localdomain",
];

export class SsrfBlockError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SsrfBlockError";
  }
}

/**
 * TEST-ONLY escape hatch: when UNWRAP_ALLOW_PRIVATE=1 the IP/private-range
 * checks are skipped so the resolver can be exercised against a local test
 * harness. NEVER set this in production — it disables SSRF protection.
 */
function privateRangesAllowed(): boolean {
  return process.env.UNWRAP_ALLOW_PRIVATE === "1";
}

/** True when an IP address (v4 or v6, any notation) is not public unicast. */
export function isBlockedIp(rawIp: string): boolean {
  if (privateRangesAllowed()) return false;
  let ip: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    ip = ipaddr.parse(rawIp);
  } catch {
    return true; // unparsable → treat as blocked
  }

  if (ip.kind() === "ipv6") {
    const v6 = ip as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      return isBlockedV4(v6.toIPv4Address());
    }
    const range = v6.range();
    // Allow only plain global unicast. This blocks loopback, link-local,
    // unique-local, multicast, unspecified, reserved, and the transition
    // mechanisms (rfc6145/NAT64, rfc6052, 6to4, teredo) that can smuggle
    // embedded IPv4 addresses past the v4 checks.
    return range !== "unicast";
  }

  return isBlockedV4(ip as ipaddr.IPv4);
}

function isBlockedV4(ip: ipaddr.IPv4): boolean {
  // range() is one of: unspecified, broadcast, multicast, linkLocal,
  // loopback, carrierGradeNat, private, reserved, unicast (plus a few niche
  // registry labels). Anything that is not plain public unicast is blocked.
  return ip.range() !== "unicast";
}

/** Hostname-level checks that do not require DNS. */
export function assertHostnameAllowed(hostnameRaw: string): void {
  const hostname = hostnameRaw.replace(/\.$/, "").toLowerCase();
  if (!hostname) throw new SsrfBlockError("empty hostname");
  if (privateRangesAllowed()) return; // test-only bypass
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new SsrfBlockError(`blocked hostname: ${hostname}`);
  }
  for (const suffix of BLOCKED_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      throw new SsrfBlockError(`blocked hostname suffix: ${suffix}`);
    }
  }
  // Bracketed IPv6 literal or plain IPv4 literal.
  const literal = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(literal) !== 0) {
    if (isBlockedIp(literal)) {
      throw new SsrfBlockError(`blocked ip literal: ${literal}`);
    }
  }
}

export interface ValidatedAddress {
  address: string;
  family: 4 | 6;
}

/* ------------------------------------------------------------------ */
/* DNS resolution with validation + short-lived pinning cache          */
/* ------------------------------------------------------------------ */

const DNS_CACHE_TTL_MS = 30_000;
const DNS_CACHE_MAX = 1024;

interface CacheEntry {
  addresses: ValidatedAddress[];
  expires: number;
}

const dnsCache = new Map<string, CacheEntry>();

/**
 * Resolve a hostname and validate EVERY answer. All addresses must be
 * public unicast; a single bad answer rejects the whole hostname (an
 * attacker-controlled zone could otherwise alternate answers).
 */
export async function resolveAndValidate(hostname: string): Promise<ValidatedAddress[]> {
  const key = hostname.replace(/\.$/, "").toLowerCase();
  const now = Date.now();

  const cached = dnsCache.get(key);
  if (cached && cached.expires > now) return cached.addresses;

  // IP literals skip DNS entirely.
  const literal = key.replace(/^\[|\]$/g, "");
  const literalFamily = net.isIP(literal);
  if (literalFamily !== 0) {
    if (isBlockedIp(literal)) throw new SsrfBlockError(`blocked ip: ${literal}`);
    const addresses: ValidatedAddress[] = [
      { address: literal, family: literalFamily as 4 | 6 },
    ];
    pinCache(key, addresses);
    return addresses;
  }

  assertHostnameAllowed(key);

  let records: import("node:dns").LookupAddress[];
  try {
    records = await dns.lookup(key, { all: true, verbatim: true });
  } catch (err) {
    throw new DnsResolutionError(
      `DNS resolution failed for ${key}: ${(err as Error).message}`,
    );
  }
  if (!records.length) throw new DnsResolutionError(`no DNS records for ${key}`);

  const addresses: ValidatedAddress[] = [];
  for (const record of records) {
    if (isBlockedIp(record.address)) {
      throw new SsrfBlockError(
        `hostname ${key} resolves to blocked address ${record.address}`,
      );
    }
    addresses.push({ address: record.address, family: record.family as 4 | 6 });
  }

  pinCache(key, addresses);
  return addresses;
}

export class DnsResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DnsResolutionError";
  }
}

function pinCache(key: string, addresses: ValidatedAddress[]): void {
  if (dnsCache.size >= DNS_CACHE_MAX) dnsCache.clear();
  dnsCache.set(key, { addresses, expires: Date.now() + DNS_CACHE_TTL_MS });
}

/**
 * Custom `lookup` for the undici Agent. Because the agent always resolves
 * through this function, the resolver connects to exactly the addresses we
 * validated — a re-resolving (rebinding) hostname cannot redirect the
 * connection to an internal address after validation.
 */
export function safeLookup(
  hostname: string,
  options: { all?: boolean },
  callback: (
    err: NodeJS.ErrnoException | null,
    address?: string | import("node:dns").LookupAddress[],
    family?: number,
  ) => void,
): void {
  resolveAndValidate(hostname)
    .then((addresses) => {
      if (options.all) {
        callback(null, addresses.map((a) => ({ address: a.address, family: a.family })));
      } else {
        const first = addresses[0];
        callback(null, first.address, first.family);
      }
    })
    .catch((err: Error) => {
      const e = err as NodeJS.ErrnoException;
      callback(e, undefined, undefined);
    });
}

/**
 * Validate a redirect/navigation target URL string. Throws SsrfBlockError
 * for anything the resolver must not connect to. Returns the normalized URL.
 */
export async function assertUrlSafe(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlockError(`blocked protocol: ${url.protocol}`);
  }
  if (url.port && !privateRangesAllowed()) {
    const port = Number(url.port);
    if (!SAFE_PORTS.has(port)) throw new SsrfBlockError(`blocked port: ${port}`);
  }
  await resolveAndValidate(url.hostname);
}
