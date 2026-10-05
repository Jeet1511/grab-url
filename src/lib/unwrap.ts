import type {
  CandidateSource,
  ConfidenceLevel,
  ResolutionEvent,
  UnwrapResponse,
  UnwrapStatus,
} from "@contracts/unwrap";

/** Plain request/response variant (fallback when streaming is unavailable). */
export async function unwrapUrl(url: string, debug = false): Promise<UnwrapResponse> {
  const res = await fetch("/api/unwrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, debug }),
  });
  if (res.status === 429) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "Rate limited — try again shortly.");
  }
  if (!res.ok) {
    throw new Error(`Request failed (HTTP ${res.status}).`);
  }
  return (await res.json()) as UnwrapResponse;
}

/**
 * Streaming variant: the server reports truthful progress while it works
 * (waiting on countdown gates, analyzing pages, verifying the destination),
 * then delivers the final UnwrapResponse. Falls back reject on transport
 * failure so the caller can retry with the plain endpoint.
 */
export function unwrapUrlStreaming(
  url: string,
  onEvent: (event: ResolutionEvent) => void,
  debug = false,
): Promise<UnwrapResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const source = new EventSource(
      `/api/unwrap/stream?url=${encodeURIComponent(url)}${debug ? "&debug=1" : ""}`,
    );

    const cleanup = (): void => {
      settled = true;
      source.close();
    };

    source.addEventListener("progress", (ev) => {
      try {
        onEvent(JSON.parse((ev as MessageEvent).data) as ResolutionEvent);
      } catch {
        /* ignore malformed progress frames */
      }
    });

    source.addEventListener("result", (ev) => {
      if (settled) return;
      try {
        const result = JSON.parse((ev as MessageEvent).data) as UnwrapResponse;
        cleanup();
        resolve(result);
      } catch {
        cleanup();
        reject(new Error("Received an unreadable result from the server."));
      }
    });

    source.addEventListener("error", (ev) => {
      if (settled) return;
      cleanup();
      const data = (ev as MessageEvent).data;
      if (typeof data === "string" && data.length > 0) {
        try {
          reject(new Error((JSON.parse(data) as { message?: string }).message ?? "Resolution failed."));
          return;
        } catch {
          /* fall through */
        }
      }
      reject(new Error("The progress stream was interrupted."));
    });
  });
}

export interface StatusMeta {
  label: string;
  tone: "ok" | "warn" | "err";
  hint: string;
}

export const STATUS_META: Record<UnwrapStatus, StatusMeta> = {
  resolved: {
    label: "RESOLVED",
    tone: "ok",
    hint: "The final destination was verified.",
  },
  redirect_chain: {
    label: "REDIRECT CHAIN",
    tone: "ok",
    hint: "Followed a multi-hop redirect chain to its verified end.",
  },
  no_redirect: {
    label: "NO REDIRECT",
    tone: "ok",
    hint: "This URL does not redirect — it is already the final destination.",
  },
  loop_detected: {
    label: "LOOP DETECTED",
    tone: "err",
    hint: "The redirect chain loops back on itself. There is no final destination.",
  },
  timeout: {
    label: "TIMEOUT",
    tone: "err",
    hint: "The destination did not respond in time. It may be slow or blocking automated requests.",
  },
  invalid_url: {
    label: "INVALID URL",
    tone: "warn",
    hint: "The input could not be parsed as an http/https URL.",
  },
  destination_unavailable: {
    label: "DESTINATION UNAVAILABLE",
    tone: "warn",
    hint: "The chain was followed to its end, but the destination answered with an error.",
  },
  blocked_or_unsupported: {
    label: "NOT VERIFIED",
    tone: "warn",
    hint: "The destination could not be verified automatically — nothing uncertain is shown as final.",
  },
  redirect_limit: {
    label: "REDIRECT LIMIT",
    tone: "err",
    hint: "The chain exceeded the maximum number of redirects.",
  },
  network_error: {
    label: "NETWORK ERROR",
    tone: "err",
    hint: "The destination could not be reached (DNS, connection, or TLS failure).",
  },
};

export interface ConfidenceMeta {
  label: string;
  tone: "ok" | "warn" | "err" | "dim";
}

export const CONFIDENCE_META: Record<ConfidenceLevel, ConfidenceMeta> = {
  verified: { label: "VERIFIED DESTINATION", tone: "ok" },
  likely: { label: "LIKELY DESTINATION", tone: "warn" },
  possible: { label: "POSSIBLE DESTINATION", tone: "warn" },
  intermediate: { label: "INTERMEDIATE PAGE", tone: "dim" },
  unverified: { label: "UNVERIFIED LINK", tone: "err" },
};

export const METHOD_LABEL: Record<string, string> = {
  http: "HTTP",
  html: "HTML ANALYSIS",
  browser: "ISOLATED BROWSER",
  last_resort: "DEEP ANALYSIS",
};

export const HOP_TYPE_LABEL: Record<string, string> = {
  http: "HTTP REDIRECT",
  meta: "META REFRESH",
  js: "SCRIPT NAVIGATION",
  browser: "BROWSER",
  click: "USER NAVIGATION",
  popup: "NEW TAB",
  generated: "GENERATED URL",
  scheme: "EXTERNAL APP",
};

export const SOURCE_LABEL: Record<CandidateSource, string> = {
  redirect: "REDIRECT",
  meta_refresh: "META REFRESH",
  js_navigation: "JS NAVIGATION",
  continue_button: "CONTINUE CONTROL",
  page_link: "PAGE LINK",
  generated_url: "GENERATED URL",
  network_response: "NETWORK RESPONSE",
  browser: "BROWSER",
  last_resort: "DEEP ANALYSIS",
};

export const PHASE_LABEL: Record<string, string> = {
  validating: "VALIDATING",
  http: "HTTP REDIRECT",
  html: "PAGE ANALYSIS",
  discovery: "EXTRACTING",
  waiting: "WAITING",
  browser: "BROWSER SESSION",
  popup: "NEW TAB",
  provider: "PROVIDER",
  last_resort: "DEEP ANALYSIS",
  verifying: "VERIFYING",
  done: "DONE",
};

export const DESTINATION_TYPE_LABEL: Record<string, string> = {
  telegram: "TELEGRAM",
  discord: "DISCORD",
  download: "DIRECT DOWNLOAD",
  file_host: "FILE / CLOUD HOST",
  website: "WEBSITE",
  external_app: "EXTERNAL APP",
};

export const BLOCKER_LABEL: Record<string, string> = {
  captcha: "CAPTCHA / SECURITY CHALLENGE",
  auth: "AUTHENTICATION REQUIRED",
  paywall: "PAYWALL",
  unsupported: "UNSUPPORTED FLOW",
};
