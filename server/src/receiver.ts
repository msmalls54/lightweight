import type { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { bodyLimit } from "hono/body-limit";
import { batchSchema, heartbeatSchema } from "./schemas.js";
import type { Pipeline } from "./pipeline.js";

const PORT = Number(process.env.PORT) || 3000;
export const LOCAL_ORIGINS = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, `http://[::1]:${PORT}`];
export const AGENT_ORIGINS = ["https://chatgpt.com", "https://chat.openai.com", "https://claude.ai"];
export function originAllowed(origin: string | undefined, publicOrigin?: string | null) {
  return !origin || [...LOCAL_ORIGINS, ...AGENT_ORIGINS, ...(publicOrigin ? [publicOrigin] : [])].includes(origin);
}
const DEVICE_PATHS = new Set(["/ingest", "/heartbeat"]);
const LOOPBACK = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

/** Only /ingest and /heartbeat accept LAN callers (the UNO). Everything else is this laptop only. */
export function addGuard(app: Hono<any, any, any>, publicOrigin?: () => string | null) {
  // Use the socket peer, never a caller-supplied Host or X-Forwarded-For header.
  app.use("*", async (c, next) => {
    if (DEVICE_PATHS.has(c.req.path)) {
      if (c.req.method !== "POST") return c.json({ error: "POST required" }, 405);
      return next();
    }
    let peer: string | undefined;
    try { peer = getConnInfo(c).remote.address; } catch { /* no real socket in unit tests */ }
    if (!LOOPBACK.includes(peer ?? "")) return c.json({ error: "Dashboard and MCP are available only on this laptop." }, 403);
    if (!originAllowed(c.req.header("Origin"), publicOrigin?.())) return c.json({ error: "Origin not allowed." }, 403);
    return next();
  });
  const deviceBody = bodyLimit({ maxSize: 32 * 1024, onError: c => c.json({ error: "Body too large" }, 413) });
  const localBody = bodyLimit({ maxSize: 256 * 1024, onError: c => c.json({ error: "Body too large" }, 413) });
  // The mcp-use inspector posts the inline widget bundle (~2.5 MB) to its local preview store.
  const widgetBody = bodyLimit({ maxSize: 4 * 1024 * 1024, onError: c => c.json({ error: "Widget preview too large" }, 413) });
  const previewStores = new Set(["/inspector/api/resources/widget/store", "/inspector/api/mcp-apps/widget/store"]);
  app.use("*", (c, next) => (DEVICE_PATHS.has(c.req.path) ? deviceBody : previewStores.has(c.req.path) ? widgetBody : localBody)(c, next));
}

export function addReceiver(app: Hono<any, any, any>, pipeline: Pipeline) {
  app.post("/ingest", async c => {
    let raw: unknown;
    try { raw = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
    const parsed = batchSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "Invalid batch", fields: parsed.error.issues.map(i => i.path.join(".") + ": " + i.message) }, 400);
    try {
      const r = pipeline.ingest(parsed.data);
      return c.json({ ok: true, duplicate: r.duplicate });
    } catch (e) {
      console.error("[ingest] failed:", e instanceof Error ? e.message : e);
      return c.json({ error: "Storage unavailable; retry" }, 503);
    }
  });
  app.post("/heartbeat", async c => {
    let raw: unknown;
    try { raw = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }
    const parsed = heartbeatSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "Invalid heartbeat", fields: parsed.error.issues.map(i => i.path.join(".")) }, 400);
    try { pipeline.heartbeat(parsed.data); } catch { return c.json({ error: "Storage unavailable; retry" }, 503); }
    return c.json({ ok: true });
  });
}
