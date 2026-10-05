/**
 * Shared contracts for the URL Unwrapper API.
 * Used by both the Hono backend (api/) and the React frontend (src/).
 */

export type UnwrapStatus =
  | "resolved"
  | "no_redirect"
  | "redirect_chain"
  | "loop_detected"
  | "timeout"
  | "invalid_url"
  | "destination_unavailable"
  | "blocked_or_unsupported"
  | "redirect_limit"
  | "network_error";

/**
 * How a navigation step was produced.
 *  - http:      301/302/303/307/308 redirect observed on the wire
 *  - meta:      <meta http-equiv="refresh"> navigation
 *  - js:        script-driven navigation (location.href / replace / assign)
 *  - browser:   in-browser navigation of another kind (history, anchor, form)
 *  - click:     navigation produced by activating a continue-style control
 *  - popup:     destination reached in a popup / new tab the page opened
 *  - generated: a session-generated URL (token link, JS-built destination)
 *               followed inside the SAME browser context
 *  - scheme:    external URL scheme invoked by the page (e.g. tg://)
 */
export type HopType =
  | "http"
  | "meta"
  | "js"
  | "browser"
  | "click"
  | "popup"
  | "generated"
  | "scheme";

/** How a page in the chain was classified by the resolution engine. */
export type NodeClassification = "intermediate" | "final" | null;

export interface RedirectHop {
  step: number;
  sourceUrl: string;
  destinationUrl: string;
  /** HTTP status that triggered the hop; null for meta/js/browser hops. */
  status: number | null;
  redirectType: HopType;
  /** Milliseconds this step took. */
  responseTime: number;
  /** Milliseconds since resolution start when this hop was observed. */
  at: number;
  /** Human-readable label for this step (button text, page title, ...). */
  label: string | null;
  /** True when this hop happened in a popup / new tab. */
  inPopup: boolean;
  /** <title> of the destination page, when known. */
  title: string | null;
  /** Provider identified at the destination (vplink, techmint, generic, ...). */
  provider: string | null;
  /** intermediate = passed through; final = verified terminal destination. */
  classification: NodeClassification;
}

/**
 * How certain the resolver is about a surfaced URL.
 *
 *  - verified:     actually reached; navigation ended there; re-confirmed.
 *  - likely:       reached, but confirmation signals are incomplete.
 *  - possible:     meaningful discovered link (continue button, destination
 *                  link) that was NOT navigated to.
 *  - intermediate: a page the chain passed through — never a destination.
 *  - unverified:   weak candidate, kept internally; normally not displayed.
 */
export type ConfidenceLevel =
  | "verified"
  | "likely"
  | "possible"
  | "intermediate"
  | "unverified";

/** Where a surfaced navigation candidate came from. */
export type CandidateSource =
  | "redirect"
  | "meta_refresh"
  | "js_navigation"
  | "continue_button"
  | "page_link"
  | "generated_url"
  | "network_response"
  | "browser"
  | "last_resort";

export interface NavigationCandidate {
  url: string;
  /** Button text / anchor text / page title associated with the link. */
  label: string | null;
  source: CandidateSource;
  confidence: ConfidenceLevel;
  /** True only when the resolver actually navigated to this URL. */
  verified: boolean;
  /** Why this candidate is surfaced. */
  reason: string;
}

/** Stages of the resolution engine. */
export type ResolutionPhase =
  | "validating"
  | "browser"
  | "http"
  | "html"
  | "waiting"
  | "discovery"
  | "popup"
  | "provider"
  | "verifying"
  | "last_resort"
  | "done";

/** Truthful progress event streamed to the frontend while resolving. */
export interface ResolutionEvent {
  phase: ResolutionPhase;
  message: string;
  /** Milliseconds since the resolution started. */
  ts: number;
}

export type ResolutionMethod = "browser" | "http" | "html" | "last_resort" | null;

/** Why resolution was blocked, when it was. */
export type Blocker = "captcha" | "auth" | "paywall" | "unsupported" | null;

/**
 * What kind of terminal destination was reached.
 *  - telegram:      t.me / telegram.me / tg:// destination
 *  - discord:       discord.gg / discord.com/invite destination
 *  - download:      a direct file download (Content-Disposition / download event)
 *  - file_host:     a recognized file/cloud storage destination
 *  - website:       a normal external website whose flow terminates there
 *  - external_app:  another external URL scheme invoked by the flow
 */
export type DestinationType =
  | "telegram"
  | "discord"
  | "download"
  | "file_host"
  | "website"
  | "external_app";

export interface UnwrapRequest {
  url: string;
  /** Include the per-stage self-diagnostic log in the response. */
  debug?: boolean;
}

/**
 * Self-diagnostic entry — one per analyzed stage. Emitted only when the
 * resolution runs in debug mode.
 */
export interface DebugEntry {
  step: number;
  url: string;
  title: string | null;
  provider: string;
  /** How this page was reached (http / js / click / generated / ...). */
  navigationSource: string;
  httpStatus: number | null;
  candidatesFound: number;
  nextCandidate: string | null;
  /** Why that candidate was selected (or why none was). */
  selectionReason: string | null;
  classification: "intermediate" | "final" | "pending" | "under_investigation";
  /** Why the page is considered intermediate / final. */
  classificationReason: string;
  sessionId: string;
  elapsedMs: number;
}

export interface UnwrapResponse {
  status: UnwrapStatus;
  /**
   * Deepest meaningful destination actually reached or observed by the
   * browser. Null when nothing could be verified — uncertain candidates
   * are exposed via `candidates` instead, never as the final answer.
   */
  finalUrl: string | null;
  /** Normalized input URL. */
  inputUrl: string;
  /** Which resolver stage verified the destination. */
  method: ResolutionMethod;
  /** Confidence in `finalUrl`. */
  confidence: ConfidenceLevel | null;
  /** Verification signals that back the confidence level. */
  verificationSignals: string[];
  /** Complete chronological redirect timeline (navigation metadata only). */
  hops: RedirectHop[];
  /**
   * Meaningful navigation candidates discovered along the way
   * (intermediate pages, continue buttons, destination links).
   * Raw/uncertain guesses are never included.
   */
  candidates: NavigationCandidate[];
  /** What kind of destination was reached (telegram/download/website/...). */
  destinationType: DestinationType | null;
  /** Terminal HTTP status observed at the destination, if any. */
  httpStatus: number | null;
  /** Number of document navigations the browser performed. */
  navigationCount: number;
  /** Total wall-clock time of the resolution, ms. */
  totalTime: number;
  /** What stopped resolution when it did not complete cleanly. */
  blocker: Blocker;
  /** Human-readable summary of the outcome. */
  message: string;
  /**
   * Why the engine stopped where it did (always set — e.g.
   * "navigation terminated — page verified as terminal",
   * "redirect loop detected", "time budget exhausted").
   */
  stopReason: string | null;
  /** Id of the isolated browser session that performed this resolution. */
  sessionId: string | null;
  /** Full progress log of the resolution (truthful, stage by stage). */
  events: ResolutionEvent[];
  /** Per-stage self-diagnostic log (present only in debug mode). */
  debugLog?: DebugEntry[];
  checkedAt: string;
}

/** Error envelope for rate limiting / malformed requests (non-2xx HTTP). */
export interface UnwrapError {
  error: string;
  message: string;
}
