import { MCPServer } from "mcp-use/server";
import { existsSync } from "node:fs";
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

// Repo-root .env holds GEMINI_API_KEY. Never print it.
const envFile = resolve(REPO_ROOT, ".env");
if (existsSync(envFile)) { try { loadEnvFile(envFile); } catch (e) { console.error("[env] could not read .env:", (e as Error).message); } }

// `mcp-use dev` re-imports this file on every edit (HMR) and also imports it once for type
// generation. Keep the DB, SSE clients, pipeline state and voice init as process singletons.
type Singletons = { store: Store; hub: Hub; pipeline: Pipeline; voice?: Promise<void> };
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

export const server = new MCPServer({
  name: "lightweight", title: "Lightweight", version: "0.1.0",
  description: "Lightweight: an AI curl coach that reads 4 EMG sensors (L/R biceps, L/R front delt). Read reps, sets, cheat flags (delt took over) and L/R balance as relative %MVC. Not force, not medical.",
  host: "0.0.0.0",
  stateless: true,
});

addGuard(server.app);
addReceiver(server.app, lw.pipeline);
registerVoiceRoutes(server.app);
addDashboard(server.app, lw.pipeline, lw.store, lw.hub);
registerTools(server, lw.store, lw.pipeline);

export default server;

await server.listen(3000);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server.close();
  lw.store.close();
}
process.once("SIGINT", () => { void stop().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void stop().finally(() => process.exit(0)); });
