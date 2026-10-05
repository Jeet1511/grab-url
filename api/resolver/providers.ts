/**
 * Provider Registry.
 *
 * Every meaningful navigation is attributed to a provider. Provider adapters
 * carry pluggable, provider-specific knowledge: extra continuation-control
 * vocabulary, and whether pages on the provider are part of a multi-stage
 * redirect flow ("gate-like") and therefore must never be auto-declared the
 * final destination.
 *
 * The chain may cross domains repeatedly — detection runs after EVERY
 * navigation, and the generic adapter is the fallback for unknown hosts.
 */

export interface ProviderAdapter {
  id: string;
  /** Hostname match (exact or any subdomain). */
  matches(hostname: string): boolean;
  /**
   * Extra continue-button vocabulary for this provider, merged with the
   * generic patterns inside the in-page scan.
   */
  continueWords: RegExp | null;
  /**
   * True when this provider hosts intermediate redirect-flow pages
   * (countdown gates, article interstitials, link generators). A gate-like
   * page reached through a chain is classified INTERMEDIATE unless the flow
   * conclusively terminates there — it is never auto-verified as final.
   */
  gateLike: boolean;
  /** Human-readable note used in the debug log. */
  note: string;
}

function hostMatcher(...domains: string[]): (hostname: string) => boolean {
  return (hostname: string) => {
    const h = hostname.toLowerCase();
    return domains.some((d) => h === d || h.endsWith(`.${d}`));
  };
}

/** Providers are checked in order; the first match wins. */
const PROVIDERS: ProviderAdapter[] = [
  {
    id: "vplink",
    matches: hostMatcher("vplink.in", "vplink.io", "vplinks.in"),
    continueWords: /\b(get\s+link|generate\s+link|continue\s+to\s+link)\b/i,
    gateLike: true,
    note: "shortlink gate — destination is generated after a waiting stage",
  },
  {
    id: "techmint",
    matches: hostMatcher("techmint.in", "techmint.in"),
    continueWords:
      /\b(get\s+link|generate\s+link|open\s+link|continue\s+to\s+(the\s+)?(link|destination)|unlock\s+link|click\s+here\s+to\s+(continue|proceed)|proceed\s+to\s+link)\b/i,
    gateLike: true,
    note: "article interstitial — continuation appears after client-side logic / countdown",
  },
  {
    id: "telegram",
    matches: hostMatcher("t.me", "telegram.me", "telegram.dog"),
    continueWords: null,
    gateLike: false,
    note: "terminal messaging destination",
  },
  {
    id: "discord",
    matches: hostMatcher("discord.gg", "discord.com", "discordapp.com"),
    continueWords: null,
    gateLike: false,
    note: "terminal invite destination",
  },
];

export const GENERIC_PROVIDER: ProviderAdapter = {
  id: "generic",
  matches: () => true,
  continueWords: null,
  gateLike: false,
  note: "generic page analysis",
};

/** Identify the provider responsible for a URL. */
export function detectProvider(url: string | URL): ProviderAdapter {
  let hostname: string;
  try {
    hostname = (url instanceof URL ? url : new URL(url)).hostname;
  } catch {
    return GENERIC_PROVIDER;
  }
  for (const provider of PROVIDERS) {
    if (provider.matches(hostname)) return provider;
  }
  return GENERIC_PROVIDER;
}
