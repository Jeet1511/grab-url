/**
 * HTTP resolver (Level 1): follows redirect chains with plain server-side
 * HTTP requests. Every hop is re-validated against the SSRF guard, timed,
 * size limited, and checked for loops.
 *
 * Never follows redirects automatically — each Location target is resolved,
 * normalized and re-validated before the next request is issued.
 *
 * Terminal HTML pages are analyzed statically (Level 2): meta refresh,
 * static JS navigation, and navigation-relevant link discovery.
 */

import { Agent, request } from "undici";
import type { RedirectHop, HopType, ResolutionPhase } from "@contracts/unwrap";
import {
  DnsResolutionError,
  SsrfBlockError,
  assertUrlSafe,
  safeLookup,
} from "./ssrf-protection";
import { loopKey, resolveRedirectTarget } from "./url-validator";
import { analyzeHtml } from "./redirect-parser";
import { discoverLinks, type DiscoveredLink } from "./link-discovery";

export const MAX_REDIRECTS = 10;
export const MAX_HTML_BYTES = 1024 * 1024; // 1 MB — only navigation info is needed
export const PER_HOP_TIMEOUT_MS = 10_000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** One shared agent; DNS is pinned through the SSRF-validating lookup. */
const agent = new Agent({
  connect: {
    lookup: safeLookup as never,
    timeout: PER_HOP_TIMEOUT_MS,
  },
  headersTimeout: PER_HOP_TIMEOUT_MS,
  bodyTimeout: PER_HOP_TIMEOUT_MS,
  keepAliveTimeout: 1_000,
  keepAliveMaxTimeout: 1_000,
});

export class ResolverTimeoutError extends Error {
  constructor(message = "request timed out") {
    super(message);
    this.name = "ResolverTimeoutError";
  }
}

export class NetworkFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkFailureError";
  }
}

export type ProgressFn = (phase: ResolutionPhase, message: string) => void;

export interface HttpPipelineResult {
  finalUrl: string | null;
  terminalStatus: number | null;
  hops: RedirectHop[];
  /** Verified through plain HTTP headers only, or via HTML analysis. */
  method: "http" | "html" | null;
  /** Static analysis found dynamic JS navigation → escalate to browser. */
  needsBrowser: boolean;
  loopDetected: boolean;
  redirectLimitHit: boolean;
  /** Meaningful navigation links discovered on HTML pages in the chain. */
  discovered: DiscoveredLink[];
  /** <title> of the terminal page, when known (used as a display label). */
  terminalTitle: string | null;
}

interface HopRecord {
  sourceUrl: string;
  destinationUrl: string;
  status: number | null;
  redirectType: HopType;
  responseTime: number;
  label: string | null;
}

async function readCappedBody(
  body: NodeJS.ReadableStream,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > limit) {
        (body as unknown as { destroy?: () => void }).destroy?.();
        return Buffer.concat(chunks).subarray(0, limit);
      }
      chunks.push(chunk);
    }
  } catch {
    // Body stream failed mid-read; use what we have.
  }
  return Buffer.concat(chunks);
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title\s*>/i);
  if (!m) return null;
  const title = m[1].replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 120) : null;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const noop: ProgressFn = () => {};

/**
 * Run the HTTP pipeline starting at `startUrl`.
 * Throws SsrfBlockError / DnsResolutionError / ResolverTimeoutError /
 * NetworkFailureError — the caller maps these to public statuses.
 */
export async function runHttpPipeline(
  startUrl: URL,
  onEvent: ProgressFn = noop,
): Promise<HttpPipelineResult> {
  const hops: HopRecord[] = [];
  const seen = new Set<string>([loopKey(startUrl)]);
  const discovered = new Map<string, DiscoveredLink>();
  let current: URL = startUrl;
  let method: "http" | "html" | null = null;

  const collectDiscovered = (html: string, page: URL): void => {
    for (const link of discoverLinks(html, page)) {
      const existing = discovered.get(link.url);
      if (!existing || existing.relevance < link.relevance) {
        discovered.set(link.url, link);
      }
    }
  };

  for (let step = 0; step <= MAX_REDIRECTS; step++) {
    await assertUrlSafe(current);

    const started = Date.now();
    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request(current, {
        method: "GET",
        dispatcher: agent,
        headers: {
          "user-agent": USER_AGENT,
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(PER_HOP_TIMEOUT_MS),
      });
    } catch (err) {
      throw classifyRequestError(err);
    }
    const elapsed = Date.now() - started;
    const { statusCode, headers } = response;

    const location = headers.location;
    const locationValue = Array.isArray(location) ? location[0] : location;

    if (REDIRECT_STATUSES.has(statusCode) && locationValue) {
      // Redirect body is not needed — drain and discard.
      (response.body as unknown as { dump?: () => Promise<void> }).dump?.().catch(() => {});

      const target = resolveRedirectTarget(current, locationValue);
      if (!target) {
        throw new NetworkFailureError(
          `unparseable Location header from ${current.hostname}`,
        );
      }
      hops.push({
        sourceUrl: current.toString(),
        destinationUrl: target.toString(),
        status: statusCode,
        redirectType: "http",
        responseTime: elapsed,
        label: null,
      });
      onEvent("http", `Following HTTP ${statusCode} redirect → ${target.host}`);
      if (seen.has(loopKey(target))) {
        return {
          finalUrl: null, terminalStatus: null, hops: decorate(hops),
          method: null, needsBrowser: false, loopDetected: true, redirectLimitHit: false,
          discovered: [...discovered.values()], terminalTitle: null,
        };
      }
      seen.add(loopKey(target));
      if (hops.length >= MAX_REDIRECTS) {
        return {
          finalUrl: null, terminalStatus: null, hops: decorate(hops),
          method: null, needsBrowser: false, loopDetected: false, redirectLimitHit: true,
          discovered: [...discovered.values()], terminalTitle: null,
        };
      }
      current = target;
      continue;
    }

    // No HTTP redirect — terminal response. Look at HTML for client-side
    // navigation before declaring victory.
    const contentType = Array.isArray(headers["content-type"])
      ? headers["content-type"][0]
      : (headers["content-type"] ?? "");

    if (/text\/html|application\/xhtml/i.test(contentType)) {
      onEvent("html", `Analyzing page at ${current.host}…`);
      const buf = await readCappedBody(response.body, MAX_HTML_BYTES);
      const html = buf.toString("utf8");
      const found = analyzeHtml(html);

      if (found.kind === "meta" || found.kind === "js") {
        const target = resolveRedirectTarget(current, found.target);
        if (target) {
          const title = extractTitle(html);
          collectDiscovered(html, current);
          hops.push({
            sourceUrl: current.toString(),
            destinationUrl: target.toString(),
            status: null,
            redirectType: found.kind,
            responseTime: elapsed,
            label: title,
          });
          if (found.kind === "meta" && found.delaySeconds >= 1) {
            onEvent(
              "waiting",
              `Meta refresh scheduled after ${Math.round(found.delaySeconds)}s — resolving its target directly`,
            );
          } else {
            onEvent(
              "html",
              found.kind === "meta"
                ? `Meta refresh → ${target.host}`
                : `Static JavaScript navigation → ${target.host}`,
            );
          }
          if (seen.has(loopKey(target))) {
            return {
              finalUrl: null, terminalStatus: null, hops: decorate(hops),
              method: null, needsBrowser: false, loopDetected: true, redirectLimitHit: false,
              discovered: [...discovered.values()], terminalTitle: null,
            };
          }
          seen.add(loopKey(target));
          if (hops.length >= MAX_REDIRECTS) {
            return {
              finalUrl: null, terminalStatus: null, hops: decorate(hops),
              method: null, needsBrowser: false, loopDetected: false, redirectLimitHit: true,
              discovered: [...discovered.values()], terminalTitle: null,
            };
          }
          method = "html";
          current = target;
          continue;
        }
        // Unparseable client-side target — fall through, terminal here.
      } else if (found.kind === "dynamic") {
        collectDiscovered(html, current);
        (response.body as unknown as { destroy?: () => void }).destroy?.();
        onEvent("html", "Dynamic JavaScript navigation detected — escalating to the browser worker");
        return {
          finalUrl: null, terminalStatus: statusCode, hops: decorate(hops),
          method, needsBrowser: true, loopDetected: false, redirectLimitHit: false,
          discovered: [...discovered.values()], terminalTitle: extractTitle(html),
        };
      } else {
        // Terminal HTML page: discover meaningful navigation candidates.
        collectDiscovered(html, current);
        if (discovered.size > 0) {
          onEvent("discovery", `Page analysis found ${discovered.size} navigation candidate${discovered.size === 1 ? "" : "s"}`);
        }
        return {
          finalUrl: current.toString(),
          terminalStatus: statusCode,
          hops: decorate(hops),
          method: method ?? "http",
          needsBrowser: false,
          loopDetected: false,
          redirectLimitHit: false,
          discovered: [...discovered.values()],
          terminalTitle: extractTitle(html),
        };
      }
    } else {
      // Non-HTML terminal (file, API, ...): discard the body, the URL is
      // the only thing we need.
      (response.body as unknown as { dump?: () => Promise<void> }).dump?.().catch(() => {});
    }

    return {
      finalUrl: current.toString(),
      terminalStatus: statusCode,
      hops: decorate(hops),
      method: method ?? "http",
      needsBrowser: false,
      loopDetected: false,
      redirectLimitHit: false,
      discovered: [...discovered.values()],
      terminalTitle: null,
    };
  }

  return {
    finalUrl: null, terminalStatus: null, hops: decorate(hops),
    method: null, needsBrowser: false, loopDetected: false, redirectLimitHit: true,
    discovered: [...discovered.values()], terminalTitle: null,
  };
}

/**
 * Fetch a page's HTML (capped) for read-only static analysis.
 * Returns null for non-HTML responses or any failure.
 */
export async function fetchHtmlSnippet(url: URL): Promise<string | null> {
  try {
    await assertUrlSafe(url);
    const response = await request(url, {
      method: "GET",
      dispatcher: agent,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(PER_HOP_TIMEOUT_MS),
    });
    const contentType = Array.isArray(response.headers["content-type"])
      ? response.headers["content-type"][0]
      : (response.headers["content-type"] ?? "");
    if (!/text\/html|application\/xhtml/i.test(contentType)) {
      (response.body as unknown as { dump?: () => Promise<void> }).dump?.().catch(() => {});
      return null;
    }
    const buf = await readCappedBody(response.body, MAX_HTML_BYTES);
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

export interface ProbeResult {
  /** Final status code observed. */
  statusCode: number | null;
  /** True when the probe was answered with a redirect (3xx + Location). */
  redirectsFurther: boolean;
  /** Redirect target if redirectsFurther, resolved to absolute. */
  redirectTarget: string | null;
}

/**
 * Single-request probe used by the Destination Validator: confirms that a
 * URL is reachable and does not silently redirect elsewhere. One hop only —
 * never chases chains.
 */
export async function probeUrl(url: URL): Promise<ProbeResult> {
  await assertUrlSafe(url);
  let response: Awaited<ReturnType<typeof request>>;
  try {
    response = await request(url, {
      method: "GET",
      dispatcher: agent,
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        range: "bytes=0-0",
      },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    throw classifyRequestError(err);
  }
  (response.body as unknown as { dump?: () => Promise<void> }).dump?.().catch(() => {});

  const location = response.headers.location;
  const locationValue = Array.isArray(location) ? location[0] : location;
  if (REDIRECT_STATUSES.has(response.statusCode) && locationValue) {
    const target = resolveRedirectTarget(url, locationValue);
    return {
      statusCode: response.statusCode,
      redirectsFurther: true,
      redirectTarget: target ? target.toString() : null,
    };
  }
  return { statusCode: response.statusCode, redirectsFurther: false, redirectTarget: null };
}

function decorate(hops: HopRecord[]): RedirectHop[] {
  // `at` is the cumulative time when the hop completed (pipeline-relative).
  let offset = 0;
  return hops.map((h, i) => {
    offset += h.responseTime;
    return {
      step: i + 1,
      ...h,
      at: offset,
      inPopup: false,
      title: h.label,
      provider: null,
      classification: null,
    };
  });
}

function classifyRequestError(err: unknown): Error {
  if (err instanceof SsrfBlockError || err instanceof DnsResolutionError) return err;
  const e = err as NodeJS.ErrnoException & { cause?: Error };
  const name = e?.name ?? "";
  const code = e?.code ?? (e?.cause as NodeJS.ErrnoException)?.code ?? "";
  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "ETIMEDOUT"
  ) {
    return new ResolverTimeoutError();
  }
  return new NetworkFailureError(e?.message || "network request failed");
}
