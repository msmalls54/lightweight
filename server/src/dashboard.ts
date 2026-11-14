// Loopback-only dashboard + control routes. The guard in receiver.ts runs first.
import type { Hono, Context } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { z } from "zod";
import { HttpError, type Pipeline } from "./pipeline.js";
import type { Store } from "./store.js";
import type { Hub } from "./hub.js";
import { captureSchema, sessionStartSchema, setStartSchema } from "./schemas.js";
import { PUBLIC_DIR, REPO_ROOT } from "./paths.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".wav": "audio/wav", ".mp3": "audio/mpeg",
};
function sendFile(c: Context, path: string) {
  if (!existsSync(path)) return c.json({ error: "Not found" }, 404);
  const ext = path.slice(path.lastIndexOf("."));
  return new Response(readFileSync(path), { headers: { "Content-Type": TYPES[ext] ?? "application/octet-stream", "Cache-Control": "no-cache" } });
}

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown = {};
  const text = await c.req.text();
  if (text.trim()) { try { raw = JSON.parse(text); } catch { throw new HttpError(400, "Invalid JSON"); } }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  return parsed.data;
}
function wrap(fn: (c: Context) => unknown | Promise<unknown>) {
  return async (c: Context) => {
    try { return c.json({ ok: true, ...((await fn(c)) as object ?? {}) }); }
    catch (e) {
      if (e instanceof HttpError) return c.json({ ok: false, error: e.message }, e.status);
      console.error("[route]", c.req.path, e);
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  };
}

export function addDashboard(app: Hono<any, any, any>, pipeline: Pipeline, store: Store, hub: Hub) {
  app.get("/", c => sendFile(c, join(PUBLIC_DIR, "index.html")));
  app.get("/app.js", c => sendFile(c, join(PUBLIC_DIR, "app.js")));
  app.get("/voice-player.js", c => sendFile(c, join(PUBLIC_DIR, "voice-player.js")));
  app.get("/public/:file", c => {
    const f = c.req.param("file");
    if (!/^[\w.-]+\.(js|css|svg|png|wav|mp3|json)$/.test(f) || f.includes("..")) return c.json({ error: "Not found" }, 404);
    return sendFile(c, join(PUBLIC_DIR, f));
  });
  app.get("/muscle-map.json", c => sendFile(c, resolve(REPO_ROOT, "assets/muscle-map/anterior.json")));

  app.get("/events", c => hub.connect(c.req.raw.signal, pipeline.snapshot(), { mute: c.req.query("mute") !== undefined }));
  app.post("/speaker/claim", wrap(async c => {
    const b = (await c.req.json().catch(() => ({}))) as { client_id?: unknown };
    if (typeof b.client_id !== "string" || !hub.claim(b.client_id)) throw new HttpError(400, "Unknown or muted dashboard.");
    return { speaker: b.client_id };
  }));
  app.get("/api/state", c => c.json(pipeline.status()));
  app.get("/sessions", c => c.json({ sessions: store.listSessions(40) }));
  app.get("/health", c => c.json({ ok: true, service: "lightweight", ...pipeline.status() }));

  app.post("/session/start", wrap(async c => {
    const b = await body(c, sessionStartSchema);
    const s = pipeline.startSession({ person: b.person, walkup: b.walkup, kind: b.kind, arms: b.arms });
    return { session_id: s.id, person: s.person, arms: s.arms };
  }));
  app.post("/set/start", wrap(async c => {
    const b = await body(c, setStartSchema);
    const ctx = pipeline.startSet(b);
    return { set_id: ctx.set_id, ctx };
  }));
  app.post("/set/stop", wrap(() => { pipeline.stopSet(); return {}; }));
  app.post("/set/countdown", wrap(async c => { const b = await body(c, setStartSchema); return pipeline.startCountdown(b); }));
  app.post("/set/cancel", wrap(() => ({ cancelled: pipeline.cancelCountdown() })));

  app.post("/calibrate/begin", wrap(() => pipeline.calBegin()));
  app.post("/calibrate/capture", wrap(async c => { const b = await body(c, captureSchema); return pipeline.calCapture(b.step, b.ch, b.window_ms); }));
  app.post("/calibrate/cancel", wrap(() => { pipeline.calCancel(); return {}; }));
  app.post("/calibrate", wrap(() => ({ calibration: pipeline.calFinish() })));

  app.post("/replay/stop", wrap(() => ({ stopped: pipeline.stopReplay() })));
  app.post("/replay/:session_id", wrap(c => {
    const speed = Number(c.req.query("speed") ?? "1");
    return pipeline.startReplay(c.req.param("session_id") ?? "", Number.isFinite(speed) ? speed : 1);
  }));
}
