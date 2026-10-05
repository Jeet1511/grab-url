import { describe, expect, it } from "vitest";
import {
  analyzeHtml,
  extractDestinationFromParams,
  extractEncodedTargets,
} from "./redirect-parser";
import { discoverLinks } from "./link-discovery";
import {
  InvalidUrlError,
  normalizeInputUrl,
  resolveRedirectTarget,
} from "./url-validator";
import { SsrfBlockError, isBlockedIp } from "./ssrf-protection";

describe("analyzeHtml", () => {
  it("detects meta refresh with url target", () => {
    const html = `<html><head><meta http-equiv="refresh" content="0; url=https://dest.example/landing"></head></html>`;
    expect(analyzeHtml(html)).toEqual({
      kind: "meta",
      target: "https://dest.example/landing",
      delaySeconds: 0,
    });
  });

  it("detects meta refresh case-insensitively with quoted target and delay", () => {
    const html = `<META HTTP-EQUIV='Refresh' CONTENT="3;URL='https://dest.example/x'">`;
    expect(analyzeHtml(html)).toEqual({
      kind: "meta",
      target: "https://dest.example/x",
      delaySeconds: 3,
    });
  });

  it("detects location.href string assignment", () => {
    const html = `<script>location.href = "https://dest.example/js";</script>`;
    expect(analyzeHtml(html)).toEqual({ kind: "js", target: "https://dest.example/js" });
  });

  it("detects location.replace()", () => {
    const html = `<script>window.location.replace('/next');</script>`;
    expect(analyzeHtml(html)).toEqual({ kind: "js", target: "/next" });
  });

  it("detects location.assign()", () => {
    const html = `<script>location.assign("https://dest.example/a?b=1");</script>`;
    expect(analyzeHtml(html)).toEqual({ kind: "js", target: "https://dest.example/a?b=1" });
  });

  it("escalates dynamic navigation", () => {
    const html = `<script>var t = atob("aHR0cHM6Ly94"); location.href = t;</script>`;
    expect(analyzeHtml(html)).toEqual({ kind: "dynamic" });
  });

  it("returns none for ordinary pages", () => {
    const html = `<html><body><h1>Hello</h1><script>console.log(location.href);</script></body></html>`;
    expect(analyzeHtml(html)).toEqual({ kind: "none" });
  });
});

describe("normalizeInputUrl", () => {
  it("prepends https:// to bare hosts", () => {
    expect(normalizeInputUrl("example.com").toString()).toBe("https://example.com/");
  });
  it("rejects non-http protocols", () => {
    expect(() => normalizeInputUrl("ftp://example.com")).toThrow(InvalidUrlError);
  });
  it("rejects credentials", () => {
    expect(() => normalizeInputUrl("https://u:p@example.com")).toThrow(InvalidUrlError);
  });
  it("rejects unsafe ports", () => {
    expect(() => normalizeInputUrl("https://example.com:22/")).toThrow(InvalidUrlError);
  });
  it("blocks private IP literals via SSRF guard", () => {
    expect(() => normalizeInputUrl("http://10.0.0.5/")).toThrow(SsrfBlockError);
  });
  it("blocks decimal-encoded loopback", () => {
    expect(() => normalizeInputUrl("http://2130706433/")).toThrow(SsrfBlockError);
  });
});

describe("isBlockedIp", () => {
  const blocked = [
    "127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.0.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "240.0.0.1",
    "::1", "fe80::1", "fc00::1", "ff02::1", "::",
    "::ffff:127.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::",
  ];
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => expect(isBlockedIp(ip)).toBe(true));
  }
  const allowed = ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "93.184.216.34"];
  for (const ip of allowed) {
    it(`allows ${ip}`, () => expect(isBlockedIp(ip)).toBe(false));
  }
});

describe("resolveRedirectTarget", () => {
  const base = new URL("https://a.example/dir/page");
  it("resolves absolute", () => {
    expect(resolveRedirectTarget(base, "https://b.example/x")?.toString()).toBe("https://b.example/x");
  });
  it("resolves relative", () => {
    expect(resolveRedirectTarget(base, "../up")?.toString()).toBe("https://a.example/up");
  });
  it("resolves protocol-relative", () => {
    expect(resolveRedirectTarget(base, "//cdn.example/y")?.toString()).toBe("https://cdn.example/y");
  });
  it("resolves encoded targets", () => {
    expect(
      resolveRedirectTarget(base, "https%3A%2F%2Fenc.example%2Fz")?.toString(),
    ).toBe("https://enc.example/z");
  });
  it("returns null on garbage", () => {
    expect(resolveRedirectTarget(base, "http://[::1")).toBeNull();
  });
});

describe("discoverLinks", () => {
  const base = new URL("https://gate.example/out?x=1");

  it("surfaces continue links to external destinations", () => {
    const html = `<html><body>
      <p>Your link is ready</p>
      <a href="https://target.example/landing">Continue to Destination</a>
      </body></html>`;
    const links = discoverLinks(html, base);
    expect(links.length).toBe(1);
    expect(links[0].url).toBe("https://target.example/landing");
    expect(links[0].label).toBe("Continue to Destination");
    expect(links[0].kind).toBe("continue_button");
    expect(links[0].relevance).toBeGreaterThanOrEqual(65);
  });

  it("ignores ads, social links and boilerplate", () => {
    const html = `<html><body>
      <a href="https://doubleclick.net/ad/123">Ad</a>
      <a href="https://twitter.com/intent/tweet?text=hi">Tweet</a>
      <a href="https://gate.example/privacy">Privacy policy</a>
      <a href="https://gate.example/login">Sign in</a>
      <a href="javascript:void(0)">void</a>
      <a href="#top">top</a>
      </body></html>`;
    expect(discoverLinks(html, base)).toEqual([]);
  });

  it("downranks same-host navigation menus", () => {
    const html = `<html><body>
      <nav>
        <a href="https://gate.example/home">Home</a>
        <a href="https://gate.example/blog">Blog</a>
      </nav>
      <a href="https://real.example/page">Open</a>
      </body></html>`;
    const links = discoverLinks(html, base);
    expect(links.map((l) => l.url)).toEqual(["https://real.example/page"]);
  });

  it("extracts button formaction and onclick navigation", () => {
    const html = `<html><body>
      <button formaction="/go/next">Proceed</button>
      <a onclick="window.location='https://dest.example/via-onclick'">Next</a>
      </body></html>`;
    const links = discoverLinks(html, base);
    const urls = links.map((l) => l.url);
    expect(urls).toContain("https://gate.example/go/next");
    expect(urls).toContain("https://dest.example/via-onclick");
  });

  it("caps the number of surfaced candidates", () => {
    const anchors = Array.from(
      { length: 20 },
      (_, i) => `<a href="https://d${i}.example/x">Continue ${i}</a>`,
    ).join("");
    const links = discoverLinks(`<html><body>${anchors}</body></html>`, base);
    expect(links.length).toBeLessThanOrEqual(6);
  });
});

describe("extractDestinationFromParams", () => {
  it("extracts a plain embedded URL", () => {
    const u = new URL("https://gate.example/out?url=https%3A%2F%2Freal.example%2Fpage");
    expect(extractDestinationFromParams(u)).toEqual(["https://real.example/page"]);
  });

  it("extracts a base64-encoded destination", () => {
    const b64 = Buffer.from("https://real.example/secret").toString("base64");
    const u = new URL(`https://gate.example/out?u=${encodeURIComponent(b64)}`);
    expect(extractDestinationFromParams(u)).toEqual(["https://real.example/secret"]);
  });

  it("ignores unrelated parameters", () => {
    const u = new URL("https://gate.example/article?id=42&lang=en");
    expect(extractDestinationFromParams(u)).toEqual([]);
  });
});

describe("extractEncodedTargets", () => {
  it("decodes atob() literals containing URLs", () => {
    const b64 = Buffer.from("https://hidden.example/dest").toString("base64");
    const html = `<script>var t = atob("${b64}"); location.href = t;</script>`;
    expect(extractEncodedTargets(html)).toContain("https://hidden.example/dest");
  });

  it("finds bare base64 payloads in scripts", () => {
    const b64 = Buffer.from("https://payload.example/x?y=1").toString("base64");
    const html = `<script>var d = "${b64}";</script>`;
    expect(extractEncodedTargets(html)).toContain("https://payload.example/x?y=1");
  });

  it("returns nothing for ordinary pages", () => {
    expect(extractEncodedTargets("<html><body>Hello</body></html>")).toEqual([]);
  });
});
