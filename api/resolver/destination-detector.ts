/**
 * Resolution Orchestrator — browser-first.
 *
 *   Stage 0  URL validation + normalization (SSRF guard)
 *   Stage 1  Isolated browser session (PRIMARY ENGINE): ONE persistent
 *            Chromium context per resolution job observes the complete
 *            navigation journey — HTTP redirects, meta refresh, JS
 *            navigation, countdown gates, continue controls, popups,
 *            session-generated URLs and external schemes — across every
 *            provider in the chain, until a verified final destination,
 *            a genuine loop, a blocker, or a budget limit.
 *   Stage 2  HTTP pipeline fallback (only when no browser exists in this
 *            environment): redirects, meta refresh, static JS navigation.
 *   Stage 3  Last-resort extraction (embedded destinations) — tightly
 *            controlled, destination-focused.
 *   →        Destination Validator (re-confirms before display)
 *
 * A page is NEVER final merely because it returned HTTP 200. A candidate
 * becomes FINAL only after the engine has navigated to it, determined its
 * type, and confirmed that no further continuation stage exists. Pages on
 * known multi-stage redirect providers (vplink, techmint, ...) reached
 * through a chain are classified INTERMEDIATE and are never auto-verified
 * as the final destination.
 */

import type {
  Blocker,
  ConfidenceLevel,
  DestinationType,
  NavigationCandidate,
  RedirectHop,
  ResolutionEvent,
  ResolutionMethod,
  ResolutionPhase,
  UnwrapResponse,
  UnwrapStatus,
} from "@contracts/unwrap";
import { loopKey, normalizeInputUrl } from "./url-validator";
import { DnsResolutionError, SsrfBlockError } from "./ssrf-protection";
import {
  NetworkFailureError,
  ResolverTimeoutError,
  runHttpPipeline,
} from "./http-resolver";
import {
  BrowserNavigationError,
  BrowserUnavailableError,
  browserSessionConfig,
  runBrowserSession,
  sessionHops,
  type BrowserSessionResult,
} from "./browser-resolver";
import { lastResortResolve } from "./last-resort";
import { verifyDestination } from "./validator";
import { detectProvider } from "./providers";
import { classifyDestinationUrl } from "./destination";
import type { DiscoveredLink } from "./link-discovery";

export interface UnwrapOptions {
  /** Truthful progress events, streamed to the frontend when present. */
  onEvent?: (event: ResolutionEvent) => void;
  /** Include the per-stage self-diagnostic log in the response. */
  debug?: boolean;
}

type Core = Omit<UnwrapResponse, "inputUrl" | "totalTime" | "checkedAt" | "events">;

export async function unwrapUrl(
  rawUrl: unknown,
  options: UnwrapOptions = {},
): Promise<UnwrapResponse> {
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  const events: ResolutionEvent[] = [];

  const emit = (phase: ResolutionPhase, message: string): void => {
    const event = { phase, message, ts: Date.now() - started };
    events.push(event);
    try {
      options.onEvent?.(event);
    } catch {
      /* a broken progress listener must never break resolution */
    }
  };

  const finish = (partial: Core, inputUrl = ""): UnwrapResponse => {
    const response: UnwrapResponse = {
      ...partial,
      inputUrl,
      totalTime: Date.now() - started,
      checkedAt,
      events,
    };
    if (!options.debug) delete response.debugLog;
    return response;
  };

  // ── Stage 0: validate and normalize ──────────────────────────────────
  emit("validating", "Validating and normalizing the input URL…");
  let input: URL;
  try {
    input = normalizeInputUrl(rawUrl);
  } catch (err) {
    if (err instanceof SsrfBlockError) {
      return finish(
        failure(
          "blocked_or_unsupported",
          `This destination is not allowed: ${err.message}.`,
          "unsupported",
          "input blocked by network policy",
        ),
      );
    }
    return finish(
      failure("invalid_url", `Invalid URL: ${(err as Error).message}.`, null, "invalid input"),
    );
  }
  const inputStr = input.toString();

  // Overall cap: browser budget + verification headroom.
  const overallMs = browserSessionConfig().totalTimeoutMs + 25_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      resolve(input, emit),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ResolverTimeoutError("overall resolution timed out")),
          overallMs,
        );
      }),
    ]);
    emit("done", "Resolution complete.");
    return finish(result, inputStr);
  } catch (err) {
    return finish(failureResponse(err), inputStr);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function failure(
  status: UnwrapStatus,
  message: string,
  blocker: Blocker = null,
  stopReason: string | null = null,
): Core {
  return {
    status,
    finalUrl: null,
    method: null,
    confidence: null,
    verificationSignals: [],
    hops: [],
    candidates: [],
    destinationType: null,
    httpStatus: null,
    navigationCount: 0,
    blocker,
    message,
    stopReason,
    sessionId: null,
  };
}

function failureResponse(err: unknown): Core {
  if (err instanceof ResolverTimeoutError) {
    return failure(
      "timeout",
      "The destination did not respond in time.",
      null,
      "overall resolution time budget exhausted",
    );
  }
  if (err instanceof SsrfBlockError) {
    return failure(
      "blocked_or_unsupported",
      "A redirect target was blocked by the resolver's network policy.",
      "unsupported",
      `blocked by network policy: ${err.message}`,
    );
  }
  if (err instanceof DnsResolutionError) {
    return failure("network_error", "The hostname could not be resolved.", null, "DNS failure");
  }
  if (err instanceof BrowserNavigationError || err instanceof NetworkFailureError) {
    return failure(
      "network_error",
      `The destination could not be reached (${err.message}).`,
      null,
      err.message,
    );
  }
  return failure("network_error", "Resolution failed unexpectedly.", null, "unexpected failure");
}

async function resolve(
  input: URL,
  emit: (phase: ResolutionPhase, message: string) => void,
): Promise<Core> {
  const discovered = new Map<string, DiscoveredLink>();
  const collect = (links: DiscoveredLink[]): void => {
    for (const link of links) {
      const existing = discovered.get(link.url);
      if (!existing || existing.relevance < link.relevance) {
        discovered.set(link.url, link);
      }
    }
  };

  // ── Stage 1: isolated browser session (primary engine) ───────────────
  try {
    const session = await runBrowserSession(input, emit);
    collect(session.discovered);
    return await finalizeBrowser(session, input, discovered, emit);
  } catch (err) {
    if (err instanceof BrowserUnavailableError) {
      emit(
        "browser",
        "Browser engine unavailable in this environment — falling back to HTTP resolution",
      );
      // fall through to Stage 2
    } else {
      throw err;
    }
  }

  // ── Stage 2: HTTP pipeline fallback ──────────────────────────────────
  emit("http", `Requesting ${input.host}…`);
  const http = await runHttpPipeline(input, emit);
  collect(http.discovered);

  if (http.loopDetected) {
    return {
      ...failure(
        "loop_detected",
        "The redirect chain loops back on itself; no final destination exists.",
        null,
        "redirect loop detected",
      ),
      hops: http.hops,
      navigationCount: http.hops.length + 1,
      candidates: buildCandidates(http.hops, discovered, null),
    };
  }
  if (http.redirectLimitHit) {
    return {
      ...failure(
        "redirect_limit",
        `The redirect chain exceeded the maximum of ${http.hops.length} hops.`,
        null,
        "redirect limit reached",
      ),
      hops: http.hops,
      navigationCount: http.hops.length + 1,
      candidates: buildCandidates(http.hops, discovered, null),
    };
  }

  if (http.finalUrl) {
    return finalize({
      hops: http.hops,
      reachedUrl: new URL(http.finalUrl),
      terminalStatus: http.terminalStatus,
      method: http.method ?? "http",
      discovered,
      emit,
      terminalTitle: http.terminalTitle,
      destinationType: classifyDestinationUrl(http.finalUrl) ?? "website",
      terminalIsFinal: true,
      stopReason: "navigation terminated — page verified as terminal",
      sessionId: null,
      debugLog: undefined,
    });
  }

  // ── Stage 3: last-resort extraction ──────────────────────────────────
  emit("last_resort", "Analyzing destination…");
  const lastResort = await lastResortResolve(
    input,
    { knownUrls: [input.toString(), ...http.hops.map((h) => h.destinationUrl)] },
    emit,
  );

  if (lastResort) {
    const hops = mergeHops(http.hops, lastResort.hops);
    return finalize({
      hops,
      reachedUrl: new URL(lastResort.finalUrl),
      terminalStatus: lastResort.terminalStatus,
      method: "last_resort",
      discovered,
      emit,
      destinationType: classifyDestinationUrl(lastResort.finalUrl) ?? "website",
      terminalIsFinal: true,
      stopReason: `destination recovered through ${lastResort.strategy}`,
      sessionId: null,
      debugLog: undefined,
    });
  }

  const terminalStatus = http.terminalStatus;
  if (terminalStatus !== null && terminalStatus >= 400) {
    return {
      ...failure(
        "destination_unavailable",
        `The redirect chain ends here, but the destination responded with HTTP ${terminalStatus}.`,
        null,
        `destination answered with HTTP ${terminalStatus}`,
      ),
      hops: http.hops,
      navigationCount: http.hops.length + 1,
      httpStatus: terminalStatus,
      candidates: buildCandidates(http.hops, discovered, null),
    };
  }

  return {
    ...failure(
      "blocked_or_unsupported",
      "Destination could not be verified automatically. " +
        "Meaningful intermediate navigation is listed below; nothing uncertain is presented as the final destination.",
      "unsupported",
      "no verifiable terminal destination found",
    ),
    hops: http.hops,
    navigationCount: http.hops.length + 1,
    httpStatus: terminalStatus,
    candidates: buildCandidates(http.hops, discovered, null),
  };
}

/* ------------------------------------------------------------------ */
/* Browser session outcome → response                                  */
/* ------------------------------------------------------------------ */

async function finalizeBrowser(
  session: BrowserSessionResult,
  input: URL,
  discovered: Map<string, DiscoveredLink>,
  emit: (phase: ResolutionPhase, message: string) => void,
): Promise<Core> {
  const hops = sessionHops(session.navs);
  const navigationCount = session.navs.length;
  const base: Pick<Core, "stopReason" | "sessionId" | "debugLog"> = {
    stopReason: session.stopReason,
    sessionId: session.sessionId,
    debugLog: session.debugLog,
  };

  // Redirect loop: report honestly, keep the chain for display.
  if (session.loopDetected) {
    return {
      ...failure("loop_detected", "Redirect loop detected — the chain loops back on itself.", null, session.stopReason),
      ...base,
      hops,
      navigationCount,
      candidates: buildCandidates(hops, discovered, null),
    };
  }

  // A security mechanism blocked the way. Report it; never pretend.
  if (session.blocker === "captcha") {
    return {
      ...failure(
        "blocked_or_unsupported",
        "CAPTCHA / security challenge detected on the navigation path. Resolution cannot continue without bypassing it, which this resolver does not do.",
        "captcha",
        session.stopReason,
      ),
      ...base,
      hops,
      navigationCount,
      candidates: buildCandidates(hops, discovered, null),
    };
  }
  if (session.blocker === "auth") {
    return {
      ...failure(
        "blocked_or_unsupported",
        "The destination requires authentication. Resolution stopped at the sign-in wall.",
        "auth",
        session.stopReason,
      ),
      ...base,
      hops,
      navigationCount,
      candidates: buildCandidates(hops, discovered, null),
    };
  }

  // A file download was delivered by the flow.
  if (session.downloadTarget) {
    const hopCount = hops.length;
    return {
      status: hopCount >= 2 ? "redirect_chain" : "resolved",
      finalUrl: session.downloadTarget.url,
      method: "browser",
      confidence: "likely",
      verificationSignals: [
        "the navigation flow delivered a file download",
        session.downloadTarget.filename
          ? `suggested filename: ${session.downloadTarget.filename}`
          : "download observed inside an isolated browser session",
        "observed inside one persistent browser session",
      ],
      hops,
      candidates: buildCandidates(hops, discovered, null),
      destinationType: "download",
      httpStatus: session.terminalStatus,
      navigationCount,
      blocker: null,
      message: `The navigation flow ended in a direct file download after ${hopCount} redirect${hopCount === 1 ? "" : "s"}.`,
      ...base,
    };
  }

  // External URL scheme invoked by the navigation flow (e.g. tg://…).
  // It cannot be probed over HTTP, but it was genuinely observed.
  if (session.schemeTarget) {
    const hopCount = hops.length;
    const dtype = classifyDestinationUrl(session.schemeTarget) ?? "external_app";
    return {
      status: hopCount >= 2 ? "redirect_chain" : "resolved",
      finalUrl: session.schemeTarget,
      method: "browser",
      confidence: "likely",
      verificationSignals: [
        "external application link was invoked by the page's navigation flow",
        "observed inside one persistent browser session",
        "custom URL schemes cannot be re-confirmed over HTTP",
      ],
      hops,
      candidates: buildCandidates(hops, discovered, null),
      destinationType: dtype,
      httpStatus: session.terminalStatus,
      navigationCount,
      blocker: null,
      message: `The navigation flow handed off to an external application link after ${hopCount} redirect${hopCount === 1 ? "" : "s"}.`,
      ...base,
    };
  }

  const reachedUrl = new URL(session.deepestUrl);
  const core = await finalize({
    hops,
    reachedUrl,
    terminalStatus: session.terminalStatus,
    method: "browser",
    discovered,
    emit,
    terminalTitle: session.terminalTitle,
    destinationType: session.destinationType ?? "website",
    terminalIsFinal: session.terminalIsFinal,
    stopReason: session.stopReason,
    sessionId: session.sessionId,
    debugLog: session.debugLog,
  });

  // Honest caveats when the session ended early.
  if (core.finalUrl && (session.timedOut || session.navigationLimitHit)) {
    const why = session.navigationLimitHit
      ? "the navigation step limit was reached"
      : "the observation time budget was reached";
    return {
      ...core,
      confidence: core.confidence === "verified" ? "likely" : core.confidence,
      verificationSignals: [...core.verificationSignals, `observation ended early: ${why}`],
      message: `${core.message} Observation ended early because ${why}.`,
    };
  }
  return core;
}

/* ------------------------------------------------------------------ */
/* Destination validation gate                                         */
/* ------------------------------------------------------------------ */

interface FinalizeInput {
  hops: RedirectHop[];
  reachedUrl: URL;
  terminalStatus: number | null;
  method: NonNullable<ResolutionMethod>;
  discovered: Map<string, DiscoveredLink>;
  emit: (phase: ResolutionPhase, message: string) => void;
  terminalTitle?: string | null;
  destinationType: DestinationType;
  /** True only when the engine's navigation genuinely terminated here. */
  terminalIsFinal: boolean;
  stopReason: string;
  sessionId: string | null;
  debugLog: BrowserSessionResult["debugLog"] | undefined;
}

/**
 * Destination Validator gate: a candidate is never automatically final.
 * Before FINAL the engine must have (1) navigated to the page inside the
 * session, (2) determined its type, (3) checked for further redirects and
 * continuation stages — only then is the result re-confirmed and marked.
 */
async function finalize(args: FinalizeInput): Promise<Core> {
  const {
    hops,
    reachedUrl,
    terminalStatus,
    method,
    discovered,
    emit,
    destinationType,
    terminalIsFinal,
  } = args;
  const base: Pick<Core, "stopReason" | "sessionId" | "debugLog"> = {
    stopReason: args.stopReason,
    sessionId: args.sessionId,
    debugLog: args.debugLog,
  };

  const status = terminalStatus ?? 0;
  if (status >= 400) {
    return {
      status: "destination_unavailable",
      finalUrl: reachedUrl.toString(),
      method,
      confidence: "likely",
      verificationSignals: ["destination was reached", `answered with HTTP ${status}`],
      hops,
      candidates: buildCandidates(hops, discovered, reachedUrl),
      destinationType,
      httpStatus: status,
      navigationCount: hops.length + 1,
      blocker: null,
      message: `The redirect chain ends here, but the destination responded with HTTP ${status}.`,
      ...base,
    };
  }

  // Known multi-stage redirect providers (vplink, techmint, ...) host
  // INTERMEDIATE pages. They are never presented as the verified final
  // destination — the flow is expected to continue past them.
  const provider = detectProvider(reachedUrl);
  const gateLikeThroughChain = provider.gateLike;

  emit("verifying", "Verifying destination…");
  const expectedEnd =
    hops.length > 0
      ? (() => {
          try {
            return loopKey(new URL(hops[hops.length - 1].destinationUrl)) === loopKey(reachedUrl);
          } catch {
            return false;
          }
        })()
      : true;

  const verification = await verifyDestination(reachedUrl, {
    reachedByNavigation: true,
    matchedExpectedEnd: expectedEnd,
  });

  // Journey-dependent destinations: a page that genuinely TERMINATED the
  // navigation inside the session with a successful status stays verified
  // even when a sessionless re-probe cannot reproduce the journey state
  // (missing cookies/referrer). A fresh probe that still redirects means
  // the page is NOT terminal — never upgrade that case.
  if (
    method === "browser" &&
    terminalIsFinal &&
    status > 0 &&
    status < 400 &&
    !verification.redirectsFurther &&
    verification.confidence !== "verified"
  ) {
    verification.confidence = "verified";
    verification.signals = verification.signals.filter(
      (s) => !/answered with HTTP|could not be re-confirmed/.test(s),
    );
    verification.signals.push(
      `terminal page verified inside the session (HTTP ${status}); a sessionless re-check cannot reproduce journey state`,
    );
  }

  const candidates = buildCandidates(hops, discovered, reachedUrl);
  const navigationCount = hops.length + 1;

  // Terminal-type destinations (telegram/discord/file host) reached inside
  // the session are conclusively final — the flow by definition ends there.
  const terminalType =
    destinationType === "telegram" || destinationType === "discord" || destinationType === "file_host";

  let confidence: ConfidenceLevel = verification.confidence;
  if (!terminalIsFinal && !terminalType && confidence === "verified") {
    confidence = "likely";
  }
  if (gateLikeThroughChain && !terminalType) {
    confidence = confidence === "verified" ? "likely" : confidence;
  }

  const mayBeFinal =
    (confidence === "verified" || confidence === "likely") &&
    (terminalIsFinal || terminalType) &&
    !(gateLikeThroughChain && !terminalType);

  if (mayBeFinal) {
    const hopCount = hops.length;
    const noRedirect = hopCount === 0;
    const statusOut: UnwrapStatus = noRedirect
      ? "no_redirect"
      : hopCount >= 2
        ? "redirect_chain"
        : "resolved";
    const methodMsg =
      method === "browser"
        ? "in one persistent browser session"
        : method === "last_resort"
          ? "after deep analysis"
          : method === "html"
            ? "through page analysis"
            : "via HTTP";
    const signals = [...verification.signals];
    if (terminalType) signals.push(`destination type: ${destinationType.replace("_", " ")}`);
    return {
      status: statusOut,
      finalUrl: reachedUrl.toString(),
      method,
      confidence,
      verificationSignals: signals,
      hops,
      candidates,
      destinationType,
      httpStatus: verification.statusCode ?? terminalStatus,
      navigationCount,
      blocker: null,
      message: noRedirect
        ? `No redirect — the URL is already the final destination (${confidence} ${methodMsg}).`
        : `${confidence === "verified" ? "Final destination verified" : "Destination reached with high confidence"} after ${hopCount} redirect${hopCount === 1 ? "" : "s"} ${methodMsg}.`,
      ...base,
    };
  }

  // Reached something, but it is NOT conclusively final — present it as an
  // intermediate page under investigation, never as the answer.
  const whyNot = gateLikeThroughChain
    ? `this page belongs to ${provider.id}, a known multi-stage redirect provider — ${args.stopReason}`
    : terminalIsFinal
      ? "the page is stable, but verification signals are insufficient"
      : args.stopReason;
  return {
    status: "blocked_or_unsupported",
    finalUrl: null,
    method,
    confidence,
    verificationSignals: verification.signals,
    hops,
    candidates: [
      {
        url: reachedUrl.toString(),
        label: args.terminalTitle ?? null,
        source: "redirect",
        confidence: "possible",
        verified: false,
        reason: `Reached during resolution but NOT verified as final: ${whyNot}.`,
      },
      ...candidates,
    ],
    destinationType,
    httpStatus: terminalStatus,
    navigationCount,
    blocker: null,
    message: `The deepest page reached is an intermediate stage, not the final destination (${whyNot}).`,
    ...base,
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function mergeHops(a: RedirectHop[], b: RedirectHop[]): RedirectHop[] {
  const merged = [...a];
  const seen = new Set(a.map((h) => loopKey(new URL(h.destinationUrl))));
  for (const hop of b) {
    try {
      if (seen.has(loopKey(new URL(hop.destinationUrl)))) continue;
    } catch {
      /* keep it */
    }
    merged.push(hop);
  }
  return merged.map((h, i) => ({ ...h, step: i + 1 }));
}

/**
 * Build the display-ready candidate list: intermediate chain pages,
 * meaningful discovered links — each with an honest confidence label.
 * The verified final destination is never duplicated here.
 */
function buildCandidates(
  hops: RedirectHop[],
  discovered: Map<string, DiscoveredLink>,
  finalUrl: URL | null,
): NavigationCandidate[] {
  const out: NavigationCandidate[] = [];
  const seen = new Set<string>();
  if (finalUrl) seen.add(loopKey(finalUrl));

  const push = (candidate: NavigationCandidate): void => {
    try {
      const key = loopKey(new URL(candidate.url));
      if (seen.has(key)) return;
      seen.add(key);
    } catch {
      if (seen.has(candidate.url)) return;
      seen.add(candidate.url);
    }
    out.push(candidate);
  };

  // Intermediate chain pages (all but the hop that lands on the final URL).
  for (const hop of hops) {
    if (finalUrl) {
      try {
        if (loopKey(new URL(hop.destinationUrl)) === loopKey(finalUrl)) continue;
      } catch {
        /* keep */
      }
    }
    push({
      url: hop.destinationUrl,
      label: hop.label ?? hop.title,
      source:
        hop.redirectType === "meta"
          ? "meta_refresh"
          : hop.redirectType === "js"
            ? "js_navigation"
            : hop.redirectType === "generated"
              ? "generated_url"
              : hop.redirectType === "click" ||
                  hop.redirectType === "browser" ||
                  hop.redirectType === "popup"
                ? "browser"
                : "redirect",
      confidence: "intermediate",
      verified: true,
      reason: "Passed through during resolution — an intermediate page, not the destination.",
    });
  }

  // Meaningful discovered links (continue buttons, generated destinations).
  const sorted = [...discovered.values()].sort((a, b) => b.relevance - a.relevance);
  for (const link of sorted) {
    push({
      url: link.url,
      label: link.label,
      source:
        link.kind === "continue_button"
          ? "continue_button"
          : link.kind === "generated_url"
            ? "generated_url"
            : link.kind === "network_response"
              ? "network_response"
              : "page_link",
      confidence: link.relevance >= 65 ? "possible" : "unverified",
      verified: false,
      reason: link.reason,
    });
  }

  // Only verified/meaningful candidates are surfaced; cap to stay useful.
  return out.filter((c) => c.confidence !== "unverified").slice(0, 8);
}
