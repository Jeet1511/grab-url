/**
 * Static HTML analysis: detect client-side navigation without executing
 * arbitrary JavaScript.
 *
 * Detects:
 *  - <meta http-equiv="refresh" content="0; url=...">   (with delay)
 *  - location.href = "..."      window.location = "..."      location = "..."
 *  - location.assign("...")     location.replace("...")
 *  - base64-encoded destination literals (atob("..."))
 *
 * Only *static string literals* are followed. Dynamic expressions escalate
 * to the isolated browser worker (signalled via `kind: "dynamic"`).
 */

export type HtmlRedirect =
  | { kind: "meta"; target: string; delaySeconds: number }
  | { kind: "js"; target: string }
  | { kind: "none" }
  | { kind: "dynamic" };

const META_REFRESH_TAG = /<meta\b[^>]*\bhttp-equiv\s*=\s*(?:"refresh"|'refresh'|refresh)[^>]*>/i;

function extractAttr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = tag.match(re);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/** Parse `content="5; url=https://..."` → { delaySeconds, target } */
function parseMetaRefresh(html: string): { delaySeconds: number; target: string } | null {
  const tagMatch = html.match(META_REFRESH_TAG);
  if (!tagMatch) return null;
  const content = extractAttr(tagMatch[0], "content");
  if (!content) return null;
  const m = content.match(/^\s*(\d+(?:\.\d+)?)\s*(?:;\s*url\s*=\s*(.+))?$/i);
  if (!m || !m[2]) return null;
  let target = m[2].trim();
  if (
    (target.startsWith('"') && target.endsWith('"')) ||
    (target.startsWith("'") && target.endsWith("'"))
  ) {
    target = target.slice(1, -1).trim();
  }
  if (!target) return null;
  return { delaySeconds: Number(m[1]), target };
}

const STRING = `(["'\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`;

// location.href = "..." | window.location = "..." | location = "..."
const JS_ASSIGN = new RegExp(
  `(?:window\\s*\\.\\s*)?location(?:\\s*\\.\\s*href)?\\s*=\\s*${STRING}`,
  "i",
);
// location.assign("...") / location.replace("...")
const JS_CALL = new RegExp(
  `(?:window\\s*\\.\\s*)?location\\s*\\.\\s*(?:assign|replace)\\s*\\(\\s*${STRING}\\s*\\)`,
  "i",
);
// Any location-ish reference with a dynamic (non-literal) assignment.
const JS_DYNAMIC =
  /(?:window\s*\.\s*)?location(?:\s*\.\s*(?:href|assign|replace))?\s*(?:=|\()/i;

function unescapeJsString(raw: string): string {
  return raw
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\\(.)/g, "$1");
}

/**
 * Analyze an HTML document for client-side navigation.
 * Meta refresh wins over JS when both are present (it is what a browser
 * honors first for delay=0).
 */
export function analyzeHtml(html: string): HtmlRedirect {
  const meta = parseMetaRefresh(html);
  if (meta) return { kind: "meta", target: meta.target, delaySeconds: meta.delaySeconds };

  const call = html.match(JS_CALL);
  if (call && call[2] !== undefined) {
    return { kind: "js", target: unescapeJsString(call[2]) };
  }

  const assign = html.match(JS_ASSIGN);
  if (assign && assign[2] !== undefined) {
    return { kind: "js", target: unescapeJsString(assign[2]) };
  }

  // JavaScript navigation exists but the target is computed — only a real
  // browser can determine it.
  const scriptBlocks = html.match(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi) ?? [];
  for (const block of scriptBlocks) {
    if (JS_DYNAMIC.test(block)) return { kind: "dynamic" };
  }

  return { kind: "none" };
}

/* ------------------------------------------------------------------ */
/* Encoded-destination extraction (used by the last-resort resolver)   */
/* ------------------------------------------------------------------ */

/** atob("...") / window.atob('...') string literals. */
const ATOB_CALL = /\batob\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*\)/g;

/** Bare long base64(ish) string literals inside scripts. */
const B64_LITERAL = /(["'`])([A-Za-z0-9+/=_-]{24,})\1/g;

function tryBase64Decode(raw: string): string | null {
  try {
    let s = raw.trim();
    // URL-safe alphabet → standard alphabet
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4 !== 0) s += "=";
    const decoded = Buffer.from(s, "base64").toString("utf8");
    // Must be mostly printable to be a plausible URL payload.
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Extract http(s) URLs hidden in a page as encoded payloads
 * (atob literals, long base64 strings). Read-only static analysis —
 * nothing is executed. Returns deduplicated URL strings.
 */
export function extractEncodedTargets(html: string): string[] {
  const found = new Set<string>();

  const consider = (decoded: string | null): void => {
    if (!decoded) return;
    // The payload may itself be percent-encoded or wrapped in quotes.
    const candidates = [decoded.trim()];
    try {
      candidates.push(decodeURIComponent(decoded.trim()));
    } catch {
      /* not encoded */
    }
    for (const c of candidates) {
      const m = c.match(/https?:\/\/[^\s"'`<>\\]+/i);
      if (m) found.add(m[0]);
    }
  };

  for (const m of html.matchAll(ATOB_CALL)) {
    consider(tryBase64Decode(m[2]));
  }
  const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi) ?? [];
  for (const block of scripts) {
    for (const m of block.matchAll(B64_LITERAL)) {
      consider(tryBase64Decode(m[2]));
    }
  }

  return [...found].slice(0, 8);
}

/**
 * Extract a destination carried in a URL's own query string
 * (…?url=…, ?u=aHR0cHM…, ?redirect=…). Common on shortener gate pages.
 */
export function extractDestinationFromParams(url: URL): string[] {
  const KEYS = [
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
    "redir",
    "r",
  ];
  const found = new Set<string>();

  for (const key of KEYS) {
    const value = url.searchParams.get(key);
    if (!value || value.length < 4) continue;

    const candidates: string[] = [value];
    const decoded = tryBase64Decode(value);
    if (decoded) candidates.push(decoded);

    for (const c of candidates) {
      const trimmed = c.trim().replace(/^["']|["']$/g, "");
      if (/^https?:\/\//i.test(trimmed)) {
        try {
          const parsed = new URL(trimmed);
          // Never "extract" a URL that points back at the same gate page.
          if (parsed.toString() !== url.toString()) found.add(trimmed);
        } catch {
          /* not a URL */
        }
      }
    }
  }

  return [...found].slice(0, 4);
}
