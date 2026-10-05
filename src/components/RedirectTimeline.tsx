import { useState } from "react";
import type { NavigationCandidate, RedirectHop } from "@contracts/unwrap";
import {
  CONFIDENCE_META,
  DESTINATION_TYPE_LABEL,
  HOP_TYPE_LABEL,
  SOURCE_LABEL,
} from "@/lib/unwrap";

interface Props {
  inputUrl: string;
  hops: RedirectHop[];
  finalUrl: string | null;
  finalConfidence: keyof typeof CONFIDENCE_META | null;
  destinationType: string | null;
  candidates: NavigationCandidate[];
}

function StatusBadge({ status }: { status: number | null }) {
  if (status === null) return null;
  const color =
    status >= 300 && status < 400
      ? "var(--amber)"
      : status >= 200 && status < 300
        ? "var(--aqua)"
        : "var(--red)";
  return (
    <span className="text-[10px] font-semibold" style={{ color }}>
      {status}
    </span>
  );
}

export function ConfidenceBadge({
  confidence,
}: {
  confidence: keyof typeof CONFIDENCE_META;
}) {
  const meta = CONFIDENCE_META[confidence];
  const color =
    meta.tone === "ok"
      ? "var(--aqua)"
      : meta.tone === "warn"
        ? "var(--amber)"
        : meta.tone === "err"
          ? "var(--red)"
          : "var(--muted)";
  return (
    <span
      className="inline-block text-[9px] font-semibold tracking-widest px-1.5 py-0.5 border"
      style={{ color, borderColor: color }}
    >
      {meta.label}
    </span>
  );
}

function domainOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    const m = url.match(/^([a-z][a-z0-9+.-]*):/i);
    return m ? `${m[1]}:` : "—";
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch {
      return false;
    }
  }
}

export function RedirectTimeline({
  inputUrl,
  hops,
  finalUrl,
  finalConfidence,
  destinationType,
  candidates,
}: Props) {
  const branchCandidates = candidates.filter((c) => c.confidence !== "intermediate");
  // The hop that lands on the final URL is represented by the FINAL entry.
  const intermediateHops = finalUrl
    ? hops.filter((h) => h.destinationUrl !== finalUrl)
    : hops;

  return (
    <ol className="relative border-l border-line ml-1.5 space-y-6">
      {/* origin */}
      <li className="pl-5 relative">
        <span className="absolute -left-[5px] top-1.5 w-2.5 h-2.5 rounded-full border border-[#444] bg-[var(--bg)]" />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] tracking-widest text-dim mb-1">
          <span className="text-strong">01 · INPUT</span>
          <span>{domainOf(inputUrl)}</span>
          <ConfidenceBadge confidence="intermediate" />
        </div>
        <TimelineUrl url={inputUrl} />
      </li>

      {intermediateHops.map((hop, i) => {
        const isLastHop = i === intermediateHops.length - 1 && !finalUrl;
        const showBranches = isLastHop && branchCandidates.length > 0;
        const isScheme = hop.redirectType === "scheme";
        const isGenerated = hop.redirectType === "generated";
        return (
          <li key={hop.step} className="pl-5 relative">
            <span
              className="absolute -left-[5px] top-1.5 w-2.5 h-2.5 rounded-full border"
              style={{
                borderColor: isScheme
                  ? "var(--aqua)"
                  : isGenerated
                    ? "var(--aqua)"
                    : "var(--amber)",
                background: "var(--bg)",
              }}
            />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] tracking-widest text-dim mb-1">
              <span className="text-strong">
                {String(hop.step + 1).padStart(2, "0")} ·{" "}
                {isGenerated ? "GENERATED URL" : isScheme ? "FINAL DESTINATION" : "INTERMEDIATE"}
              </span>
              <StatusBadge status={hop.status} />
              <span className={isScheme || isGenerated ? "text-aqua" : "text-[var(--amber)]"}>
                {HOP_TYPE_LABEL[hop.redirectType] ?? hop.redirectType}
              </span>
              <span>{domainOf(hop.destinationUrl)}</span>
              {hop.provider && hop.provider !== "generic" && (
                <span className="text-[#999]">{hop.provider.toUpperCase()}</span>
              )}
              {hop.inPopup && <span className="text-[var(--amber)]">POPUP</span>}
              <span>+{(hop.at / 1000).toFixed(1)}s</span>
              <span>{hop.responseTime}ms</span>
              <ConfidenceBadge confidence="intermediate" />
            </div>
            {(hop.title || hop.label) && (
              <div className="text-[11px] text-[#bbb] mb-0.5">
                “{(hop.label ?? hop.title) as string}”
              </div>
            )}
            <TimelineUrl url={hop.destinationUrl} />

            {showBranches && (
              <ul className="mt-3 space-y-2 border-l border-dashed border-[#333] pl-4">
                {branchCandidates.map((c) => (
                  <li key={c.url}>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[9px] tracking-widest text-dim mb-0.5">
                      <span>{SOURCE_LABEL[c.source]}</span>
                      <ConfidenceBadge confidence={c.confidence} />
                    </div>
                    {c.label && (
                      <div className="text-[11px] text-[#bbb]">“{c.label}”</div>
                    )}
                    <TimelineUrl url={c.url} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}

      {/* terminal */}
      {finalUrl && (
        <li className="pl-5 relative">
          <span
            className="absolute -left-[5px] top-1.5 w-2.5 h-2.5 rounded-full"
            style={{
              background:
                finalConfidence === "verified" ? "var(--aqua)" : "var(--amber)",
            }}
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-1">
            <span className="text-[10px] text-aqua tracking-widest">
              {String(hops.length + 1).padStart(2, "0")} · FINAL DESTINATION
            </span>
            {destinationType && (
              <span className="text-[10px] tracking-widest text-strong">
                {DESTINATION_TYPE_LABEL[destinationType] ?? destinationType.toUpperCase()}
              </span>
            )}
            <span className="text-[10px] tracking-widest text-dim">{domainOf(finalUrl)}</span>
            {finalConfidence && <ConfidenceBadge confidence={finalConfidence} />}
          </div>
          <TimelineUrl url={finalUrl} strong />
        </li>
      )}
    </ol>
  );
}

/** Expandable/copyable URL used inside timeline items. */
function TimelineUrl({ url, strong }: { url: string; strong?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const display = !open && url.length > 96 ? `${url.slice(0, 96)}…` : url;
  return (
    <div>
      <div
        className={`break-all text-[11px] leading-relaxed ${
          strong ? "text-strong" : "text-[#999]"
        }`}
      >
        {display}
      </div>
      <div className="flex gap-4 mt-1 text-[10px]">
        {url.length > 96 && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-dim hover:text-aqua transition-colors"
          >
            {open ? "COLLAPSE −" : "EXPAND +"}
          </button>
        )}
        <button
          onClick={() => {
            void copyText(url).then((ok) => {
              if (ok) {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              }
            });
          }}
          className="text-dim hover:text-aqua transition-colors"
        >
          {copied ? "COPIED ✓" : "COPY"}
        </button>
        {/^https?:\/\//i.test(url) && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-dim hover:text-aqua transition-colors"
          >
            OPEN ↗
          </a>
        )}
      </div>
    </div>
  );
}
