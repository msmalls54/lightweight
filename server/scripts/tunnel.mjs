// npm run tunnel: Cloudflare quick tunnel to the GATEWAY (127.0.0.1:3001), never to :3000.
// Prints the private connector URL (https://<random>.trycloudflare.com/mcp?access_token=...) and saves the public
// origin to server/.mcp-use/state/public-url.txt. Restart the server once afterwards so the muscle-map widget
// loads its assets from the public origin. Ctrl-C stops the tunnel.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(serverDir, "..");
const gatewayPort = Number(process.env.LW_GATEWAY_PORT) || 3001;
const stateFile = resolve(serverDir, ".mcp-use", "state", "public-url.txt");

function readToken() {
  if (process.env.LW_MCP_TOKEN) return process.env.LW_MCP_TOKEN;
  const env = resolve(repoRoot, ".env");
  if (!existsSync(env)) return null;
  const m = readFileSync(env, "utf8").match(/^LW_MCP_TOKEN=(.+)$/m);
  return m ? m[1].trim() : null;
}

const token = readToken();
if (!token) {
  console.error("No LW_MCP_TOKEN yet: start the server once (npm run dev); it creates the token in the repo .env.");
  process.exit(1);
}
try { const r = await fetch(`http://127.0.0.1:${gatewayPort}/mcp`); if (r.status !== 401) console.warn(`[tunnel] gateway :${gatewayPort} answered ${r.status} (expected 401 without a token)`); }
catch { console.error(`[tunnel] nothing on 127.0.0.1:${gatewayPort}. Start the server first (it opens the gateway).`); process.exit(1); }

const cf = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${gatewayPort}`, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
let announced = false;
const onLine = buf => {
  const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!m || announced) return;
  announced = true;
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, m[0] + "\n");
  console.log(`\n[tunnel] Public origin: ${m[0]}  (forwards to the gateway on :${gatewayPort} only)`);
  console.log(`[tunnel] Claude connector URL (KEEP PRIVATE, it carries the access token):\n  ${m[0]}/mcp?access_token=${token}\n`);
  console.log("[tunnel] Restart the Lightweight server once now so the widget loads from this origin.");
  console.log("[tunnel] Ctrl-C to close the tunnel.\n");
};
cf.stdout.on("data", onLine);
cf.stderr.on("data", onLine);
cf.on("error", e => { console.error("[tunnel] could not start cloudflared:", e.message); process.exit(1); });
cf.on("exit", code => { console.log(`[tunnel] cloudflared exited (${code})`); try { rmSync(stateFile); } catch {} process.exit(code ?? 0); });
const stop = () => { try { cf.kill(); } catch {} };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
