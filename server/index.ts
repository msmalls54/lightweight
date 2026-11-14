import { MCPServer } from "mcp-use/server";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { REPO_ROOT, DB_PATH } from "./src/paths.js";
import { Store } from "./src/store.js";
import { Hub } from "./src/hub.js";
import { Pipeline } from "./src/pipeline.js";
import { addGuard, addReceiver } from "./src/receiver.js";
import { addDashboard } from "./src/dashboard.js";
import { initVoice, registerVoiceRoutes, loadGeminiKey, DEFAULT_VOICE_CACHE } from "./src/modules.js";
import { registerTools } from "./src/mcp/tools.js";
import { startGateway } from "./src/gateway.js";
import { SERVER_DIR } from "./src/paths.js";

// Repo-root .env holds GEMINI_API_KEY. Never print it.
const envFile = resolve(REPO_ROOT, ".env");
if (existsSync(envFile)) { try { loadEnvFile(envFile); } catch (e) { console.error("[env] could not read .env:", (e as Error).message); } }

// `mcp-use dev` re-imports this file on every edit (HMR) and also imports it once for type
// generation. Keep the DB, SSE clients, pipeline state and voice init as process singletons.
type Singletons = { store: Store; hub: Hub; pipeline: Pipeline; voice?: Promise<void>; gateway?: Promise<unknown> };
const G = globalThis as typeof globalThis & { __lightweight?: Singletons };
if (!G.__lightweight) {
  const store = new Store(DB_PATH);
  const hub = new Hub();
  G.__lightweight = { store, hub, pipeline: new Pipeline(store, hub) };
}
const lw = G.__lightweight;
const geminiKey = loadGeminiKey(); // walks up from cwd to the repo .env; never print it
if (!lw.voice && geminiKey) {
  // Not awaited: ~80 s the first time (TTS for every clip), instant once server/.cache/voice is warm.
  lw.voice = initVoice({ apiKey: geminiKey, cacheDir: DEFAULT_VOICE_CACHE })
    .catch(e => console.error("[voice] init failed:", e instanceof Error ? e.message : e));
}

// Remote access (tunnel -> gateway :3001 -> this server). The MCP access token lives in the ignored repo .env;
// the public origin (from `npm run tunnel`) becomes the widgets' base URL so Claude's iframe can load them.
if (!process.env.LW_MCP_TOKEN) {
  const token = randomBytes(32).toString("base64url");
  try { appendFileSync(envFile, `\nLW_MCP_TOKEN=${token}\n`, { mode: 0o600 }); } catch { /* read-only: token for this run only */ }
  process.env.LW_MCP_TOKEN = token;
}
// server/.cache survives restarts (mcp-use dev wipes .mcp-use/state on start); gitignored.
const stateUrlFile = resolve(SERVER_DIR, ".cache", "public-url.txt");
const publicUrl = (process.env.LW_PUBLIC_URL || (existsSync(stateUrlFile) ? readFileSync(stateUrlFile, "utf8").trim() : "")).replace(/\/$/, "") || undefined;
const publicOrigin = publicUrl ? new URL(publicUrl).origin : null;

export const server = new MCPServer({
  name: "lightweight", title: "Lightweight", version: "0.1.0",
  baseUrl: publicUrl,
  description: "Lightweight: an AI curl coach that reads 4 EMG sensors (L/R biceps, L/R front delt). Read reps, sets, cheat flags (delt took over) and L/R balance as relative %MVC. Not force, not medical.",
  host: "0.0.0.0",
  stateless: true,
});

addGuard(server.app, () => publicOrigin);
addReceiver(server.app, lw.pipeline);
registerVoiceRoutes(server.app);
addDashboard(server.app, lw.pipeline, lw.store, lw.hub);
registerTools(server, lw.store, lw.pipeline);

export default server;

const PORT = Number(process.env.PORT) || 3000; // PORT for extra test instances (mcp-use dev --no-hmr ignores --port)
await server.listen(PORT);
// The only listener a tunnel may point at: /mcp (with the token) + widget assets. Off with LW_GATEWAY=0.
const gport = Number(process.env.LW_GATEWAY_PORT) || 3001;
if (gport === PORT) console.error(`[gateway] not started: gateway port ${gport} equals the server port (set LW_GATEWAY_PORT)`);
else if (!lw.gateway && process.env.LW_GATEWAY !== "0") {
  lw.gateway = startGateway({ port: gport, backendPort: PORT, token: process.env.LW_MCP_TOKEN ?? "", serverDir: SERVER_DIR })
    .then(() => console.log(`[gateway] 127.0.0.1:${gport} -> :${PORT} (only /mcp?access_token=... and widget assets)${publicUrl ? `, public ${publicUrl}` : ""}`))
    .catch(e => console.error(`[gateway] not started on :${gport}:`, e instanceof Error ? e.message : e));
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { lw.pipeline.endLive(); } catch { /* still close */ }
  await server.close();
  lw.store.close();
}
process.once("SIGINT", () => { void stop().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void stop().finally(() => process.exit(0)); });
