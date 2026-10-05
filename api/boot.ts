import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./context";
import { env } from "./lib/env";
import { handleUnwrap, handleUnwrapStream } from "./routes/unwrap";

const app = new Hono<{ Bindings: HttpBindings }>();

// CORS for Vercel frontend
app.use("*", cors({
  origin: (origin) => {
    // Allow Vercel preview/production + local dev
    if (!origin || origin.includes('vercel.app') || origin.includes('localhost')) {
      return origin;
    }
    return null;
  },
  credentials: true,
}));

app.use(bodyLimit({ maxSize: 50 * 1024 * 1024 }));

// URL Unwrapper — server-side redirect resolver.
app.post("/api/unwrap", handleUnwrap);
app.get("/api/unwrap/stream", handleUnwrapStream);

app.use("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext,
  });
});
app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

export default app;

if (env.isProduction) {
  const { serve } = await import("@hono/node-server");
  const { serveStaticFiles } = await import("./lib/vite");
  serveStaticFiles(app);

  const port = parseInt(process.env.PORT || "3000");
  serve({ fetch: app.fetch, port }, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}
