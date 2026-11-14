// Public entrance for a tunnel (cloudflared -> 127.0.0.1:3001 -> 127.0.0.1:3000).
// Through a tunnel every request arrives from 127.0.0.1, so the loopback guard on :3000 can't tell the
// internet from this laptop. This gateway is the only thing a tunnel may point at. It forwards:
//   - /mcp (POST/GET/DELETE/OPTIONS) with ?access_token=<LW_MCP_TOKEN>, which is stripped before forwarding;
//   - GET/HEAD of the muscle-map widget's assets (mcp-use dev serves them from Vite under /mcp-use/widgets/).
// Everything else (dashboard, /set/*, /quiet, /session/*, /replay, /voice/*, /events, /inspector, /ingest) is 404.
import { createServer, request, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const MCP_METHODS = new Set(["POST", "GET", "DELETE", "OPTIONS", "HEAD"]);
/** Widget asset prefixes Vite needs for the muscle-map iframe. No /@fs/ (arbitrary files), no data/. */
const ASSET_PREFIXES = [
  "/mcp-use/widgets/muscle-map/", "/mcp-use/widgets/@vite/", "/mcp-use/widgets/@react-refresh", "/mcp-use/widgets/@id/",
  "/mcp-use/widgets/node_modules/.vite/", "/mcp-use/widgets/resources/muscle-map/", "/mcp-use/public/",
];
const BLOCKED = /(\.\.|%2e|\.env|\.sqlite|\.db\b|\.log\b|\/data\/|\\)/i;
/** Vite dev serves deps and the widget source as /@fs/<absolute path>: allow only these folders under server/. */
function fsPrefixes(serverDir: string) {
  const d = serverDir.split("\\").join("/").replace(/\/$/, "");
  return [`${d}/node_modules/.vite/deps/`, `${d}/node_modules/vite/dist/client/`, `${d}/resources/muscle-map/`].map(p => `/mcp-use/widgets/@fs/${p}`);
}

const equalToken = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** Fixed-window per-IP limit (the tunnel puts the caller in cf-connecting-ip). */
class RateLimit {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private max: number, private windowMs: number) {}
  ok(key: string) {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || now > h.reset) { this.hits.set(key, { n: 1, reset: now + this.windowMs }); if (this.hits.size > 5000) this.hits.clear(); return true; }
    return ++h.n <= this.max;
  }
}

export function gatewayDecision(method: string, rawUrl: string, token: string, serverDir = ""): { allow: false; status: number; error: string } | { allow: true; path: string; kind: "mcp" | "asset" } {
  let url: URL;
  try { url = new URL(rawUrl, "http://gateway"); } catch { return { allow: false, status: 400, error: "Invalid URL" }; }
  if (url.pathname === "/mcp") {
    if (!MCP_METHODS.has(method)) return { allow: false, status: 405, error: "Method not allowed" };
    const t = url.searchParams.getAll("access_token");
    if (t.length !== 1 || !token || !equalToken(t[0], token)) return { allow: false, status: 401, error: "A valid private connection URL is required" };
    url.searchParams.delete("access_token");
    return { allow: true, path: url.pathname + url.search, kind: "mcp" };
  }
  const isFs = url.pathname.startsWith("/mcp-use/widgets/@fs/");
  const allowedPath = isFs ? !!serverDir && fsPrefixes(serverDir).some(p => url.pathname.startsWith(p)) : ASSET_PREFIXES.some(p => url.pathname.startsWith(p));
  if ((method === "GET" || method === "HEAD") && allowedPath && !BLOCKED.test(rawUrl)) {
    return { allow: true, path: url.pathname + url.search, kind: "asset" };
  }
  return { allow: false, status: 404, error: "Not found" };
}

export async function startGateway(o: { port: number; backendPort: number; token: string; serverDir: string; host?: string }): Promise<Server> {
  const mcpLimit = new RateLimit(240, 60_000), assetLimit = new RateLimit(1200, 60_000);
  const server = createServer((req, res) => {
    const ip = String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "?");
    const d = gatewayDecision(req.method ?? "GET", req.url ?? "/", o.token, o.serverDir);
    if (!d.allow) return reply(res, d.status, d.error);
    if (!(d.kind === "mcp" ? mcpLimit : assetLimit).ok(ip)) return reply(res, 429, "Too many requests");
    if (d.kind === "mcp" && Number(req.headers["content-length"] ?? 0) > 1_000_000) return reply(res, 413, "Body too large");
    proxy(req, res, o.backendPort, d.path);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host ?? "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return server;
}

function reply(res: ServerResponse, status: number, error: string) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error }));
}
function proxy(req: IncomingMessage, res: ServerResponse, backendPort: number, path: string) {
  // Forwarded/X-Forwarded-* headers are dropped: the backend must never mistake a tunnel caller for this laptop's browser.
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([n]) => !HOP.has(n) && !n.startsWith("x-forwarded-") && !["host", "forwarded", "cf-connecting-ip"].includes(n)));
  headers.host = `localhost:${backendPort}`;
  const up = request({ hostname: "127.0.0.1", port: backendPort, method: req.method, path, headers }, r => {
    res.writeHead(r.statusCode ?? 502, Object.fromEntries(Object.entries(r.headers).filter(([n]) => !HOP.has(n))));
    r.pipe(res);
    r.on("error", () => res.destroy());
  });
  up.on("error", () => { if (!res.headersSent) reply(res, 503, "Lightweight server is starting; retry shortly"); else res.destroy(); });
  req.on("aborted", () => up.destroy());
  res.on("close", () => up.destroy());
  req.pipe(up);
}
