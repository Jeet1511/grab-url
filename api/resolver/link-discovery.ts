/**
 * Link Discovery Engine (Level 2 — page analysis).
 *
 * Extracts *navigation-relevant* links from an HTML document without
 * executing JavaScript: anchors, buttons, form actions and onclick /
 * data-attribute navigation. Every candidate is scored for relevance to
 * the redirect flow; ads, social links, menus, footers and trackers are
 * filtered out.
 *
 * Only meaningful candidates survive (relevance threshold + hard cap) —
 * the engine never dumps hundreds of unrelated page links.
 */

import { resolveRedirectTarget } from "./url-validator";

export type DiscoveredKind =
  | "continue_button"
  | "page_link"
  | "form_action"
  | "generated_url"
  | "network_response";

export interface DiscoveredLink {
  /** Absolute, normalized URL. */
  url: string;
  /** Visible label (anchor text, button text, ...) if any. */
  label: string | null;
  kind: DiscoveredKind;
  /** 0..100 — higher means more likely part of the destination flow. */
  relevance: number;
  /** Why this link was surfaced. */
  reason: string;
}

/** Maximum candidates surfaced from a single page. */
const MAX_CANDIDATES = 6;
/** Minimum relevance score to surface a candidate at all. */
const MIN_RELEVANCE = 45;

/** Words that mark a link/button as part of the continuation flow. */
const CONTINUE_WORDS =
  /\b(continue|proceed|next|go to|goto|open|visit|get\s+link|destination|skip(\s+ad)?|click\s+here|allow|confirm|forward|redirect|take me|access)\b/i;

/** Hosts/patterns that are essentially never the destination. */
const IGNORE_HOSTS =
  /(^|\.)(doubleclick\.net|googlesyndication\.com|google-analytics\.com|googletagmanager\.com|adservice\.google\.[a-z.]+|t\.co)$/i;

const IGNORE_PATHS =
  /\/(share|intent|sharer|login|signin|sign-in|signup|register|privacy|terms|imprint|about|contact|advertise|press|careers|legal)(\/|$|\?)/i;

/** Query keys that frequently carry the real destination on gate pages. */
const DEST_PARAM_KEYS = [
  "url",
  "u",
  "target",
  "redirect",
  "redirect_url",
  "redirect_uri",
  "dest",
  "destination",
  "to",
  "next",
  "continue",
  "link",
  "href",
  "out",
  "go",
  "r",
  "redir",
];

interface RawLink {
  rawTarget: string;
  label: string | null;
  kind: DiscoveredKind;
  /** Character offset inside the document (for position scoring). */
  position: number;
}

function stripTags(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAttr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = tag.match(re);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/** Extract onclick="...location...'URL'..." / data-href / data-url targets. */
function navigationAttrTarget(tag: string): string | null {
  for (const name of ["data-href", "data-url", "data-link", "data-target", "data-redirect"]) {
    const v = extractAttr(tag, name);
    if (v && /^(https?:|\/|\.)/i.test(v.trim())) return v;
  }
  const onclick = extractAttr(tag, "onclick");
  if (onclick) {
    const m = onclick.match(
      /(?:window\s*\.\s*)?location(?:\s*\.\s*href)?\s*=\s*(["'])((?:\\.|(?!\1).)*)\1/i,
    ) ?? onclick.match(/location\s*\.\s*(?:assign|replace)\s*\(\s*(["'])((?:\\.|(?!\1).)*)\1\s*\)/i);
    if (m && m[2]) return m[2];
  }
  return null;
}

function collectRawLinks(html: string): RawLink[] {
  const raw: RawLink[] = [];

  // <a href="...">label</a>
  const anchorRe = /<a\b[^>]*>[\s\S]*?<\/a\s*>/gi;
  for (const m of html.matchAll(anchorRe)) {
    const tag = m[0].match(/<a\b[^>]*>/i)?.[0] ?? "";
    const href = extractAttr(tag, "href") ?? navigationAttrTarget(tag);
    if (!href) continue;
    const label = stripTags(m[0].replace(/<a\b[^>]*>/i, "").replace(/<\/a\s*>$/i, ""));
    raw.push({
      rawTarget: href,
      label: label || null,
      kind: "page_link",
      position: m.index ?? 0,
    });
  }

  // <button ...>label</button> with formaction or JS/data navigation
  const buttonRe = /<button\b[^>]*>[\s\S]*?<\/button\s*>/gi;
  for (const m of html.matchAll(buttonRe)) {
    const tag = m[0].match(/<button\b[^>]*>/i)?.[0] ?? "";
    const target = extractAttr(tag, "formaction") ?? navigationAttrTarget(tag);
    const label = stripTags(m[0].replace(/<button\b[^>]*>/i, "").replace(/<\/button\s*>$/i, ""));
    if (target) {
      raw.push({
        rawTarget: target,
        label: label || null,
        kind: "continue_button",
        position: m.index ?? 0,
      });
    } else if (label && CONTINUE_WORDS.test(label)) {
      // Continue button without a static target — its URL will be revealed
      // by script; surface nothing here, the browser worker handles it.
    }
  }

  // <form action="..."> — interstitial gate forms (GET only is followable)
  const formRe = /<form\b[^>]*>/gi;
  for (const m of html.matchAll(formRe)) {
    const action = extractAttr(m[0], "action");
    const methodAttr = (extractAttr(m[0], "method") ?? "get").toLowerCase();
    if (action && methodAttr === "get") {
      raw.push({
        rawTarget: action,
        label: null,
        kind: "form_action",
        position: m.index ?? 0,
      });
    }
  }

  return raw;
}

function scoreLink(link: RawLink, resolved: URL, base: URL, docLength: number): {
  relevance: number;
  reasons: string[];
} {
  let score = 0;
  const reasons: string[] = [];
  const label = link.label ?? "";

  if (CONTINUE_WORDS.test(label)) {
    score += 45;
    reasons.push("labeled as a continuation step");
  }
  if (link.kind === "continue_button") {
    score += 15;
    reasons.push("presented as a button");
  }

  const sameHost =
    resolved.hostname.toLowerCase() === base.hostname.toLowerCase();
  if (!sameHost) {
    score += 30;
    reasons.push("leads off this redirect host");
  } else if (!CONTINUE_WORDS.test(label)) {
    score -= 25; // same-site navigation menu item
  }

  // Links in the first ~60% of the document are more likely to be the
  // primary action than footer/sidebar material.
  if (docLength > 0 && link.position / docLength <= 0.6) score += 10;

  // Destination carried as a query parameter (gate/out pages).
  if (DEST_PARAM_KEYS.some((k) => resolved.searchParams.has(k))) {
    score += 10;
    reasons.push("carries a destination parameter");
  }

  // Penalties: ads, trackers, social, boilerplate paths.
  if (IGNORE_HOSTS.test(resolved.hostname)) score -= 80;
  if (IGNORE_PATHS.test(resolved.pathname)) score -= 35;
  if (/\b(utm_[a-z]+|fbclid|gclid)\b/i.test(resolved.search)) score -= 10;
  if (label.length === 0 && link.kind === "page_link") score -= 5;

  return { relevance: Math.max(0, Math.min(100, score)), reasons };
}

/**
 * Discover navigation-relevant links in an HTML page.
 * Returns at most MAX_CANDIDATES, sorted by relevance (best first).
 */
export function discoverLinks(html: string, base: URL): DiscoveredLink[] {
  const out: DiscoveredLink[] = [];
  const seen = new Set<string>();

  for (const rawLink of collectRawLinks(html)) {
    const target = rawLink.rawTarget.trim();
    if (!target || /^(javascript:|mailto:|tel:|data:|#)/i.test(target)) continue;

    const resolved = resolveRedirectTarget(base, target);
    if (!resolved) continue;
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;

    const key = resolved.toString();
    if (seen.has(key)) continue;
    seen.add(key);

    const { relevance, reasons } = scoreLink(rawLink, resolved, base, html.length);
    if (relevance < MIN_RELEVANCE) continue;

    const label = rawLink.label && rawLink.label.length <= 120 ? rawLink.label : null;
    out.push({
      url: key,
      label,
      kind: rawLink.kind === "page_link" && CONTINUE_WORDS.test(label ?? "")
        ? "continue_button"
        : rawLink.kind,
      relevance,
      reason: reasons.length
        ? `Surfaced because it ${reasons.join(" and ")}.`
        : "Surfaced as a contextually relevant link.",
    });
  }

  out.sort((a, b) => b.relevance - a.relevance);
  return out.slice(0, MAX_CANDIDATES);
}
