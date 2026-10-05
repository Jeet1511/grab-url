/**
 * Last-Resort Resolver (fallback stage).
 *
 * Runs only when the browser engine is unavailable in this environment AND
 * the HTTP pipeline failed to determine a verified destination.
 *
 * It exists because some redirect systems hide the destination in query
 * parameters or encoded page payloads. It is tightly controlled and
 * destination-focused: its ONLY objective is "determine the actual
 * destination URL". It never types into forms, never handles credentials
 * or tokens, never modifies anything, and every candidate it produces is
 * passed through the same SSRF validation and the same verification
 * pipeline as any other URL.
 *
 * If none of its strategies produce a verifiable destination, it returns
 * null — the application never fabricates a result.
 */

import type { RedirectHop, ResolutionPhase } from "@contracts/unwrap";
import { extractDestinationFromParams, extractEncodedTargets } from "./redirect-parser";
import { runHttpPipeline, fetchHtmlSnippet } from "./http-resolver";
import { assertUrlSafe } from "./ssrf-protection";

type ProgressFn = (phase: ResolutionPhase, message: string) => void;

export interface LastResortResult {
  finalUrl: string;
  hops: RedirectHop[];
  terminalStatus: number | null;
  strategy: string;
}

const noop: ProgressFn = () => {};

/**
 * Attempt last-resort resolution. Returns null when nothing verifiable
 * could be determined.
 */
export async function lastResortResolve(
  input: URL,
  context: { knownUrls: string[]; lastHtml?: string | null },
  onEvent: ProgressFn = noop,
): Promise<LastResortResult | null> {
  // ── Strategy 1: destination hidden in query parameters ───────────────
  // Many gate/shortener pages carry the real destination as
  // ?url=… / ?u=<base64> / ?redirect=… on one of the chain URLs.
  onEvent("last_resort", "Inspecting redirect parameters for an embedded destination…");
  for (const raw of context.knownUrls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    for (const candidateRaw of extractDestinationFromParams(u)) {
      const verified = await verifyCandidate(candidateRaw, onEvent);
      if (verified) return { ...verified, strategy: "embedded destination parameter" };
    }
  }

  // ── Strategy 2: encoded payloads in the last fetched page ────────────
  const lastKnown = context.knownUrls[context.knownUrls.length - 1];
  let html = context.lastHtml ?? null;
  if (!html && lastKnown) {
    try {
      html = await fetchHtmlSnippet(new URL(lastKnown));
    } catch {
      html = null;
    }
  }
  if (html) {
    onEvent("last_resort", "Decoding embedded navigation payloads…");
    for (const candidateRaw of extractEncodedTargets(html)) {
      const verified = await verifyCandidate(candidateRaw, onEvent);
      if (verified) return { ...verified, strategy: "decoded page payload" };
    }
  }

  return null;
}

/**
 * A last-resort candidate is accepted ONLY if it survives the ordinary
 * HTTP pipeline (SSRF-checked, loop-checked, redirect-limited) and ends at
 * a reachable terminal page. Nothing is ever returned unverified.
 */
async function verifyCandidate(
  raw: string,
  onEvent: ProgressFn,
): Promise<Omit<LastResortResult, "strategy"> | null> {
  let candidate: URL;
  try {
    candidate = new URL(raw);
  } catch {
    return null;
  }
  try {
    await assertUrlSafe(candidate);
    onEvent("verifying", `Verifying destination candidate at ${candidate.host}…`);
    const pipeline = await runHttpPipeline(candidate);
    if (pipeline.finalUrl && !pipeline.loopDetected && !pipeline.redirectLimitHit) {
      const status = pipeline.terminalStatus ?? 0;
      if (status > 0 && status < 400) {
        return {
          finalUrl: pipeline.finalUrl,
          hops: pipeline.hops,
          terminalStatus: pipeline.terminalStatus,
        };
      }
    }
  } catch {
    // Blocked, unreachable, timed out — this candidate is discarded.
  }
  return null;
}
