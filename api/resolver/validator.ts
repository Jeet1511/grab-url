/**
 * Destination Validator.
 *
 * Before any URL is marked as the final destination it is re-confirmed
 * with an independent, single-request probe. Confidence is computed from
 * explicit signals — the application never presents a guess as a result.
 */

import type { ConfidenceLevel } from "@contracts/unwrap";
import { probeUrl } from "./http-resolver";
import { SsrfBlockError, DnsResolutionError } from "./ssrf-protection";

export interface Verification {
  reachable: boolean;
  statusCode: number | null;
  /** The probe was itself redirected (destination is not terminal). */
  redirectsFurther: boolean;
  signals: string[];
  confidence: ConfidenceLevel;
}

/**
 * Verify a candidate destination. Never throws for ordinary network
 * failures — unreachable destinations simply produce lower confidence.
 * SSRF blocks are re-thrown (policy violations must not be downgraded to
 * "low confidence").
 */
export async function verifyDestination(
  url: URL,
  context: { reachedByNavigation: boolean; matchedExpectedEnd: boolean },
): Promise<Verification> {
  const signals: string[] = [];

  if (context.reachedByNavigation) {
    signals.push("destination was actually reached by navigation");
  }
  if (context.matchedExpectedEnd) {
    signals.push("matches the end of the redirect chain");
  }

  let probe;
  try {
    probe = await probeUrl(url);
  } catch (err) {
    if (err instanceof SsrfBlockError || err instanceof DnsResolutionError) throw err;
    signals.push("could not be re-confirmed (destination did not respond)");
    return {
      reachable: false,
      statusCode: null,
      redirectsFurther: false,
      signals,
      confidence: context.reachedByNavigation ? "likely" : "unverified",
    };
  }

  const reachable = probe.statusCode !== null && probe.statusCode < 400;
  if (reachable) {
    signals.push(`destination remains reachable (HTTP ${probe.statusCode})`);
  } else if (probe.statusCode !== null) {
    signals.push(`destination answered with HTTP ${probe.statusCode}`);
  }

  if (probe.redirectsFurther) {
    signals.push("still redirects elsewhere when re-checked");
  } else {
    signals.push("no further redirect detected");
  }

  let confidence: ConfidenceLevel;
  if (reachable && !probe.redirectsFurther && context.reachedByNavigation) {
    confidence = "verified";
  } else if (reachable && context.reachedByNavigation) {
    confidence = "likely";
  } else if (reachable) {
    confidence = "possible";
  } else {
    confidence = context.reachedByNavigation ? "likely" : "unverified";
  }

  return {
    reachable,
    statusCode: probe.statusCode,
    redirectsFurther: probe.redirectsFurther,
    signals,
    confidence,
  };
}
