/**
 * URL Unwrapper endpoints.
 *
 * POST /api/unwrap          — request/response JSON resolution
 * GET  /api/unwrap/stream   — same resolution with truthful live progress
 *                             (Server-Sent Events: "progress" + "result")
 *
 * Response payload: UnwrapResponse (see contracts/unwrap.ts)
 */

import type { Context } from "hono";
import { z } from "zod";
import { streamSSE } from "hono/streaming";
import type { ResolutionEvent, UnwrapError } from "@contracts/unwrap";
import { unwrapUrl } from "../resolver/destination-detector";
import { checkRateLimit, release, tryAcquire } from "../resolver/limiter";

const bodySchema = z.object({
  url: z.string().min(1).max(2048),
  debug: z.boolean().optional(),
});

function clientKey(c: Context): string {
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return c.req.header("x-real-ip") ?? "unknown";
}

function admit(c: Context): Response | null {
  if (!checkRateLimit(clientKey(c))) {
    return c.json<UnwrapError>(
      { error: "rate_limited", message: "Too many requests. Try again in a minute." },
      429,
    );
  }
  if (!tryAcquire()) {
    return c.json<UnwrapError>(
      { error: "busy", message: "The resolver is busy. Try again shortly." },
      429,
    );
  }
  return null;
}

export async function handleUnwrap(c: Context) {
  const rejection = admit(c);
  if (rejection) return rejection;

  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json<UnwrapError>(
        { error: "bad_request", message: "Request body must be JSON: { \"url\": \"...\" }" },
        400,
      );
    }
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json<UnwrapError>(
        { error: "bad_request", message: "Expected { \"url\": string (1–2048 chars) }." },
        400,
      );
    }

    const result = await unwrapUrl(parsed.data.url, { debug: parsed.data.debug === true });
    return c.json(result, 200);
  } finally {
    release();
  }
}

/**
 * Streaming variant. Events:
 *   event: progress  data: ResolutionEvent
 *   event: result    data: UnwrapResponse
 *   event: error     data: { message }
 */
export async function handleUnwrapStream(c: Context) {
  const rejection = admit(c);
  if (rejection) return rejection;

  const parsed = bodySchema.safeParse({
    url: c.req.query("url") ?? "",
    debug: c.req.query("debug") === "1" ? true : undefined,
  });
  if (!parsed.success) {
    release();
    return c.json<UnwrapError>(
      { error: "bad_request", message: "Expected ?url=… (1–2048 chars)." },
      400,
    );
  }

  return streamSSE(c, async (stream) => {
    // Serialize writes: progress events and the result must not interleave.
    let writes: Promise<unknown> = Promise.resolve();
    const onEvent = (event: ResolutionEvent): void => {
      writes = writes
        .then(() => stream.writeSSE({ event: "progress", data: JSON.stringify(event) }))
        .catch(() => {});
    };

    // Keep the connection alive through long server-side waits
    // (countdown gates, patient browser passes).
    const heartbeat = setInterval(() => {
      writes = writes.then(() => stream.writeSSE({ data: "{}", event: "ping" })).catch(() => {});
    }, 10_000);

    try {
      const result = await unwrapUrl(parsed.data.url, {
        onEvent,
        debug: parsed.data.debug === true,
      });
      await writes;
      await stream.writeSSE({ event: "result", data: JSON.stringify(result) });
    } catch {
      await writes;
      await stream
        .writeSSE({
          event: "error",
          data: JSON.stringify({ message: "Resolution failed unexpectedly." }),
        })
        .catch(() => {});
    } finally {
      clearInterval(heartbeat);
      release();
    }
  });
}
