/**
 * Browser Session Engine — the PRIMARY resolution engine.
 *
 * Architecture:
 *
 *   ONE RESOLUTION JOB
 *         ↓
 *   ONE PERSISTENT BROWSER CONTEXT
 *         ↓
 *   MULTIPLE NAVIGATION STAGES  (same session through the entire chain)
 *         ↓
 *   FINAL DESTINATION
 *
 * The context is created once per resolution and destroyed ONLY when the
 * resolution job ends. Cookies, session storage, navigation history and
 * referrer context live for the whole journey — state-dependent redirect
 * systems are followed exactly the way a user's browser would follow them.
 * Nothing survives the job itself: no profile, cache or cookie is kept
 * between resolutions.
 *
 * The engine observes the browser's COMPLETE navigation lifecycle:
 *  - HTTP 3xx redirect hops on document requests
 *  - meta refresh navigations
 *  - JavaScript navigations (location.href / replace / assign, timers)
 *  - forms, popups and new tabs (window.open, target=_blank)
 *  - session-generated URLs (token links built by client-side logic) —
 *    followed in the SAME context, never re-requested as fresh sessions
 *  - external URL schemes invoked by the flow (tg://, ...)
 *  - ordinary, clearly identifiable continue/proceed controls (clicked
 *    like a user would — never ads, logins, payments or permission prompts)
 *  - countdown gates, waited out with event-driven waits
 *
 * A page is NEVER considered final because it returned HTTP 200. Every
 * stable page is inspected (DOM, continuation controls, generated URLs,
 * network observations, provider rules) and only marked FINAL when the
 * navigation has genuinely terminated. Every stage decision is written to
 * a self-diagnostic log, and the engine always reports why it stopped.
 *
 * SSRF protection is enforced on every request the browser makes.
 */

import nodeModule from "node:module";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Browser, BrowserContext, Page, Response } from "playwright-core";
import type {
  DebugEntry,
  DestinationType,
  HopType,
  NodeClassification,
  RedirectHop,
  ResolutionPhase,
} from "@contracts/unwrap";
import { SsrfBlockError, assertUrlSafe } from "./ssrf-protection";
import { loopKey, resolveRedirectTarget } from "./url-validator";
import type { DiscoveredLink } from "./link-discovery";
import { GENERIC_PROVIDER, detectProvider, type ProviderAdapter } from "./providers";
import { classifyDestinationUrl, isDownloadResponse } from "./destination";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export class BrowserUnavailableError extends Error {
  constructor(message = "isolated browser worker is not available") {
    super(message);
    this.name = "BrowserUnavailableError";
  }
}

export class BrowserNavigationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserNavigationError";
  }
}

/* ------------------------------------------------------------------ */
/* Configuration (all limits are configurable from the backend env)    */
/* ------------------------------------------------------------------ */

export interface BrowserSessionConfig {
  /**
   * Hard cap for the whole resolution job (MAX_RUNTIME_MS). Default 300s:
   * multi-stage gate chains need several countdown waits (~45–75s each) —
   * a 60s cap would cut every real gate journey short.
   */
  totalTimeoutMs: number;
  /** Maximum navigation steps tracked (MAX_STEPS). Default 40. */
  maxSteps: number;
  /** Maximum distinct pages fully analyzed (MAX_PAGES). Default 16. */
  maxPages: number;
  /** Maximum popup / new-tab pages. Default 8. */
  maxPopups: number;
  /** Observation window per page for spontaneous navigation. Default 6s. */
  navSettleMs: number;
  /** How long visible countdown gates are waited out. Default 25s. */
  countdownWaitMs: number;
  /**
   * Deep-investigation wait for a gate page whose continuation control is
   * hidden behind a client-side timer/state change (the control exists but
   * is display:none until the gate script reveals it). Default 75s.
   */
  gateWaitMs: number;
  /** Last-chance watch for late-appearing continuation. Default 8s. */
  lateControlWaitMs: number;
  /**
   * Identical page-state repetitions before a loop is declared
   * (MAX_REPEATED_STATE). Default 2 — the fingerprint mixes URL + provider
   * + control state + visible content, so a revisited URL whose session
   * state advanced (step 1/3 → 2/3 → 3/3) is NOT a repeat.
   */
  maxRepeatedState: number;
  /**
   * Hard cap on how often the exact same URL may be visited (loop ceiling
   * for chains whose page content keeps changing). Default 4 — must exceed
   * the legitimate step count of multi-stage gate flows.
   */
  maxUrlVisits: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function browserSessionConfig(): BrowserSessionConfig {
  return {
    totalTimeoutMs: envInt("UNWRAP_TOTAL_TIMEOUT_MS", 300_000),
    maxSteps: envInt("UNWRAP_MAX_STEPS", 40),
    maxPages: envInt("UNWRAP_MAX_PAGES", 16),
    maxPopups: envInt("UNWRAP_MAX_POPUPS", 8),
    navSettleMs: envInt("UNWRAP_NAV_SETTLE_MS", 6_000),
    countdownWaitMs: envInt("UNWRAP_COUNTDOWN_WAIT_MS", 25_000),
    gateWaitMs: envInt("UNWRAP_GATE_WAIT_MS", 75_000),
    lateControlWaitMs: envInt("UNWRAP_LATE_CONTROL_WAIT_MS", 8_000),
    maxRepeatedState: envInt("UNWRAP_MAX_REPEATED_STATE", 2),
    maxUrlVisits: envInt("UNWRAP_MAX_URL_VISITS", 4),
  };
}

/* ------------------------------------------------------------------ */
/* Result model                                                        */
/* ------------------------------------------------------------------ */

export interface SessionNav {
  /** Document URL observed on a page's main frame. */
  url: string;
  /** Ms since session start. */
  at: number;
  /** How this navigation happened. */
  type: HopType;
  /** HTTP status observed for this document, when known. */
  status: number | null;
  /** True when observed in a popup / new tab. */
  inPopup: boolean;
  /** Button text / page title associated with the step. */
  label: string | null;
  /** <title> of the page at this URL, when known. */
  title: string | null;
  /** Provider identified at this URL. */
  provider: string | null;
  /** intermediate = passed through; final = verified terminal destination. */
  classification: NodeClassification;
}

export interface BrowserSessionResult {
  /** Ordered navigation observations (first entry is the input URL). */
  navs: SessionNav[];
  /** Deepest http(s) destination reached. */
  deepestUrl: string;
  /** Terminal HTTP status for the deepest destination, when known. */
  terminalStatus: number | null;
  /** Title of the deepest page, when known. */
  terminalTitle: string | null;
  /** External scheme invoked by the flow (tg://…), when observed. */
  schemeTarget: string | null;
  /** A file download triggered by the flow, when observed. */
  downloadTarget: { url: string; filename: string | null } | null;
  /** What kind of destination the deepest URL is. */
  destinationType: DestinationType | null;
  /** True only when navigation genuinely terminated at the deepest page. */
  terminalIsFinal: boolean;
  loopDetected: boolean;
  /** Session hit its time budget while navigation was still ongoing. */
  timedOut: boolean;
  /** Navigation step cap hit. */
  navigationLimitHit: boolean;
  blocker: "captcha" | "auth" | null;
  /** Continue-style links observed while navigating (already SSRF-safe). */
  discovered: DiscoveredLink[];
  /** Per-stage self-diagnostic log. */
  debugLog: DebugEntry[];
  /** Why the engine stopped where it did. Always set. */
  stopReason: string;
  /** Id of the isolated session that performed this resolution. */
  sessionId: string;
}

interface PlaywrightModule {
  chromium: {
    launch(options: Record<string, unknown>): Promise<Browser>;
  };
}

function findChromiumExecutable(): string | null {
  const candidates = [
    process.env.URL_UNWRAPPER_CHROMIUM_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_PATH,
    process.env.CHROMIUM_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ].filter((p): p is string => Boolean(p));
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function loadPlaywright(): PlaywrightModule {
  // Runtime require keeps esbuild from bundling the driver and lets the app
  // degrade gracefully when no browser is installed in the environment.
  const req = nodeModule.createRequire(import.meta.url);
  return req("playwright-core") as PlaywrightModule;
}

/* ------------------------------------------------------------------ */
/* In-page inspection (runs inside the browser context)                */
/* ------------------------------------------------------------------ */

const MARK_ATTR = "data-uw-continue-target";

interface ContinueElement {
  text: string;
  disabled: boolean;
  href: string | null;
  /** href is "#" or a bare fragment — the real action lives in onclick. */
  hashOnly: boolean;
}

/** A navigation destination exposed by the page itself. */
interface PageCandidate {
  url: string;
  label: string | null;
  method: "DOM_LINK" | "GENERATED_URL" | "FORM" | "SCRIPT";
  score: number;
}

interface PageScan {
  /** First visible SAFE continue-style element, if any. */
  element: ContinueElement | null;
  /**
   * A continue-style control that EXISTS in the DOM but is currently hidden
   * (display:none / visibility:hidden) — the hallmark of a timer-gated
   * multi-stage flow. The engine must wait for it, not stop.
   */
  pendingControl: { text: string } | null;
  /**
   * Inline page scripts contain timer/state logic that toggles element
   * visibility (setInterval/setTimeout + style.display changes) — i.e. the
   * page will change state on its own if we keep observing.
   */
  timerGate: boolean;
  /** Continue-style links (for the candidate list). */
  links: { url: string; label: string | null }[];
  /** Ranked navigation candidates exposed by the page. */
  candidates: PageCandidate[];
  /** Terminal-type links presented by the page (t.me, discord.gg, ...). */
  terminalLinks: { url: string; dtype: DestinationType }[];
  /** Page looks like a countdown gate ("please wait N seconds"). */
  looksLikeCountdown: boolean;
  /** Meta refresh declared by the page. */
  metaRefresh: { target: string; delaySeconds: number } | null;
  /** CAPTCHA / anti-bot challenge detected. */
  captcha: boolean;
  /** Authentication wall detected (visible password field). */
  authWall: boolean;
  /** External-scheme links presented by the page (tg://, ...). */
  schemeLinks: string[];
  title: string | null;
  /** Short normalized visible-text sample (page-state fingerprint input). */
  textSample: string | null;
}

/*
 * The functions below execute INSIDE Chromium (via page.evaluate), not in
 * Node. The server-side tsconfig has no DOM lib, so the browser globals
 * they touch are declared loosely here.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const document: any;
declare const window: any;
declare const MutationObserver: any;

function scanPageInBrowser(extraContinueSource: string | null): PageScan {
  // Clearly identifiable ordinary navigation controls.
  let continueSource =
    "\\b(continue|proceed|next|get\\s+link|generate\\s+link|open\\s+link|go\\s+to\\s+link|visit\\s+link|skip\\s+ad|click\\s+here|take\\s+me|unlock(\\s+link)?|access\\s+(the\\s+)?link|continue\\s+to\\s+(the\\s+)?(link|destination)|proceed\\s+to\\s+(the\\s+)?link)\\b";
  if (extraContinueSource) continueSource += "|(?:" + extraContinueSource + ")";
  const CONTINUE = new RegExp(continueSource, "i");
  // Things that must never be clicked even if they match CONTINUE.
  const FORBIDDEN =
    /\b(log\s*in|login|sign\s*in|signin|sign\s*up|signup|register|subscribe|pay|payment|buy|purchase|checkout|donate|download|install|allow|notifications?|accept|agree|delete|remove|report|share|tweet|follow|verify\s+you|i'?m\s+not\s+a\s+robot)\b/i;
  // Hosts that are essentially never the destination.
  const IGNORE_HOSTS =
    /(^|\.)(doubleclick\.net|googlesyndication\.com|google-analytics\.com|googletagmanager\.com|adservice\.google\.[a-z.]+|facebook\.com|twitter\.com|x\.com|instagram\.com|youtube\.com|play\.google\.com|apps\.apple\.com)$/i;
  const IGNORE_PATHS =
    /\/(share|intent|sharer|login|signin|sign-in|signup|register|privacy|terms|imprint|about|contact|advertise|press|careers|legal)(\/|$|\?)/i;

  const out: PageScan = {
    element: null,
    pendingControl: null,
    timerGate: false,
    links: [],
    candidates: [],
    terminalLinks: [],
    looksLikeCountdown: false,
    metaRefresh: null,
    captcha: false,
    authWall: false,
    schemeLinks: [],
    title: document.title ? String(document.title).slice(0, 120) : null,
    textSample: null,
  };

  // Full-screen overlay walls (ad overlays, "click ads to continue" covers).
  // Controls INSIDE them are part of the ad wall — never the real
  // continuation — so they are excluded from continuation selection.
  const inOverlay = (el: any): boolean => {
    let node = el;
    while (node && node !== document.body) {
      const marker = `${node.id ?? ""} ${typeof node.className === "string" ? node.className : ""}`;
      if (/(^|[-_\s])(ad[-_]?overlay|ggd-container|ad[-_]?wall|overlay)([-_\s]|$)/i.test(marker)) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  };

  const classifyTerminal = (raw: string): DestinationType | null => {
    if (/^tg:\/\//i.test(raw)) return "telegram";
    try {
      const u = new URL(raw, window.location.href);
      const h = u.hostname.toLowerCase();
      if (/(^|\.)(t\.me|telegram\.me|telegram\.dog)$/.test(h)) return "telegram";
      if (/(^|\.)discord\.gg$/.test(h)) return "discord";
      if (/(^|\.)(discord\.com|discordapp\.com)$/.test(h) && /^\/(invite|channels)\//i.test(u.pathname))
        return "discord";
      if (
        /(^|\.)(drive\.google\.com|mega\.nz|mediafire\.com|dropbox\.com|terabox\.com|gofile\.io|pixeldrain\.com|workupload\.com)$/.test(
          h,
        )
      )
        return "file_host";
    } catch {
      /* not a URL */
    }
    return null;
  };

  // ── meta refresh ────────────────────────────────────────────────
  const meta = document.querySelector('meta[http-equiv="refresh" i]');
  if (meta) {
    const content = String(meta.getAttribute("content") ?? "");
    const m = content.match(/^\s*(\d+(?:\.\d+)?)\s*(?:;\s*url\s*=\s*(.+))?$/i);
    if (m && m[2]) {
      let target = m[2].trim().replace(/^["']|["']$/g, "");
      try {
        target = new URL(target, window.location.href).toString();
        out.metaRefresh = { target, delaySeconds: Number(m[1]) };
      } catch {
        /* unparseable meta target */
      }
    }
  }

  // ── CAPTCHA / anti-bot challenge ────────────────────────────────
  const captchaSelectors = [
    "iframe[src*='recaptcha']",
    "iframe[src*='hcaptcha']",
    "iframe[src*='turnstile']",
    "iframe[src*='challenges.cloudflare']",
    ".g-recaptcha",
    ".h-captcha",
    ".cf-turnstile",
    "#cf-challenge-running",
  ];
  out.captcha = captchaSelectors.some((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!out.captcha) {
    const bodyStart = String(document.body?.innerText ?? "").slice(0, 600);
    out.captcha =
      /verify you are (a )?human|are you a robot|checking your browser/i.test(bodyStart);
  }

  // ── authentication wall ─────────────────────────────────────────
  const pw = document.querySelector("input[type='password']");
  if (pw) {
    const r = pw.getBoundingClientRect();
    out.authWall = r.width > 0 && r.height > 0;
  }

  // ── external scheme + terminal links ────────────────────────────
  const schemeSeen = new Set<string>();
  const terminalSeen = new Set<string>();
  const addTerminal = (raw: string): void => {
    const dtype = classifyTerminal(raw);
    if (!dtype) return;
    let abs = raw;
    if (/^https?:\/\//i.test(raw)) {
      try {
        abs = new URL(raw, window.location.href).toString();
      } catch {
        return;
      }
    }
    if (terminalSeen.has(abs)) return;
    terminalSeen.add(abs);
    out.terminalLinks.push({ url: abs.slice(0, 500), dtype });
  };

  const visible = (el: any): boolean => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  };

  // ── continue-style controls + ranked candidates ─────────────────
  const els: any[] = Array.from(
    document.querySelectorAll(
      "a,button,[role='button'],input[type='submit'],input[type='button']",
    ),
  );
  const scored: { el: any; text: string; score: number }[] = [];
  const candidateSeen = new Set<string>();
  const docHeight = Math.max(1, document.body?.scrollHeight ?? 1);

  const pushCandidate = (
    url: string,
    label: string | null,
    method: PageCandidate["method"],
    score: number,
  ): void => {
    try {
      const u = new URL(url, window.location.href);
      if (u.protocol !== "http:" && u.protocol !== "https:") return;
      const abs = u.toString();
      if (candidateSeen.has(abs)) return;
      if (abs === window.location.href) return;
      let s = score;
      if (IGNORE_HOSTS.test(u.hostname)) s -= 80;
      if (IGNORE_PATHS.test(u.pathname)) s -= 35;
      if (/\b(utm_[a-z]+|fbclid|gclid)\b/i.test(u.search)) s -= 10;
      if (s < 55) return;
      candidateSeen.add(abs);
      out.candidates.push({
        url: abs.slice(0, 500),
        label: label ? label.slice(0, 80) : null,
        method,
        score: Math.max(0, Math.min(100, s)),
      });
    } catch {
      /* malformed candidate */
    }
  };

  const decodeB64 = (raw: string): string | null => {
    try {
      let s = raw.replace(/-/g, "+").replace(/_/g, "/");
      while (s.length % 4 !== 0) s += "=";
      const bin = window.atob(s);
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(bin)) return null;
      return bin;
    } catch {
      return null;
    }
  };

  /** URLs found inside inline scripts — possible generated destinations. */
  const pushScriptCandidate = (raw: string): boolean => {
    const before = out.candidates.length;
    pushCandidate(raw, "inline script", "SCRIPT", 62);
    return out.candidates.length > before;
  };

  for (const el of els) {
    const text = String(
      el.innerText ||
        el.value ||
        el.getAttribute("aria-label") ||
        el.getAttribute("title") ||
        el.textContent || // fallback: hidden elements still carry their label
        "",
    )
      .replace(/\s+/g, " ")
      .trim();

    const hrefAttr = String(el.getAttribute("href") ?? "").trim();
    const href: string | null =
      el.href || el.getAttribute("formaction") || el.getAttribute("data-href") || null;

    if (/^(tg|intent|fb|twitter|whatsapp|viber|line):/i.test(hrefAttr)) {
      if (!schemeSeen.has(hrefAttr)) {
        schemeSeen.add(hrefAttr);
        out.schemeLinks.push(hrefAttr.slice(0, 500));
      }
    }
    if (hrefAttr && /^https?:\/\//i.test(hrefAttr)) addTerminal(hrefAttr);

    // Hidden continuation controls: the signature of a timer/state gate.
    // The element exists but is not revealed yet — record it so the engine
    // WAITS for it instead of declaring "no continuation found".
    if (!visible(el)) {
      if (text && text.length <= 80 && CONTINUE.test(text) && !FORBIDDEN.test(text)) {
        try {
          el.setAttribute("data-uw-pending", "1");
        } catch {
          /* read-only DOM */
        }
        if (!out.pendingControl) out.pendingControl = { text: text.slice(0, 80) };
      }
      continue;
    }
    if (inOverlay(el)) continue; // ad-wall controls are never the continuation
    const rect = el.getBoundingClientRect();

    // Candidate scoring for every visible http(s) link/button.
    if (href && /^https?:\/\//i.test(href)) {
      let score = 0;
      if (text && text.length <= 80 && CONTINUE.test(text)) score += 45;
      if (
        el.tagName === "BUTTON" ||
        el.getAttribute("role") === "button" ||
        /\b(btn|button)\b/i.test(String(el.className ?? ""))
      )
        score += 15;
      if (rect.top < window.innerHeight) score += 10;
      try {
        const u = new URL(href);
        if (u.hostname.toLowerCase() !== window.location.hostname.toLowerCase()) score += 10;
      } catch {
        /* ignore */
      }
      if (text && text.length <= 80 && CONTINUE.test(text) && !FORBIDDEN.test(text)) {
        pushCandidate(href, text, "DOM_LINK", score);
      }
    }

    // Session-generated destinations in data attributes / onclick handlers.
    for (const name of [
      "data-href",
      "data-url",
      "data-link",
      "data-target",
      "data-redirect",
      "data-destination",
    ]) {
      const v = el.getAttribute(name);
      if (v && /^https?:\/\//i.test(String(v).trim())) {
        pushCandidate(String(v).trim(), text || null, "GENERATED_URL", 60);
        addTerminal(String(v).trim());
      }
    }
    const onclick = el.getAttribute("onclick");
    if (onclick) {
      const m =
        String(onclick).match(
          /(?:window\s*\.\s*)?location(?:\s*\.\s*href)?\s*=\s*(["'])((?:\\.|(?!\1).)*)\1/i,
        ) ??
        String(onclick).match(
          /location\s*\.\s*(?:assign|replace)\s*\(\s*(["'])((?:\\.|(?!\1).)*)\1\s*\)/i,
        );
      if (m && m[2] && /^(https?:\/\/|\/)/.test(m[2])) {
        pushCandidate(m[2], text || null, "GENERATED_URL", 58);
        addTerminal(m[2]);
      }
    }

    // Continue-control scoring (for clicking).
    if (!text || text.length > 80) continue;
    if (!CONTINUE.test(text)) continue;
    if (FORBIDDEN.test(text)) continue; // never click logins, ads, downloads…
    let score = 0;
    if (/\b(continue|proceed|get\s+link|generate\s+link|open\s+link|skip\s+ad)\b/i.test(text))
      score += 3;
    if (el.tagName === "BUTTON" || el.getAttribute("role") === "button") score += 2;
    if (rect.top < window.innerHeight) score += 1;
    if (rect.top < docHeight * 0.6) score += 1;
    scored.push({ el, text, score });
  }
  scored.sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  for (const { el, text } of scored) {
    const disabled =
      el.disabled === true ||
      el.getAttribute("aria-disabled") === "true" ||
      el.classList.contains("disabled");
    const href: string | null =
      el.href || el.getAttribute("formaction") || el.getAttribute("data-href") || null;

    if (href && /^https?:\/\//i.test(href) && !seen.has(href)) {
      seen.add(href);
      out.links.push({ url: href, label: text });
    }
    if (!out.element) {
      el.setAttribute("data-uw-continue-target", "1");
      const hrefAttr = String(el.getAttribute("href") ?? "").trim();
      const hashOnly = hrefAttr === "" || hrefAttr.startsWith("#");
      out.element = { text: text.slice(0, 80), disabled, href, hashOnly };
    }
  }

  // GET forms can be legitimate continuation steps.
  for (const form of Array.from(document.querySelectorAll("form")) as any[]) {
    const method = String(form.getAttribute("method") ?? "get").toLowerCase();
    const action = String(form.getAttribute("action") ?? "").trim();
    if (method === "get" && action) pushCandidate(action, null, "FORM", 40);
  }

  // Terminal links anywhere in the document (even hidden blocks).
  for (const a of Array.from(document.querySelectorAll("a[href]")) as any[]) {
    const href = String(a.getAttribute("href") ?? "");
    if (/^https?:\/\//i.test(href)) addTerminal(href);
  }

  // ── dynamic URL extraction from inline scripts ────────────────
  // Multi-stage gates embed the next stage (or a session-generated token
  // URL) in inline JavaScript: location targets, window.open() calls,
  // JSON config, base64 payloads. Extract them as candidates — discovery
  // is not navigation; scoring decides what gets followed.
  let hasTimerScript = false;
  let hasDisplayToggle = false;
  const scripts = Array.from(document.querySelectorAll("script:not([src])")) as any[];
  for (const s of scripts) {
    const body = String(s.textContent ?? "");
    if (!body || body.length > 200_000) continue;
    if (/setInterval\s*\(|setTimeout\s*\(/.test(body)) hasTimerScript = true;
    if (/\.style\.display|\.style\.visibility|classList\.(add|remove|toggle)/.test(body)) {
      hasDisplayToggle = true;
    }
    let scriptCandidates = 0;
    for (const m of body.matchAll(/https?:\/\/[^\s"'`<>\\)\]}]+/gi)) {
      if (scriptCandidates >= 3) break;
      const raw = m[0].replace(/[.,;]+$/, "");
      try {
        const u = new URL(raw);
        if (IGNORE_HOSTS.test(u.hostname)) continue;
        if (u.hostname.toLowerCase() === window.location.hostname.toLowerCase()) continue;
        if (pushScriptCandidate(raw)) scriptCandidates += 1;
      } catch {
        /* malformed */
      }
    }
    // base64/base64url payloads hiding URLs (atob("…") literals).
    for (const m of body.matchAll(/\batob\s*\(\s*(["'`])([A-Za-z0-9+/=_-]{16,})\1\s*\)/g)) {
      if (scriptCandidates >= 4) break;
      const decoded = decodeB64(m[2]);
      if (decoded && /^https?:\/\//i.test(decoded) && pushScriptCandidate(decoded)) {
        scriptCandidates += 1;
      }
    }
  }
  out.timerGate = hasTimerScript && hasDisplayToggle;

  // ── page-state fingerprint sample ─────────────────────────────
  const sample = String(document.body?.innerText ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  out.textSample = sample || null;

  // ── countdown gate ──────────────────────────────────────────────
  const bodyText = String(document.body?.innerText ?? "").slice(0, 4000);
  out.looksLikeCountdown =
    /\b(please\s+wait|waiting)\b/i.test(bodyText) ||
    /\b\d+\s*(s|sec|seconds?)\b.{0,40}\b(wait|remain|left)\b/i.test(bodyText) ||
    /\bwait\b.{0,30}\b\d+\s*(s|sec|seconds?)\b/i.test(bodyText) ||
    /\bredirecting\b.{0,30}\b\d+\b/i.test(bodyText) ||
    /\blink\s+is\s+(being\s+)?(generated|prepared|getting\s+ready)\b/i.test(bodyText);
  if (!out.looksLikeCountdown && out.element?.disabled) out.looksLikeCountdown = true;

  return out;
}

/**
 * Last-chance watch: waits (event-driven, via MutationObserver) for a
 * continue-style control to APPEAR on a page that currently shows none.
 * Resolves true as soon as a control materializes.
 */
function watchForLateControl(maxMs: number): Promise<boolean> {
  const CONTINUE =
    /\b(continue|proceed|next|get\s+link|generate\s+link|open\s+link|skip\s+ad|click\s+here|unlock(\s+link)?)\b/i;
  const FORBIDDEN =
    /\b(log\s*in|sign\s*in|sign\s*up|subscribe|pay|download|install|allow|accept|agree)\b/i;

  const hasControl = (): boolean => {
    for (const el of Array.from(
      document.querySelectorAll("a,button,[role='button']"),
    ) as any[]) {
      const t = String(el.innerText || el.value || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 80 || !CONTINUE.test(t) || FORBIDDEN.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }
    return false;
  };

  return new Promise<boolean>((resolve) => {
    if (hasControl()) return resolve(true);
    const obs = new MutationObserver(() => {
      if (hasControl()) {
        obs.disconnect();
        resolve(true);
      }
    });
    try {
      obs.observe(document.body ?? document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    } catch {
      return resolve(false);
    }
    setTimeout(() => {
      obs.disconnect();
      resolve(hasControl());
    }, maxMs);
  });
}

/**
 * Gate wait (event-driven): watches a gate page for its hidden continuation
 * control to BECOME visible — the timer/state script reveals it by flipping
 * display/visibility or by inserting a new element. Uses MutationObserver on
 * attributes + subtree; no arbitrary sleep. Resolves true as soon as a safe
 * continue-style control is visible; false when the wait budget elapses.
 */
function waitForRevealedControl(maxMs: number): Promise<boolean> {
  const CONTINUE =
    /\b(continue|proceed|next|get\s+link|generate\s+link|open\s+link|go\s+to\s+link|visit\s+link|skip\s+ad|click\s+here|take\s+me|unlock(\s+link)?|access\s+(the\s+)?link|continue\s+to\s+(the\s+)?(link|destination)|proceed\s+to\s+(the\s+)?link)\b/i;
  const FORBIDDEN =
    /\b(log\s*in|login|sign\s*in|signin|sign\s*up|signup|register|subscribe|pay|payment|buy|purchase|checkout|donate|download|install|allow|notifications?|accept|agree|delete|remove|report|share|tweet|follow|verify\s+you|i'?m\s+not\s+a\s+robot)\b/i;

  const inOverlay = (el: any): boolean => {
    let node = el;
    while (node && node !== document.body) {
      const marker = `${node.id ?? ""} ${typeof node.className === "string" ? node.className : ""}`;
      if (/(^|[-_\s])(ad[-_]?overlay|ggd-container|ad[-_]?wall|overlay)([-_\s]|$)/i.test(marker)) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  };

  const visibleControl = (): any | null => {
    for (const el of Array.from(
      document.querySelectorAll("a,button,[role='button'],input[type='submit'],input[type='button']"),
    ) as any[]) {
      const t = String(el.innerText || el.value || el.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!t || t.length > 80 || !CONTINUE.test(t) || FORBIDDEN.test(t)) continue;
      if (inOverlay(el)) continue; // ad-wall buttons are not the continuation
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      if (
        r.width > 0 &&
        r.height > 0 &&
        st.display !== "none" &&
        st.visibility !== "hidden" &&
        el.disabled !== true &&
        el.getAttribute("aria-disabled") !== "true"
      ) {
        return el;
      }
    }
    return null;
  };

  return new Promise<boolean>((resolve) => {
    const first = visibleControl();
    if (first) {
      try {
        first.setAttribute("data-uw-continue-target", "1");
      } catch {
        /* read-only DOM */
      }
      return resolve(true);
    }
    let done = false;
    const finish = (ok: boolean, el?: any): void => {
      if (done) return;
      done = true;
      obs.disconnect();
      if (ok && el) {
        try {
          el.setAttribute("data-uw-continue-target", "1");
        } catch {
          /* read-only DOM */
        }
      }
      resolve(ok);
    };
    const obs = new MutationObserver(() => {
      const el = visibleControl();
      if (el) finish(true, el);
    });
    try {
      obs.observe(document.body ?? document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["style", "class", "hidden", "disabled", "aria-disabled", "href"],
      });
    } catch {
      return resolve(false);
    }
    setTimeout(() => finish(Boolean(visibleControl()), visibleControl() ?? undefined), maxMs);
  });
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

interface PageTracker {
  page: Page;
  id: number;
  isPopup: boolean;
  /** Popup already represented in the chain (e.g. via window.open hook). */
  consumed?: boolean;
  /** Main-frame document URLs observed on this page, in order. */
  urls: { url: string; at: number }[];
  /** How many entries of `urls` were already flushed into the nav chain. */
  flushedCount: number;
  /** Latest known HTTP status per URL. */
  status: Map<string, number>;
}

function lastUrlOf(tracker: PageTracker): string | null {
  const urls = tracker.urls;
  return urls.length ? urls[urls.length - 1].url : null;
}

function isHttpUrl(raw: string): boolean {
  return /^https?:\/\//i.test(raw);
}

/**
 * Open `startUrl` in ONE isolated browser session and follow the complete
 * navigation journey — across domains, providers and waiting stages — until
 * a verified terminal destination, a genuine loop, a blocker, or a budget
 * limit. The context is destroyed only when this function returns.
 *
 * Throws BrowserUnavailableError when no browser exists in this
 * environment; SsrfBlockError / BrowserNavigationError on policy and
 * navigation failures.
 */
export async function runBrowserSession(
  startUrl: URL,
  onEvent: (phase: ResolutionPhase, message: string) => void = () => {},
  config: BrowserSessionConfig = browserSessionConfig(),
): Promise<BrowserSessionResult> {
  const executablePath = findChromiumExecutable();
  if (!executablePath) throw new BrowserUnavailableError();

  let playwright: PlaywrightModule;
  try {
    playwright = loadPlaywright();
  } catch {
    throw new BrowserUnavailableError("playwright-core is not installed");
  }

  const startedAt = Date.now();
  const deadline = startedAt + config.totalTimeoutMs;
  const now = () => Date.now() - startedAt;
  const sessionId = randomUUID().slice(0, 8);

  const navs: SessionNav[] = [];
  const discovered = new Map<string, DiscoveredLink>();
  const networkCandidates = new Map<string, { url: string; at: number }>();
  const seenKeys = new Set<string>([loopKey(startUrl)]);
  /**
   * Smart loop accounting: how many times each URL was actually visited.
   * A URL may legitimately REAPPEAR with different session state (gate
   * flows re-render the same article URL at step 1/3, 2/3, 3/3) — only a
   * visit count beyond maxRepeatedState, or a repeated page-state
   * fingerprint, is a loop.
   */
  const visitCounts = new Map<string, number>([[loopKey(startUrl), 1]]);
  /** Navigation attempts per URL (route-guard loop protection). */
  const navAttempts = new Map<string, number>([[loopKey(startUrl), 1]]);
  const stateFingerprints = new Map<string, number>();
  const trackers: PageTracker[] = [];
  const windowOpenLog = new Set<string>();
  const providersSeen = new Set<string>();
  const debugLog: DebugEntry[] = [];

  let navigationCount = 0;
  let popupCount = 0;
  /** Navigation attribution for the next observed step (click/follow). */
  let pending: { type: HopType; label: string | null } | null = null;
  let pagesAnalyzed = 0;
  let loopDetected = false;
  let timedOut = false;
  let navigationLimitHit = false;
  let blocker: "captcha" | "auth" | null = null;
  let schemeTarget: string | null = null;
  let downloadTarget: { url: string; filename: string | null } | null = null;
  let terminalTitle: string | null = null;
  let terminalIsFinal = false;
  let destinationType: DestinationType | null = null;
  let stopReason = "time budget exhausted while navigation was still ongoing";

  /** Record a navigation observation (dedupes consecutive duplicates). */
  const recordNav = (
    tracker: PageTracker,
    url: string,
    type: HopType,
    label: string | null,
  ): "recorded" | "duplicate" | "loop" | "limit" => {
    if (!isHttpUrl(url)) return "duplicate";
    const last = navs.length ? navs[navs.length - 1] : null;
    if (last && last.url === url) return "duplicate";

    const key = loopKeySafe(url);
    if (last && loopKeySafe(last.url) === key) return "duplicate"; // hash-only change
    if (seenKeys.has(key)) {
      // Revisiting a URL is not automatically a loop: stateful gate flows
      // legitimately re-render the same URL with advanced session state
      // (the identical article URL can host step 1/3, 2/3, 3/3). Only a
      // visit count beyond the hard ceiling is a loop — semantic repeats
      // (same page state) are caught by the fingerprint guard instead.
      const visits = visitCounts.get(key) ?? 1;
      if (visits >= config.maxUrlVisits) {
        loopDetected = true;
        stopReason = `redirect loop detected — ${safeHost(url)} was visited ${visits} times with no forward progress`;
        onEvent("browser", "Redirect loop detected — stopping.");
        return "loop";
      }
      visitCounts.set(key, visits + 1);
      onEvent(
        "browser",
        `Revisiting ${safeHost(url)} — same URL, checking whether the session state advanced…`,
      );
    } else {
      seenKeys.add(key);
      visitCounts.set(key, 1);
    }
    if (navigationCount >= config.maxSteps) {
      navigationLimitHit = true;
      stopReason = `navigation step limit reached (${config.maxSteps} steps)`;
      onEvent("browser", "Navigation step limit reached — stopping.");
      return "limit";
    }
    navigationCount += 1;
    // The page we are leaving is, by definition, an intermediate stage.
    if (last && last.classification === null) last.classification = "intermediate";
    navs.push({
      url,
      at: now(),
      type,
      status: tracker.status.get(url) ?? null,
      inPopup: tracker.isPopup,
      label,
      title: null,
      provider: null,
      classification: null,
    });
    return "recorded";
  };

  const attachPage = (page: Page, isPopup: boolean): PageTracker => {
    const tracker: PageTracker = {
      page,
      id: trackers.length,
      isPopup,
      urls: [],
      flushedCount: 0,
      status: new Map(),
    };
    trackers.push(tracker);

    page.on("framenavigated", (frame) => {
      try {
        if (frame !== page.mainFrame()) return;
        const url = frame.url();
        if (!isHttpUrl(url)) return;
        const last = lastUrlOf(tracker);
        if (last === url) return;
        tracker.urls.push({ url, at: now() });
      } catch {
        /* frame detached mid-navigation */
      }
    });

    // Capture the HTTP status of every main-frame document response,
    // including intermediate 3xx hops of a redirect chain — and sniff
    // relevant fetch/XHR responses for session-generated destinations.
    page.on("response", (resp: Response) => {
      try {
        const req = resp.request();
        const status = resp.status();

        if (req.isNavigationRequest() && resp.frame() === page.mainFrame()) {
          tracker.status.set(resp.url(), status);

          // A document delivered as a file download is a terminal destination.
          if (status < 400) {
            const headers = resp.headers();
            if (
              isDownloadResponse(headers["content-type"], headers["content-disposition"]) &&
              !downloadTarget
            ) {
              downloadTarget = { url: resp.url(), filename: null };
              stopReason = "the flow delivered a file download";
              onEvent("browser", `File download detected → ${safeHost(resp.url())}`);
            }
          }

          if (status >= 300 && status < 400) {
            const location = resp.headers()["location"];
            // A redirect hop never commits a document, so framenavigated
            // never observes it — record the intermediate URL itself here.
            // This response hook is the ONLY place a rapid
            // A → gate(302) → A′ sequence can be captured truthfully.
            // Committed documents (2xx) are deliberately NOT recorded here:
            // the flush loop records them with accurate js/meta/click
            // attribution instead of a generic "browser" label.
            const tailNav = navs.length ? navs[navs.length - 1] : null;
            if (!tailNav || loopKeySafe(tailNav.url) !== loopKeySafe(resp.url())) {
              const pend = pending as { type: HopType; label: string | null } | null;
              recordNav(tracker, resp.url(), pend?.type ?? "browser", pend?.label ?? null);
            }
            if (!location) return;
            const target = resolveRedirectTarget(new URL(resp.url()), location);
            if (!target || !isHttpUrl(target.toString())) return;
            // Only chain HTTP hops that continue from the last known state.
            const last = navs.length ? navs[navs.length - 1] : null;
            if (last && loopKeySafe(last.url) === loopKeySafe(target.toString())) return;
            const outcome = recordNav(tracker, target.toString(), "http", null);
            if (outcome === "recorded") {
              navs[navs.length - 1].status = status;
              onEvent("http", `Following HTTP ${status} redirect → ${target.host}`);
            }
            return;
          }

          // Terminal document of an HTTP redirect chain (it was itself
          // redirected) — record the landing URL as an HTTP hop.
          if (status < 400 && req.redirectedFrom() !== null) {
            const last = navs.length ? navs[navs.length - 1] : null;
            if (last && loopKeySafe(last.url) === loopKeySafe(resp.url())) {
              if (last.status === null) last.status = status;
              return;
            }
            recordNav(tracker, resp.url(), "http", null);
          }
          return;
        }

        // Relevant network observation: fetch/XHR responses that clearly
        // carry the next navigation destination (JSON/text payloads only,
        // size-capped). Assets, analytics and tracking are ignored.
        const resourceType = req.resourceType();
        if (resourceType !== "xhr" && resourceType !== "fetch") return;
        if (status >= 400) return;
        const contentType = resp.headers()["content-type"] ?? "";
        if (!/json|text|html/i.test(contentType)) return;
        void resp
          .body()
          .then((body) => {
            if (body.length > 256 * 1024) return;
            const text = body.toString("utf8");
            const matches = text.match(/https?:\/\/[^\s"'<>\\)\]]+/gi);
            if (!matches) return;
            let kept = 0;
            for (const raw of matches) {
              if (kept >= 3 || networkCandidates.size >= 20) break;
              try {
                const u = new URL(raw);
                if (IGNORE_NETWORK_HOSTS.test(u.hostname)) continue;
                const abs = u.toString();
                if (!networkCandidates.has(abs)) {
                  networkCandidates.set(abs, { url: abs, at: now() });
                  kept += 1;
                }
              } catch {
                /* malformed */
              }
            }
          })
          .catch(() => {});
      } catch {
        /* frame detached mid-navigation */
      }
    });

    // A real file download triggered by the flow is a terminal destination.
    page.on("download", (download) => {
      try {
        if (!downloadTarget) {
          downloadTarget = {
            url: download.url(),
            filename: download.suggestedFilename() ?? null,
          };
          stopReason = "the flow delivered a file download";
          onEvent(
            "browser",
            `File download detected${downloadTarget.filename ? `: ${downloadTarget.filename}` : ""}`,
          );
        }
      } catch {
        /* ignore */
      }
      void download.cancel().catch(() => {});
    });
    return tracker;
  };

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    onEvent("browser", "Opening browser session…");
    browser = await playwright.chromium.launch({
      executablePath,
      headless: true,
      timeout: 15_000,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--no-first-run",
      ],
    });

    // One context for the ENTIRE resolution job: cookies, session storage,
    // history and referrer context live for the whole journey and are
    // destroyed only when the job ends.
    context = await browser.newContext({
      userAgent: USER_AGENT,
      javaScriptEnabled: true,
      ignoreHTTPSErrors: false,
      acceptDownloads: false,
      viewport: { width: 1280, height: 800 },
      serviceWorkers: "block",
    });

    // Capture window.open() targets even when the popup never materializes.
    await context.addInitScript(() => {
      const w = window as unknown as {
        open: unknown;
        __uwOpens: string[];
      };
      w.__uwOpens = [];
      const original = w.open as
        | ((this: unknown, url?: unknown, ...rest: unknown[]) => unknown)
        | undefined;
      (window as unknown as { open: unknown }).open = function (
        this: unknown,
        url?: unknown,
        ...rest: unknown[]
      ) {
        try {
          if (url !== undefined && url !== null) w.__uwOpens.push(String(url));
        } catch {
          /* never break the page */
        }
        return original ? original.call(this, url, ...rest) : null;
      };
    });

    // SSRF guard on EVERY request the browser makes, including redirect hops
    // and subresources. Blocked requests are aborted, never sent.
    await context.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      try {
        const parsed = new URL(requestUrl);
        if (
          parsed.protocol === "about:" ||
          parsed.protocol === "data:" ||
          parsed.protocol === "blob:"
        ) {
          return route.continue();
        }
        await assertUrlSafe(parsed);
        // Redirect-loop guard: navigation that keeps bouncing to the same
        // URL is aborted after the repetition budget — instead of spinning
        // until Chromium's own redirect ceiling. A single revisit is NOT a
        // loop: stateful flows re-render known URLs with new session state.
        if (route.request().isNavigationRequest() && isHttpUrl(requestUrl)) {
          const key = loopKeySafe(requestUrl);
          const last = navs.length ? navs[navs.length - 1] : null;
          const attempts = (navAttempts.get(key) ?? 0) + 1;
          navAttempts.set(key, attempts);
          if (attempts > config.maxUrlVisits && (!last || loopKeySafe(last.url) !== key)) {
            loopDetected = true;
            stopReason = `redirect loop detected — ${safeHost(requestUrl)} cycled ${attempts} times in this session`;
            onEvent("browser", "Redirect loop detected — stopping.");
            return route.abort("blockedbyclient");
          }
        }
        return route.continue();
      } catch {
        return route.abort("blockedbyclient");
      }
    });

    // Popups / new tabs are part of the navigation flow — track them.
    context.on("page", (popup) => {
      if (trackers.some((t) => t.page === popup)) return;
      // The first page (created by context.newPage below) is the main page,
      // not a popup.
      if (trackers.length === 0) {
        attachPage(popup, false);
        return;
      }
      popupCount += 1;
      if (popupCount > config.maxPopups) {
        onEvent("popup", "Popup limit reached — closing extra popup.");
        void popup.close().catch(() => {});
        return;
      }
      onEvent("popup", "New tab / popup detected — following it.");
      attachPage(popup, true);
    });

    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    // The 'page' event may or may not have fired synchronously for this
    // first page; attach exactly once, as the main (non-popup) page.
    const main = trackers.find((t) => t.page === page) ?? attachPage(page, false);

    const providerFor = (url: string | null): ProviderAdapter =>
      url ? detectProvider(url) : GENERIC_PROVIDER;

    const announceProvider = (url: string | null): ProviderAdapter => {
      const provider = providerFor(url);
      if (!providersSeen.has(provider.id)) {
        providersSeen.add(provider.id);
        onEvent(
          "provider",
          provider.id === "generic"
            ? `Detecting provider: generic (${safeHost(url ?? "")})`
            : `Detecting provider: ${provider.id}`,
        );
      }
      return provider;
    };

    const assembleResult = async (): Promise<BrowserSessionResult> => {
      const httpNavs = navs.filter((n) => isHttpUrl(n.url));
      const deepest = httpNavs.length ? httpNavs[httpNavs.length - 1] : null;
      if (!deepest) {
        throw new BrowserNavigationError("no page could be loaded");
      }
      await assertUrlSafe(new URL(deepest.url));
      if (deepest.classification === null) {
        deepest.classification = terminalIsFinal ? "final" : "intermediate";
      }
      deepest.title = deepest.title ?? terminalTitle;
      if (!destinationType) {
        destinationType =
          (schemeTarget ? classifyDestinationUrl(schemeTarget) : null) ??
          (downloadTarget ? "download" : null) ??
          classifyDestinationUrl(deepest.url) ??
          "website";
      }
      return {
        navs,
        deepestUrl: deepest.url,
        terminalStatus: deepest.status,
        terminalTitle,
        schemeTarget,
        downloadTarget,
        destinationType,
        terminalIsFinal,
        loopDetected,
        timedOut,
        navigationLimitHit,
        blocker,
        discovered: [...discovered.values()].slice(0, 8),
        debugLog,
        stopReason,
        sessionId,
      };
    };

    // ── initial navigation ────────────────────────────────────────
    // The input is the first timeline entry; redirect hops observed during
    // goto() append after it in order.
    navs.push({
      url: startUrl.toString(),
      at: now(),
      type: "browser",
      status: null,
      inPopup: false,
      label: null,
      title: null,
      provider: null,
      classification: null,
    });

    try {
      await page.goto(startUrl.toString(), {
        waitUntil: "domcontentloaded",
        timeout: Math.min(20_000, Math.max(5_000, deadline - Date.now())),
      });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("blockedbyclient") || msg.includes("ERR_BLOCKED_BY_CLIENT")) {
        if (loopDetected) return assembleResult();
        throw new SsrfBlockError("navigation was blocked by SSRF policy");
      }
      if (/ERR_NAME_NOT_RESOLVED|DNS/i.test(msg)) {
        throw new BrowserNavigationError("the hostname could not be resolved");
      }
      if (/ERR_CONNECTION|ERR_TIMED_OUT|Timeout/i.test(msg)) {
        throw new BrowserNavigationError("the destination could not be reached");
      }
      if (/ERR_TOO_MANY_REDIRECTS/i.test(msg)) {
        // Chromium hit its own redirect ceiling — with the hops we already
        // recorded this is a redirect loop (or an over-long chain).
        loopDetected = navs.length > 1;
        navigationLimitHit = !loopDetected;
        stopReason = loopDetected
          ? "redirect loop detected — the chain exceeded the browser's redirect ceiling"
          : "navigation step limit reached (browser redirect ceiling)";
        return assembleResult();
      }
      throw new BrowserNavigationError(msg || "navigation failed");
    }

    await page
      .waitForLoadState("networkidle", { timeout: 5_000 })
      .catch(() => {});

    // Record where the initial navigation actually landed (redirect chain
    // end may differ from the input).
    const landed = lastUrlOf(main);
    if (landed && landed !== startUrl.toString()) {
      const last = navs[navs.length - 1];
      if (loopKeySafe(last.url) !== loopKeySafe(landed)) {
        recordNav(main, landed, "http", null);
      }
    }
    if (landed && main.status.has(landed)) {
      navs[navs.length - 1].status = main.status.get(landed) ?? null;
    }
    // The initial navigation (including its redirect hops) was recorded by
    // the response hook + the block above — mark those tracker entries as
    // flushed so the main loop never re-records them out of order.
    main.flushedCount = main.urls.length;

    /* ---------------- deep resolution loop ----------------------- */

    let focus: PageTracker = main;
    let prevScan: PageScan | null = null;
    let lateWatchUsedFor: string | null = null;
    let gateWaitUsedFor: string | null = null;
    const stopFlag = () =>
      loopDetected ||
      navigationLimitHit ||
      blocker !== null ||
      schemeTarget !== null ||
      downloadTarget !== null;

    const scanFocus = async (): Promise<PageScan | null> => {
      const provider = providerFor(lastUrlOf(focus));
      return focus.page
        .evaluate(scanPageInBrowser, provider.continueWords?.source ?? null)
        .catch(() => null);
    };

    const pollWindowOpens = async (): Promise<void> => {
      for (const t of trackers) {
        const opens = await t.page
          .evaluate(() => {
            const w = window as unknown as { __uwOpens?: string[] };
            return Array.isArray(w.__uwOpens) ? w.__uwOpens.slice() : [];
          })
          .catch(() => [] as string[]);
        for (const raw of opens) {
          if (windowOpenLog.has(raw)) continue;
          windowOpenLog.add(raw);
          if (/^(tg|intent):/i.test(raw)) {
            schemeTarget = raw;
            stopReason = "the navigation flow handed off to an external application link";
            navs.push({
              url: raw,
              at: now(),
              type: "scheme",
              status: null,
              inPopup: t.isPopup,
              label: "window.open",
              title: null,
              provider: null,
              classification: "final",
            });
            onEvent("browser", `External app link invoked: ${raw.slice(0, 80)}`);
          } else if (isHttpUrl(raw)) {
            const outcome = recordNav(t, raw, "browser", "window.open");
            if (outcome === "recorded") {
              onEvent("browser", `window.open → ${safeHost(raw)}`);
              // If the popup actually materialized with this URL, it is
              // already represented — don't switch focus to it later.
              for (const other of trackers) {
                if (other.isPopup && loopKeySafe(lastUrlOf(other) ?? "") === loopKeySafe(raw)) {
                  other.consumed = true;
                }
              }
            }
          }
        }
      }
    };

    /** Follow a page-generated/discovered URL INSIDE the same session. */
    const followInSession = async (
      url: string,
      label: string | null,
      method: HopType,
    ): Promise<boolean> => {
      try {
        await assertUrlSafe(new URL(url));
      } catch {
        return false;
      }
      onEvent("browser", `Following generated URL → ${safeHost(url)}`);
      pending = { type: method, label };
      try {
        await focus.page.evaluate((u: string) => {
          (window as unknown as { location: { assign: (x: string) => void } }).location.assign(u);
        }, url);
      } catch {
        pending = null;
        return false;
      }
      await waitForMovement(focus, config.navSettleMs, deadline, stopFlag);
      await pollWindowOpens();
      return true;
    };

    while (Date.now() < deadline) {
      if (stopFlag()) break;

      // (R) Flush EVERY unrecorded main-frame navigation of the focused
      // page into the chain, in order. Rapid multi-hop sequences
      // (A → gate → A′ with advanced session state) must not collapse into
      // a single observation — each stage is recorded truthfully.
      {
        const pend = pending as { type: HopType; label: string | null } | null;
        let flushedAny = false;
        let loopOrLimit = false;
        for (let i = focus.flushedCount; i < focus.urls.length; i++) {
          const url = focus.urls[i].url;
          const tail = navs.length ? navs[navs.length - 1] : null;
          focus.flushedCount = i + 1;
          if (tail && loopKeySafe(tail.url) === loopKeySafe(url)) continue; // already represented
          const type: HopType =
            pend && !flushedAny
              ? pend.type
              : prevScan?.metaRefresh && urlsMatchLoose(prevScan.metaRefresh.target, url)
                ? "meta"
                : flushedAny
                  ? "browser"
                  : "js";
          const outcome = recordNav(focus, url, type, pend?.label ?? prevScan?.title ?? null);
          if (outcome === "loop" || outcome === "limit") {
            loopOrLimit = true;
            break;
          }
          if (outcome === "recorded") {
            flushedAny = true;
            onEvent(
              type === "meta" ? "html" : "browser",
              `${hopLabel(type)} → ${safeHost(url)}`,
            );
          }
        }
        pending = null;
        if (loopOrLimit) break;
        if (flushedAny) {
          prevScan = null;
          await focus.page
            .waitForLoadState("domcontentloaded", { timeout: 5_000 })
            .catch(() => {});
          await focus.page
            .waitForLoadState("networkidle", { timeout: 3_000 })
            .catch(() => {});
        }
      }

      // 1) A popup may have taken over the flow — follow the newest one.
      const popup = findActivePopup(trackers, focus);
      if (popup) {
        focus = popup;
        prevScan = null;
        const url = lastUrlOf(popup);
        if (url) {
          const outcome = recordNav(popup, url, "popup", null);
          if (outcome === "recorded") onEvent("popup", `Popup navigated → ${safeHost(url)}`);
          if (outcome === "loop" || outcome === "limit") break;
        }
        await focus.page
          .waitForLoadState("domcontentloaded", { timeout: 5_000 })
          .catch(() => {});
        continue;
      }

      // Scan once up front so a first-hop meta refresh is classified
      // correctly (the scan also marks the continue control for later).
      if (!prevScan) {
        prevScan = await scanFocus();
        if (prevScan?.title) {
          terminalTitle = prevScan.title;
          const last = navs[navs.length - 1];
          if (last && !last.title) last.title = prevScan.title;
        }
      }

      // 2) Did the focused page navigate on its own (JS, meta, timer)?
      //    Skip most of the wait when a ready continuation control exists.
      const readyControl = Boolean(
        prevScan?.element &&
          !prevScan.element.disabled &&
          !prevScan.looksLikeCountdown &&
          !prevScan.metaRefresh,
      );
      const moved = await waitForMovement(
        focus,
        readyControl ? 1_500 : config.navSettleMs,
        deadline,
        stopFlag,
      );
      if (stopFlag()) break;
      if (moved) continue; // recorded at the top of the next iteration
      await pollWindowOpens();
      if (stopFlag()) break;

      /* ── 3) The page is stable — inspect before deciding ─────────── */

      const scan = prevScan ?? (await scanFocus());
      prevScan = scan;
      if (!scan) {
        stopReason = "page could not be analyzed (browser evaluation failed)";
        break;
      }
      terminalTitle = scan.title ?? terminalTitle;

      const currentUrl = lastUrlOf(focus) ?? navs[navs.length - 1].url;
      const provider = announceProvider(currentUrl);
      const lastNav = navs[navs.length - 1];
      if (lastNav && loopKeySafe(lastNav.url) === loopKeySafe(currentUrl)) {
        lastNav.provider = provider.id;
        if (!lastNav.title && scan.title) lastNav.title = scan.title;
      }

      pagesAnalyzed += 1;
      if (pagesAnalyzed > config.maxPages) {
        stopReason = `page analysis budget exhausted (${config.maxPages} pages fully analyzed)`;
        onEvent("browser", "Page analysis budget reached — stopping.");
        break;
      }

      collectDiscovered(discovered, scan);

      const dbg: DebugEntry = {
        step: navigationCount,
        url: currentUrl,
        title: scan.title,
        provider: provider.id,
        navigationSource: lastNav?.type ?? "browser",
        httpStatus: trackerStatus(focus, currentUrl),
        candidatesFound: scan.candidates.length + scan.terminalLinks.length,
        nextCandidate: null,
        selectionReason: null,
        classification: "pending",
        classificationReason: "under investigation",
        sessionId,
        elapsedMs: now(),
      };
      debugLog.push(dbg);
      onEvent("browser", `Analyzing page at ${safeHost(currentUrl)}…`);

      // 3a) Terminal destination type reached (Telegram / Discord / file host).
      const dtypeHere = classifyDestinationUrl(currentUrl);
      if (dtypeHere === "telegram" || dtypeHere === "discord" || dtypeHere === "file_host") {
        destinationType = dtypeHere;
        terminalIsFinal = true;
        stopReason = `terminal ${dtypeHere.replace("_", " ")} destination reached — the flow ends here`;
        dbg.classification = "final";
        dbg.classificationReason = stopReason;
        if (lastNav) lastNav.classification = "final";
        onEvent("verifying", "Verifying terminal destination…");
        break;
      }

      // 3b) Blockers.
      if (scan.captcha) {
        blocker = "captcha";
        stopReason = "CAPTCHA / security challenge blocks the continuation step";
        dbg.classification = "intermediate";
        dbg.classificationReason = stopReason;
        onEvent("browser", "CAPTCHA / security challenge detected — cannot continue.");
        break;
      }
      if (scan.authWall && !scan.element) {
        blocker = "auth";
        stopReason = "the continuation step requires authentication";
        dbg.classification = "intermediate";
        dbg.classificationReason = stopReason;
        onEvent("browser", "The destination requires authentication — cannot continue.");
        break;
      }

      // 3c) Semantic loop protection: the same meaningful page state must
      // never be analyzed more than maxRepeatedState times. The fingerprint
      // mixes URL + provider + control state + visible-content sample, so a
      // revisited URL with ADVANCED session state (different page content)
      // is a new state, not a loop.
      const fingerprint = [
        loopKeySafe(currentUrl),
        provider.id,
        scan.element ? "ctl" : "noctl",
        scan.looksLikeCountdown || scan.timerGate ? "cd" : "-",
        scan.pendingControl ? "pending" : "-",
        shortHash(scan.textSample ?? ""),
      ].join("|");
      const repeats = (stateFingerprints.get(fingerprint) ?? 0) + 1;
      stateFingerprints.set(fingerprint, repeats);
      if (repeats > config.maxRepeatedState) {
        loopDetected = true;
        stopReason = "redirect loop detected — the same page state repeated";
        dbg.classification = "intermediate";
        dbg.classificationReason = stopReason;
        onEvent("browser", "Redirect loop detected (repeated page state) — stopping.");
        break;
      }

      // 3d) Continue control: click it like a user (after waiting out a
      // countdown gate when one is present).
      if (scan.element) {
        const clickControl = async (): Promise<"moved" | "stayed"> => {
          const fromUrl = lastUrlOf(focus);
          // Attribute the navigation BEFORE clicking: the response/flush
          // hooks observe the click's navigation asynchronously, so the
          // provenance marker must already be in place when they fire.
          pending = { type: "click", label: scan.element?.text ?? null };
          let clicked = await clickMarkedContinue(focus.page);
          if (!clicked) {
            // Overlay walls can intercept the physical click — retry with a
            // trusted-context DOM click on the same marked control.
            clicked = await clickMarkedContinueJs(focus.page);
          }
          if (!clicked && scan.element?.href && !scan.element.hashOnly) {
            // The control is a plain anchor: follow its exact href inside
            // the SAME session (provenance preserved), no click needed.
            onEvent(
              "browser",
              `Following continuation link in-session → ${safeHost(scan.element.href)}`,
            );
            await followInSession(scan.element.href, scan.element.text, "click");
            if (stopFlag()) return "moved";
            const afterFollow = lastUrlOf(focus);
            if (afterFollow && fromUrl && loopKeySafe(afterFollow) !== loopKeySafe(fromUrl)) {
              return "moved";
            }
            if (findActivePopup(trackers, focus)) return "moved";
            return "stayed";
          }
          if (!clicked) {
            pending = null;
            return "stayed";
          }
          onEvent("browser", `Clicking "${scan.element?.text ?? "Continue"}"…`);
          await waitForMovement(focus, config.navSettleMs, deadline, stopFlag);
          await pollWindowOpens();
          if (stopFlag()) return "moved";
          const after = lastUrlOf(focus);
          if (after && fromUrl && loopKeySafe(after) !== loopKeySafe(fromUrl)) return "moved";
          if (findActivePopup(trackers, focus)) return "moved";
          // Click produced no navigation; maybe a scheme link appeared.
          const afterClick = await scanFocus();
          const scheme = pickSchemeLink(afterClick);
          if (scheme) {
            schemeTarget = scheme;
            stopReason = "the navigation flow handed off to an external application link";
            navs.push({
              url: scheme,
              at: now(),
              type: "scheme",
              status: null,
              inPopup: focus.isPopup,
              label: scan.element?.text ?? null,
              title: null,
              provider: null,
              classification: "final",
            });
            onEvent("browser", `External app link presented: ${scheme.slice(0, 80)}`);
            return "moved";
          }
          // A window.open popup may be the actual continuation (some gate
          // pages preventDefault the href and open the next stage in a new
          // tab). pollWindowOpens above already records those.
          if (findActivePopup(trackers, focus)) return "moved";
          pending = null;
          return "stayed";
        };

        if (scan.element.disabled || scan.looksLikeCountdown) {
          onEvent("waiting", "Countdown gate detected — waiting for the continuation step…");
          const revealed = await waitForContinuation(focus, config.countdownWaitMs, deadline, stopFlag);
          if (stopFlag()) break;
          if (revealed === "navigated") {
            dbg.selectionReason = "page navigated on its own while the countdown elapsed";
            continue;
          }
          if (revealed === "enabled") {
            const outcome = await clickControl();
            if (stopFlag()) break;
            if (outcome === "moved") {
              dbg.nextCandidate = "(continuation control)";
              dbg.selectionReason = "waited out the countdown, then followed the revealed control";
              prevScan = null;
              continue;
            }
            dbg.selectionReason =
              "countdown elapsed and the control was clicked, but it produced no navigation — falling back to page candidates";
          } else {
            dbg.selectionReason =
              "countdown gate never revealed its continuation within the wait budget — falling back to page candidates";
          }
          prevScan = await scanFocus();
        } else {
          // A ready, safe continuation control: verify it does not point
          // back at the current page, then click it like a user.
          const selfPointing =
            scan.element.href &&
            !scan.element.hashOnly &&
            loopKeySafe(scan.element.href) === loopKeySafe(currentUrl);
          if (!selfPointing) {
            const outcome = await clickControl();
            if (stopFlag()) break;
            if (outcome === "moved") {
              dbg.nextCandidate = scan.element.href;
              dbg.selectionReason = `followed the visible "${scan.element.text}" continuation control`;
              prevScan = null;
              continue;
            }
            dbg.selectionReason = `the "${scan.element.text}" control produced no navigation — inspecting page candidates`;
            prevScan = await scanFocus();
          }
        }
      }

      // 3e) Terminal links exposed by the page (Telegram / Discord / ...).
      const terminalCandidate = (prevScan?.terminalLinks ?? []).find((t) => {
        if (/^https?:\/\//i.test(t.url)) return !seenKeys.has(loopKeySafe(t.url));
        return true; // scheme links are terminal by definition
      });
      if (terminalCandidate) {
        if (/^https?:\/\//i.test(terminalCandidate.url)) {
          dbg.nextCandidate = terminalCandidate.url;
          dbg.selectionReason = `page exposes a ${terminalCandidate.dtype} destination link`;
          onEvent("discovery", `Extracting destination (${terminalCandidate.dtype})…`);
          await followInSession(terminalCandidate.url, terminalCandidate.dtype, "generated");
          if (stopFlag()) break;
          prevScan = null;
          continue;
        }
        schemeTarget = terminalCandidate.url;
        destinationType = terminalCandidate.dtype;
        terminalIsFinal = true;
        stopReason = `the page presented a ${terminalCandidate.dtype} link as its destination`;
        dbg.classification = "final";
        dbg.classificationReason = stopReason;
        navs.push({
          url: terminalCandidate.url,
          at: now(),
          type: "scheme",
          status: null,
          inPopup: focus.isPopup,
          label: terminalCandidate.dtype,
          title: null,
          provider: null,
          classification: "final",
        });
        break;
      }

      // 3f) Ranked page candidates (generated URLs, DOM links, forms) —
      // followed in the SAME session, exact URL, never reconstructed.
      const candidate = (prevScan?.candidates ?? []).find(
        (c) => !seenKeys.has(loopKeySafe(c.url)),
      );
      if (candidate) {
        dbg.nextCandidate = candidate.url;
        dbg.selectionReason = `highest-ranked ${candidate.method} candidate on the page (score ${candidate.score})`;
        onEvent("discovery", `Extracting destination from page (${candidate.method})…`);
        await followInSession(candidate.url, candidate.label, "generated");
        if (stopFlag()) break;
        prevScan = null;
        continue;
      }

      // 3g) Network-observed candidates (fetch/XHR payloads carrying the
      // next destination).
      const networkCandidate = [...networkCandidates.values()].find(
        (c) => !seenKeys.has(loopKeySafe(c.url)),
      );
      if (networkCandidate) {
        dbg.nextCandidate = networkCandidate.url;
        dbg.selectionReason = "a page network response contained this destination";
        onEvent("discovery", "Extracting destination from a network response…");
        await followInSession(networkCandidate.url, "network response", "generated");
        if (stopFlag()) break;
        prevScan = null;
        continue;
      }

      // 3h) DEEP INVESTIGATION — the critical rule:
      //
      //     known multi-stage provider  +  no visible continuation
      //         ≠  STOP
      //         =  DEEP INVESTIGATION REQUIRED
      //
      // A hidden/timer-gated continuation control, a gate-like provider or
      // countdown semantics all mean "keep investigating": wait
      // (event-driven, MutationObserver) for the page's own gate logic to
      // REVEAL the continuation. "No button right now" is not
      // "no destination".
      const gateSuspected =
        provider.gateLike ||
        scan.pendingControl !== null ||
        scan.timerGate ||
        scan.looksLikeCountdown;
      if (gateSuspected && gateWaitUsedFor !== fingerprint) {
        const remaining = Math.min(config.gateWaitMs, deadline - Date.now() - 1_500);
        if (remaining > 2_000) {
          gateWaitUsedFor = fingerprint;
          dbg.classification = "under_investigation";
          dbg.classificationReason = scan.pendingControl
            ? `hidden continuation control present ("${scan.pendingControl.text}") — waiting for the page gate to reveal it`
            : provider.gateLike
              ? `known multi-stage provider (${provider.id}) — watching for a timer/state-gated continuation`
              : "timer/state gate detected — watching for a gated continuation";
          onEvent(
            "waiting",
            scan.pendingControl
              ? `Hidden continuation control detected ("${scan.pendingControl.text}") — waiting for the gate to reveal it…`
              : "Gate-like page — deep investigation, watching for the continuation step…",
          );
          const revealed = await focus.page
            .evaluate(waitForRevealedControl, remaining)
            .catch(() => false);
          await pollWindowOpens();
          if (stopFlag()) break;
          if (lastUrlOf(focus) !== currentUrl) {
            prevScan = null;
            continue; // the page navigated on its own during the gate wait
          }
          if (revealed) {
            dbg.nextCandidate = "(revealed continuation control)";
            dbg.selectionReason =
              "the page gate revealed its continuation control during deep investigation — re-analyzing";
            prevScan = null;
            continue;
          }
          dbg.classificationReason = `deep investigation exhausted — no continuation appeared within the ${Math.round(remaining / 1000)}s gate-wait budget`;
        }
      }

      // 3i) Last-chance watch: the continuation may be injected late by
      // client-side logic. Event-driven (MutationObserver), no blind sleep.
      if (
        lateWatchUsedFor !== fingerprint &&
        gateWaitUsedFor !== fingerprint &&
        Date.now() + 1_500 < deadline
      ) {
        lateWatchUsedFor = fingerprint;
        onEvent("waiting", "Checking page state — watching for late continuation…");
        const remaining = Math.min(config.lateControlWaitMs, deadline - Date.now() - 500);
        const appeared = await focus.page
          .evaluate(watchForLateControl, remaining)
          .catch(() => false);
        await pollWindowOpens();
        if (stopFlag()) break;
        if (lastUrlOf(focus) !== currentUrl) {
          prevScan = null;
          continue; // the page navigated during the watch
        }
        if (appeared) {
          dbg.selectionReason = "a continuation control appeared late — re-analyzing the page";
          prevScan = null;
          continue;
        }
      }

      // 3j) Nothing left. A page on a KNOWN multi-stage provider is still
      // not the answer — investigation was exhausted, report precisely why.
      if (provider.gateLike) {
        terminalIsFinal = false;
        stopReason =
          `known multi-stage provider (${provider.id}): no continuation ever appeared — ` +
          "no revealed control, generated URL, network destination or popup was observed " +
          "within the investigation budget";
        dbg.classification = "intermediate";
        dbg.classificationReason = stopReason;
        onEvent(
          "browser",
          "Investigation exhausted on a multi-stage provider page — reporting honestly.",
        );
        break;
      }

      // Navigation has genuinely terminated here.
      terminalIsFinal = true;
      stopReason =
        "navigation terminated — no further redirect, continuation control or generated destination exists";
      dbg.classification = "final";
      dbg.classificationReason = stopReason;
      onEvent("verifying", "Verifying destination…");
      break;
    }

    if (Date.now() >= deadline && !stopFlag() && !terminalIsFinal) timedOut = true;
    return assembleResult();
  } finally {
    // The resolution job has ended — only NOW is all state destroyed:
    // context first (cookies/storage/cache/history), then the browser.
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

/** Convert session observations into the public redirect-chain hops. */
export function sessionHops(navs: SessionNav[]): RedirectHop[] {
  const hops: RedirectHop[] = [];
  for (let i = 1; i < navs.length; i++) {
    const prev = navs[i - 1];
    const nav = navs[i];
    hops.push({
      step: hops.length + 1,
      sourceUrl: prev.url,
      destinationUrl: nav.url,
      status: nav.status,
      redirectType: nav.type,
      responseTime: Math.max(0, nav.at - prev.at),
      at: nav.at,
      label: nav.label,
      inPopup: nav.inPopup,
      title: nav.title,
      provider: nav.provider,
      classification: nav.classification,
    });
  }
  return hops;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const IGNORE_NETWORK_HOSTS =
  /(^|\.)(doubleclick\.net|googlesyndication\.com|google-analytics\.com|googletagmanager\.com|adservice\.google\.[a-z.]+|googleapis\.com|gstatic\.com|cloudflare\.com|jsdelivr\.net|cloudfront\.net|unpkg\.com|cdnjs\.cloudflare\.com|jquery\.com|fontawesome\.com|gravatar\.com|wp\.com|w\.org)$/i;

function loopKeySafe(raw: string): string {
  try {
    return loopKey(new URL(raw));
  } catch {
    return raw;
  }
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return raw.slice(0, 60);
  }
}

/** Tiny string hash for page-state fingerprints. */
function shortHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function urlsMatchLoose(a: string, b: string): boolean {
  return loopKeySafe(a) === loopKeySafe(b);
}

function hopLabel(type: HopType): string {
  switch (type) {
    case "meta":
      return "Meta refresh";
    case "js":
      return "Script navigation";
    case "click":
      return "User navigation";
    case "popup":
      return "New tab";
    case "generated":
      return "Following generated URL";
    case "http":
      return "HTTP redirect";
    default:
      return "Browser navigation";
  }
}

function trackerStatus(tracker: PageTracker, url: string): number | null {
  return tracker.status.get(url) ?? null;
}

function pickSchemeLink(scan: PageScan | null): string | null {
  if (!scan) return null;
  return scan.schemeLinks.find((s) => /^(tg|intent):/i.test(s)) ?? null;
}

/** The newest popup that already has a real document URL. */
function findActivePopup(trackers: PageTracker[], focus: PageTracker): PageTracker | null {
  for (let i = trackers.length - 1; i >= 0; i--) {
    const t = trackers[i];
    if (!t.isPopup || t === focus || t.consumed) continue;
    const url = lastUrlOf(t);
    if (url && isHttpUrl(url)) return t;
  }
  return null;
}

function collectDiscovered(
  discovered: Map<string, DiscoveredLink>,
  scan: PageScan,
): void {
  for (const link of scan.links) {
    try {
      const u = new URL(link.url);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      if (!discovered.has(u.toString())) {
        discovered.set(u.toString(), {
          url: u.toString(),
          label: link.label,
          kind: "continue_button",
          relevance: 70,
          reason: "Surfaced as a visible continuation control on the page.",
        });
      }
    } catch {
      /* ignore malformed href */
    }
  }
  for (const candidate of scan.candidates) {
    if (discovered.has(candidate.url)) continue;
    discovered.set(candidate.url, {
      url: candidate.url,
      label: candidate.label,
      kind: candidate.method === "GENERATED_URL" ? "generated_url" : "page_link",
      relevance: Math.min(80, candidate.score),
      reason:
        candidate.method === "GENERATED_URL"
          ? "Generated by the page's client-side logic for this session."
          : "Surfaced as a navigation-relevant link on the page.",
    });
  }
}

/**
 * Wait until the page's main-frame URL moves away from its current value.
 * Returns true when it moved within the window.
 */
async function waitForMovement(
  tracker: PageTracker,
  maxMs: number,
  deadline: number,
  shouldStop: () => boolean = () => false,
): Promise<boolean> {
  const fromUrl = lastUrlOf(tracker);
  const until = Math.min(Date.now() + maxMs, deadline);
  let lastSeen = fromUrl;
  let stableSince = Date.now();
  while (Date.now() < until) {
    if (shouldStop()) return false;
    await tracker.page.waitForTimeout(300);
    const current = lastUrlOf(tracker);
    if (current !== fromUrl && current !== null) {
      if (current === lastSeen && Date.now() - stableSince > 600) return true;
      if (current !== lastSeen) {
        lastSeen = current;
        stableSince = Date.now();
      }
    }
  }
  const end = lastUrlOf(tracker);
  return end !== null && end !== fromUrl;
}

async function waitForContinuation(
  tracker: PageTracker,
  maxMs: number,
  deadline: number,
  shouldStop: () => boolean = () => false,
): Promise<"navigated" | "enabled" | "timeout"> {
  const fromUrl = lastUrlOf(tracker);
  const until = Math.min(Date.now() + maxMs, deadline);
  while (Date.now() < until) {
    if (shouldStop()) return "timeout";
    await tracker.page.waitForTimeout(500);
    if (lastUrlOf(tracker) !== fromUrl) return "navigated";
    const state = await tracker.page
      .evaluate(() => {
        let el: any = document.querySelector("[data-uw-continue-target]");
        if (!el) {
          // The DOM may have re-rendered; rescan for a fresh control.
          const WORDS =
            /\b(continue|proceed|next|get\s+link|generate\s+link|open\s+link|skip\s+ad|click\s+here|unlock(\s+link)?)\b/i;
          const FORBIDDEN =
            /\b(log\s*in|sign\s*in|sign\s*up|subscribe|pay|download|install|allow|accept|agree)\b/i;
          for (const cand of Array.from(
            document.querySelectorAll("a,button,[role='button']"),
          ) as any[]) {
            const t = String(cand.innerText || "").trim();
            if (t && t.length <= 80 && WORDS.test(t) && !FORBIDDEN.test(t)) {
              const r = cand.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) {
                cand.setAttribute("data-uw-continue-target", "1");
                el = cand;
                break;
              }
            }
          }
        }
        if (!el) return { found: false, enabled: false };
        const disabled =
          el.disabled === true ||
          el.getAttribute("aria-disabled") === "true" ||
          el.classList.contains("disabled") ||
          (el.tagName === "A" && !el.href);
        return { found: true, enabled: !disabled };
      })
      .catch(() => null);
    if (state?.found && state.enabled) return "enabled";
  }
  return "timeout";
}

async function clickMarkedContinue(page: Page): Promise<boolean> {
  try {
    const el = await page.$(`[${MARK_ATTR}]`);
    if (!el) return false;
    await el.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
    await el.click({ timeout: 4_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * DOM-level click on the marked continuation control. Used when a physical
 * click is intercepted by an overlay wall — the element's own onclick
 * handlers still run, so window.open / location flows trigger normally.
 */
async function clickMarkedContinueJs(page: Page): Promise<boolean> {
  try {
    return await page.evaluate((attr: string) => {
      const el = document.querySelector(`[${attr}]`) as any;
      if (!el) return false;
      try {
        el.scrollIntoView({ block: "center" });
      } catch {
        /* ignore */
      }
      el.click();
      return true;
    }, MARK_ATTR);
  } catch {
    return false;
  }
}
