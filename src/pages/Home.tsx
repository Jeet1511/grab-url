import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ResolutionEvent, UnwrapResponse } from "@contracts/unwrap";
import {
  BLOCKER_LABEL,
  DESTINATION_TYPE_LABEL,
  PHASE_LABEL,
  SOURCE_LABEL,
  STATUS_META,
  unwrapUrl,
  unwrapUrlStreaming,
} from "@/lib/unwrap";
import { ConfidenceBadge, RedirectTimeline } from "@/components/RedirectTimeline";

const EXAMPLES = [
  { label: "http://httpbin.org/redirect/2", url: "http://httpbin.org/redirect/2" },
  { label: "https://example.com", url: "https://example.com" },
  { label: "https://en.wikipedia.org/wiki/URL_shortening", url: "https://en.wikipedia.org/wiki/URL_shortening" },
];

/** Friendly, truthful state line derived from the real progress phase. */
function stateLine(events: ResolutionEvent[]): string {
  if (events.length === 0) return "Opening browser";
  const last = events[events.length - 1];
  switch (last.phase) {
    case "validating":
      return "Validating URL";
    case "http":
      return "Following redirect";
    case "html":
      return "Analyzing page";
    case "browser":
      if (/following generated url/i.test(last.message)) return "Following generated URL";
      if (/clicking/i.test(last.message)) return "Following continuation";
      return events.some((e) => e.phase === "http" || e.phase === "popup")
        ? "Analyzing page"
        : "Opening browser";
    case "waiting":
      return "Checking page state";
    case "popup":
      return "New tab detected";
    case "discovery":
      return "Extracting destination";
    case "provider":
      return "Detecting provider";
    case "last_resort":
      return "Deep analysis";
    case "verifying":
      return "Verifying destination";
    case "done":
      return "Final destination found";
    default:
      return "Resolving";
  }
}

function useElapsedMs(active: boolean): number {
  const [ms, setMs] = useState(0);
  const startRef = useRef(0);
  useEffect(() => {
    if (!active) return;
    startRef.current = performance.now();
    setMs(0);
    const id = window.setInterval(() => {
      setMs(performance.now() - startRef.current);
    }, 113);
    return () => window.clearInterval(id);
  }, [active]);
  return ms;
}

const toneColor = (tone: "ok" | "warn" | "err" | "dim"): string =>
  tone === "ok"
    ? "var(--aqua)"
    : tone === "warn"
      ? "var(--amber)"
      : tone === "err"
        ? "var(--red)"
        : "var(--muted)";

function domainOf(url: string | null): string {
  if (!url) return "—";
  try {
    return new URL(url).host;
  } catch {
    // external scheme (tg://…) — show the scheme
    const m = url.match(/^([a-z][a-z0-9+.-]*):/i);
    return m ? `${m[1]}:` : "—";
  }
}

export default function Home() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ResolutionEvent[]>([]);
  const [result, setResult] = useState<UnwrapResponse | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [debug, setDebug] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const chainRef = useRef<HTMLElement>(null);
  const elapsed = useElapsedMs(loading);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [progress]);

  const submit = useCallback(
    async (raw?: string) => {
      const url = (raw ?? input).trim();
      if (!url || loading) return;
      if (raw !== undefined) setInput(raw);
      setLoading(true);
      setResult(null);
      setFatalError(null);
      setCopied(false);
      setChainOpen(false);
      setLogOpen(false);
      setProgress([]);
      try {
        try {
          setResult(
            await unwrapUrlStreaming(
              url,
              (event) => setProgress((prev) => [...prev.slice(-60), event]),
              debug,
            ),
          );
        } catch {
          // Streaming unavailable/interrupted — plain request/response still works.
          setResult(await unwrapUrl(url, debug));
        }
      } catch (err) {
        setFatalError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [input, loading, debug],
  );

  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setInput(text.trim());
    } catch {
      // Clipboard permission denied — the user can paste manually.
    }
  }, []);

  const clearAll = useCallback(() => {
    setInput("");
    setResult(null);
    setFatalError(null);
    setProgress([]);
    setChainOpen(false);
    setLogOpen(false);
  }, []);

  const copyFinal = useCallback(async () => {
    if (!result?.finalUrl) return;
    try {
      await navigator.clipboard.writeText(result.finalUrl);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = result.finalUrl;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }, [result]);

  const meta = result ? STATUS_META[result.status] : null;
  const displayEvents = result?.events?.length ? result.events : progress;
  const currentState = useMemo(() => stateLine(progress), [progress]);

  return (
    <div className="min-h-screen flex flex-col">
      {/* ── header ─────────────────────────────────────────── */}
      <header className="border-b border-line">
        <div className="max-w-[920px] mx-auto px-5 h-12 flex items-center justify-between border-x border-line">
          <div className="text-strong font-semibold tracking-tight text-[13px]">
            <span className="text-aqua">XENO</span>&nbsp;DEEPLINK RESOLVER
          </div>
          <div className="hidden sm:flex items-center gap-2 text-[11px] text-dim">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--aqua)]" />
            REAL BROWSER · SERVER-SIDE
          </div>
        </div>
      </header>

      {/* ── main ───────────────────────────────────────────── */}
      <main className="flex-1">
        <div className="max-w-[920px] mx-auto border-x border-line min-h-full">
          {/* intro */}
          <section className="px-5 pt-14 pb-10 border-b border-line">
            <p className="text-[11px] text-aqua tracking-widest mb-4">
              PASTE URL → ONE PERSISTENT BROWSER SESSION → VERIFIED DESTINATION
            </p>
            <h1 className="text-strong text-2xl sm:text-[34px] leading-tight font-semibold tracking-tight max-w-[660px]">
              Where does that link
              <br />
              actually go?
            </h1>
            <p className="text-dim text-[12px] mt-4 max-w-[580px]">
              Every resolution runs in ONE persistent browser session on the
              server. The resolver follows HTTP redirects, meta refreshes and
              JavaScript navigation, waits out countdown gates, clicks
              continue/proceed steps, follows session-generated URLs across
              providers and new tabs — and keeps going until the journey
              genuinely ends. A 200 OK page is never mistaken for the answer:
              intermediate pages are labeled as such, and only a verified
              terminal destination gets the glow. The session lives for the
              whole journey and is destroyed when the job ends.
            </p>
          </section>

          {/* input */}
          <section className="border-b border-line">
            <div className="px-5 py-3 text-[11px] text-dim border-b border-line">
              01 / INPUT URL
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <div className="flex flex-col sm:flex-row">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="https://bit.ly/…"
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="off"
                  className="flex-1 bg-transparent px-5 py-5 text-[15px] text-strong placeholder:text-[#444] outline-none focus:bg-[#131313] min-w-0"
                />
                <div className="flex border-t sm:border-t-0 sm:border-l border-line">
                  <button
                    type="button"
                    onClick={() => void pasteFromClipboard()}
                    disabled={loading}
                    className="px-5 py-4 sm:py-5 text-[12px] text-[#999] hover:text-aqua transition-colors disabled:opacity-30 border-r border-line"
                  >
                    PASTE
                  </button>
                  <button
                    type="submit"
                    disabled={loading || !input.trim()}
                    className="flex-1 sm:w-52 px-5 py-4 sm:py-5 text-left text-[13px] font-semibold tracking-wide text-aqua hover:bg-[var(--aqua)] hover:text-[#111] transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-aqua"
                  >
                    {loading ? "RESOLVING…" : "UNWRAP →"}
                  </button>
                </div>
              </div>
              <div className="px-5 py-3 border-t border-line flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
                <button
                  type="button"
                  onClick={clearAll}
                  disabled={loading && !result}
                  className="text-[#999] hover:text-[var(--red)] transition-colors disabled:opacity-30"
                >
                  CLEAR ✕
                </button>
                <label className="flex items-center gap-1.5 text-[#999] cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={debug}
                    onChange={(e) => setDebug(e.target.checked)}
                    disabled={loading}
                    className="accent-[#5df2d6]"
                  />
                  DEBUG MODE
                </label>
                <span className="text-dim">TRY:</span>
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex.url}
                    type="button"
                    onClick={() => void submit(ex.url)}
                    className="text-[#999] hover:text-aqua underline decoration-[#333] underline-offset-4 hover:decoration-[var(--aqua)] transition-colors"
                  >
                    {ex.label}
                  </button>
                ))}
              </div>
            </form>
          </section>

          {/* live progress */}
          {loading && (
            <section className="border-b border-line px-5 py-6">
              <div className="text-[12px] text-strong mb-1 flex items-center gap-3 flex-wrap">
                <span className="inline-block w-2 h-2 bg-[var(--aqua)] animate-pulse" />
                {currentState}
                <span className="cursor-blink text-aqua">▌</span>
                <span className="text-dim font-normal text-[11px]">
                  {(elapsed / 1000).toFixed(1)}s
                </span>
              </div>
              <div className="text-[10px] text-dim mb-3">
                Observing a real browser session — truthful progress, no
                simulated stages.
              </div>
              <div
                ref={logRef}
                className="max-h-44 overflow-y-auto space-y-1.5 pr-2"
              >
                {progress.length === 0 && (
                  <div className="text-[11px] text-dim">Connecting…</div>
                )}
                {progress.map((event, i) => (
                  <div key={i} className="flex gap-3 text-[11px] leading-relaxed">
                    <span className="text-[#555] shrink-0 w-14 text-right">
                      {(event.ts / 1000).toFixed(1)}s
                    </span>
                    <span className="text-aqua shrink-0 w-32">
                      {PHASE_LABEL[event.phase] ?? event.phase}
                    </span>
                    <span className="text-dim break-all">{event.message}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* fatal transport error */}
          {!loading && fatalError && (
            <section className="border-b border-line px-5 py-6">
              <div className="text-[12px] text-[var(--red)]">REQUEST FAILED</div>
              <p className="text-[12px] text-dim mt-1">{fatalError}</p>
            </section>
          )}

          {/* result */}
          {!loading && result && meta && (
            <>
              <section className="border-b border-line">
                <div className="px-5 py-3 text-[11px] text-dim border-b border-line flex items-center justify-between flex-wrap gap-2">
                  <span>02 / FINAL DESTINATION</span>
                  <span className="flex items-center gap-3">
                    {result.confidence && (
                      <ConfidenceBadge confidence={result.confidence} />
                    )}
                    <span
                      className="font-semibold"
                      style={{ color: toneColor(meta.tone) }}
                    >
                      ● {meta.label}
                    </span>
                  </span>
                </div>

                <div className="px-5 py-6">
                  {result.finalUrl ? (
                    <>
                      <div
                        className={
                          result.confidence === "verified"
                            ? "final-glow bg-[var(--panel)] px-4 py-4"
                            : "border border-line bg-[var(--panel)] px-4 py-4"
                        }
                      >
                        {result.confidence === "verified" && (
                          <div className="text-[9px] tracking-[0.2em] text-aqua mb-2">
                            VERIFIED FINAL DESTINATION
                          </div>
                        )}
                        <a
                          href={result.finalUrl}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                          className="text-strong text-[15px] sm:text-[17px] break-all leading-relaxed underline decoration-[#333] underline-offset-4 hover:decoration-[var(--aqua)] hover:text-aqua transition-colors"
                        >
                          {result.finalUrl}
                        </a>
                      </div>
                      {result.destinationType && (
                        <div className="mt-3 text-[10px] tracking-widest text-dim">
                          DESTINATION TYPE:{" "}
                          <span className="text-strong">
                            {DESTINATION_TYPE_LABEL[result.destinationType] ??
                              result.destinationType.toUpperCase()}
                          </span>
                        </div>
                      )}
                      <div className="flex flex-wrap gap-3 mt-5">
                        <button
                          onClick={() => void copyFinal()}
                          className="px-4 py-2.5 text-[12px] font-semibold bg-[var(--aqua)] text-[#111] hover:bg-[#8ff7e3] transition-colors"
                        >
                          {copied ? "COPIED ✓" : "COPY URL"}
                        </button>
                        {/^https?:\/\//i.test(result.finalUrl) && (
                          <a
                            href={result.finalUrl}
                            target="_blank"
                            rel="noopener noreferrer nofollow"
                            className="px-4 py-2.5 text-[12px] border border-line text-[#999] hover:text-aqua hover:border-[var(--aqua)] transition-colors"
                          >
                            OPEN URL ↗
                          </a>
                        )}
                        <button
                          onClick={() => {
                            setChainOpen(true);
                            window.setTimeout(
                              () => chainRef.current?.scrollIntoView({ behavior: "smooth" }),
                              50,
                            );
                          }}
                          className="px-4 py-2.5 text-[12px] border border-line text-[#999] hover:text-aqua hover:border-[var(--aqua)] transition-colors"
                        >
                          VIEW CHAIN ↓
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="text-strong text-[14px]">
                      {result.blocker
                        ? (BLOCKER_LABEL[result.blocker] ?? "RESOLUTION BLOCKED")
                        : "Final destination could not be determined."}
                    </p>
                  )}

                  <p className="text-[12px] text-dim mt-4">{result.message}</p>
                  {result.stopReason && (
                    <p className="text-[10px] text-[#555] mt-1.5">
                      STOP REASON: {result.stopReason}
                    </p>
                  )}

                  {/* verification signals */}
                  {result.verificationSignals.length > 0 && (
                    <div className="mt-4 border border-line">
                      <div className="px-3 py-2 text-[10px] tracking-widest text-dim border-b border-line">
                        VERIFICATION SIGNALS
                      </div>
                      <ul className="px-3 py-2 space-y-1">
                        {result.verificationSignals.map((signal, i) => (
                          <li key={i} className="text-[11px] text-[#999] flex gap-2">
                            <span className="text-aqua">✓</span>
                            <span>{signal}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* diagnostics */}
                  <div className="mt-5 border border-line">
                    <div className="px-3 py-2 text-[10px] tracking-widest text-dim border-b border-line">
                      DIAGNOSTICS
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-6 gap-px bg-[var(--line)]">
                      {[
                        ["STATUS", meta.label],
                        ["NAVIGATIONS", String(result.navigationCount)],
                        ["REDIRECTS", String(result.hops.length)],
                        ["TOTAL TIME", `${(result.totalTime / 1000).toFixed(1)}s`],
                        ["SESSION", result.sessionId ?? "—"],
                        ["FINAL DOMAIN", domainOf(result.finalUrl)],
                      ].map(([k, v]) => (
                        <div key={k} className="bg-[var(--bg)] px-3 py-3 min-w-0">
                          <div className="text-[9px] tracking-widest text-dim">{k}</div>
                          <div className="text-[12px] text-strong mt-1 truncate" title={v}>
                            {v}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              {/* redirect chain */}
              {(result.hops.length > 0 || result.inputUrl) && (
                <section ref={chainRef} className="border-b border-line">
                  <button
                    onClick={() => setChainOpen((v) => !v)}
                    className="w-full px-5 py-3 text-left text-[11px] text-dim hover:text-strong transition-colors flex items-center justify-between"
                  >
                    <span>
                      03 / REDIRECT CHAIN — {result.hops.length + 1} URL
                      {result.hops.length === 0 ? "" : "S"} OBSERVED
                    </span>
                    <span>{chainOpen ? "−" : "+"}</span>
                  </button>
                  {chainOpen && (
                    <div className="px-5 pb-7 pt-3">
                      <RedirectTimeline
                        inputUrl={result.inputUrl}
                        hops={result.hops}
                        finalUrl={result.finalUrl}
                        finalConfidence={result.confidence}
                        destinationType={result.destinationType}
                        candidates={result.candidates}
                      />
                    </div>
                  )}
                </section>
              )}

              {/* discovery mode: meaningful candidates */}
              {result.candidates.filter((c) => c.confidence !== "intermediate").length >
                0 && (
                <section className="border-b border-line">
                  <div className="px-5 py-3 text-[11px] text-dim border-b border-line">
                    04 / DISCOVERED NAVIGATION{" "}
                    <span className="text-[#555]">
                      — meaningful links found along the way, honestly labeled
                    </span>
                  </div>
                  <ul>
                    {result.candidates
                      .filter((c) => c.confidence !== "intermediate")
                      .map((candidate) => (
                        <li
                          key={candidate.url}
                          className="px-5 py-4 border-b border-line last:border-b-0"
                        >
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-1.5">
                            <ConfidenceBadge confidence={candidate.confidence} />
                            <span className="text-[10px] tracking-widest text-[var(--amber)]">
                              {SOURCE_LABEL[candidate.source]}
                            </span>
                            {candidate.label && (
                              <span className="text-[11px] text-[#bbb]">
                                “{candidate.label}”
                              </span>
                            )}
                          </div>
                          <a
                            href={candidate.url}
                            target="_blank"
                            rel="noopener noreferrer nofollow"
                            className="text-[12px] text-[#999] break-all underline decoration-[#2a2a2a] underline-offset-4 hover:text-aqua hover:decoration-[var(--aqua)] transition-colors"
                          >
                            {candidate.url}
                          </a>
                          <p className="text-[10px] text-[#555] mt-1.5">{candidate.reason}</p>
                        </li>
                      ))}
                  </ul>
                </section>
              )}

              {/* resolution log */}
              {displayEvents.length > 0 && (
                <section className="border-b border-line">
                  <button
                    onClick={() => setLogOpen((v) => !v)}
                    className="w-full px-5 py-3 text-left text-[11px] text-dim hover:text-strong transition-colors flex items-center justify-between"
                  >
                    <span>RESOLUTION LOG</span>
                    <span>{logOpen ? "−" : "+"}</span>
                  </button>
                  {logOpen && (
                    <div className="px-5 pb-6 pt-2 space-y-1">
                      {displayEvents.map((event, i) => (
                        <div key={i} className="flex gap-3 text-[10px] leading-relaxed">
                          <span className="text-[#555] shrink-0 w-14 text-right">
                            {(event.ts / 1000).toFixed(1)}s
                          </span>
                          <span className="text-aqua shrink-0 w-32">
                            {PHASE_LABEL[event.phase] ?? event.phase}
                          </span>
                          <span className="text-dim break-all">{event.message}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}

              {/* self-diagnostic log (debug mode) */}
              {result.debugLog && result.debugLog.length > 0 && (
                <section className="border-b border-line">
                  <button
                    onClick={() => setDebugOpen((v) => !v)}
                    className="w-full px-5 py-3 text-left text-[11px] text-dim hover:text-strong transition-colors flex items-center justify-between"
                  >
                    <span>TECHNICAL OBSERVATIONS — {result.debugLog.length} STAGES ANALYZED</span>
                    <span>{debugOpen ? "−" : "+"}</span>
                  </button>
                  {debugOpen && (
                    <div className="px-5 pb-7 pt-2 space-y-4">
                      {result.debugLog.map((entry, i) => (
                        <div key={i} className="border border-line">
                          <div className="px-3 py-2 border-b border-line flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] tracking-widest">
                            <span className="text-strong">STEP {entry.step}</span>
                            <span className="text-aqua">{entry.provider.toUpperCase()}</span>
                            <span
                              style={{
                                color:
                                  entry.classification === "final"
                                    ? "var(--aqua)"
                                    : entry.classification === "intermediate"
                                      ? "var(--amber)"
                                      : "var(--muted)",
                              }}
                            >
                              {entry.classification.toUpperCase()}
                            </span>
                            <span className="text-[#555]">
                              +{(entry.elapsedMs / 1000).toFixed(1)}s
                            </span>
                          </div>
                          <div className="px-3 py-2 space-y-1 text-[10px] leading-relaxed">
                            {[
                              ["URL", entry.url],
                              ["TITLE", entry.title ?? "—"],
                              ["VIA", entry.navigationSource],
                              ["HTTP", entry.httpStatus === null ? "—" : String(entry.httpStatus)],
                              ["CANDIDATES", String(entry.candidatesFound)],
                              ["NEXT", entry.nextCandidate ?? "—"],
                              ["WHY NEXT", entry.selectionReason ?? "—"],
                              ["WHY CLASSIFIED", entry.classificationReason],
                              ["SESSION", entry.sessionId],
                            ].map(([k, v]) => (
                              <div key={k} className="flex gap-3">
                                <span className="text-[#555] shrink-0 w-24">{k}</span>
                                <span className="text-dim break-all">{v}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                      {result.stopReason && (
                        <div className="text-[10px] text-[var(--amber)]">
                          STOP REASON: {result.stopReason}
                        </div>
                      )}
                    </div>
                  )}
                </section>
              )}
            </>
          )}

          {/* how it works */}
          {!loading && !result && !fatalError && (
            <section className="px-5 py-8 grid sm:grid-cols-2 lg:grid-cols-4 gap-px bg-[var(--line)] border-b border-line">
              {[
                ["REAL BROWSER", "Every URL is opened in an isolated Chromium session on the server — not fetch(), not HEAD requests. A 200 OK page is never assumed final."],
                ["FULL LIFECYCLE", "HTTP 301/302/303/307/308, meta refresh, JS navigation, timers, forms, popups and new tabs are all observed as one timeline."],
                ["SAFE CONTINUATION", "Clearly labeled Continue / Proceed / Next controls are followed like a user would. Ads, logins, payments, downloads and permission prompts are never touched. CAPTCHAs are reported, not bypassed."],
                ["VERIFIED RESULT", "The deepest destination actually reached is re-confirmed before display. Uncertain links are labeled — never shown as the answer."],
              ].map(([title, body]) => (
                <div key={title} className="bg-[var(--bg)] px-4 py-4">
                  <div className="text-[11px] text-aqua tracking-widest">{title}</div>
                  <p className="text-[11px] text-dim mt-2 leading-relaxed">{body}</p>
                </div>
              ))}
            </section>
          )}
        </div>
      </main>

      {/* ── footer ─────────────────────────────────────────── */}
      <footer className="border-t border-line">
        <div className="max-w-[920px] mx-auto px-5 py-4 border-x border-line flex flex-col sm:flex-row gap-1 sm:justify-between text-[10px] text-[#555]">
          <span>ONE PERSISTENT SESSION PER RESOLUTION · SSRF-GUARDED · RATE-LIMITED</span>
          <span>SESSION STATE LIVES FOR THE WHOLE JOURNEY — DESTROYED WHEN THE JOB ENDS</span>
        </div>
      </footer>
    </div>
  );
}
