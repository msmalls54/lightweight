import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { loadGeminiKey } from "./env.js";
import { SAY_TTS_MODELS, SAY_TTS_TIMEOUT_MS, SPOKEN_FIRST_SENTENCE_MAX_WORDS, TTS_MODEL, voiceId } from "./models.js";
import { geminiSynth, type Synth } from "./tts.js";
import { isWav, trimSilence } from "./wav.js";

export { pcmToWav, ensureWav, isWav, trimSilence, wavDurationMs } from "./wav.js";
export { loadGeminiKey } from "./env.js";
export type { Synth } from "./tts.js";

const NUMBERS = [
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];

/** Clip key -> spoken line. Pre-generated once and cached so call-outs are instant. */
export const CLIPS: Record<string, string> = {
  ...Object.fromEntries(NUMBERS.map((n, i) => [`rep_${i + 1}`, `Rep ${n}.`])),
  delt_took_over: "Your delt took over. Cheat rep.",
  elbows_in: "Elbows in. Keep them pinned.",
  clean_rep: "Clean rep.",
  slow_it_down: "Slow it down. No bouncing.",
  left_slacking: "Left side's slacking.",
  right_slacking: "Right side's slacking.",
  set_done: "Set's done.",
  // Instant set-end feedback (played right at set end while the summary TTS loads).
  all_clean: "Every rep clean.",
  no_cheats: "No cheat reps.",
  a_bit_loose: "A bit loose. Tighten it up.",
  one_cheat: "One cheat rep.",
  two_cheats: "Two cheat reps.",
  three_cheats: "Three cheat reps.",
  four_cheats: "Four cheat reps.",
  many_cheats: "Five or more cheat reps.",
  big_swing: "Big swing in there.",
  shoulder_late: "Your shoulder took over at the end.",
  learning_clean_rep: "Still learning your clean rep.",
  stop_and_rest: "Stop there. Rest longer before the next set.",
  nice_set: "Nice set. Every rep clean.",
  calibrate_relax: "Relax your arms. Stay still.",
  calibrate_flex: "Now flex. Squeeze as hard as you can and hold it.",
  // The dashboard's countdown / calibration lead-ins (app.js LEAD_TEXT / LEAD_IN_TEXT): cached on disk
  // like every clip, so /voice/say answers them instantly even right after a server restart.
  countdown_lead: "Pick them up. Three, two, one, curl!",
  calibrate_lead_in: "Three. Two. One. Squeeze!",
};

/** Default cache: server/.cache/voice (gitignored). */
export const DEFAULT_VOICE_CACHE = fileURLToPath(new URL("../../.cache/voice/", import.meta.url));

interface ClipMeta {
  text: string;
  voice: string;
  model: string;
  /** Leading/trailing silence already trimmed. */
  trimmed?: boolean;
}

const state: { synth?: Synth; synthIsGemini?: boolean; saySynth?: Synth; cacheDir: string; ready: boolean; failed: string[] } = {
  cacheDir: DEFAULT_VOICE_CACHE,
  ready: false,
  failed: [],
};

function clipPath(key: string): string {
  return path.join(state.cacheDir, `${key}.wav`);
}

function manifestPath(): string {
  return path.join(state.cacheDir, "clips.json");
}

function readManifest(): Record<string, ClipMeta> {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(), "utf8"));
  } catch {
    return {};
  }
}

function getSynth(): Synth {
  if (state.synth) return state.synth;
  const apiKey = loadGeminiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY not set (repo-root .env)");
  state.synth = geminiSynth({ apiKey });
  return state.synth;
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface InitVoiceOptions {
  apiKey: string;
  cacheDir: string;
  /** Parallel TTS calls. Default 4 (stay friendly with rate limits). */
  concurrency?: number;
  /** Inject a synth (tests). Default: Gemini TTS with apiKey. */
  synth?: Synth;
  /** Only generate these keys (smoke tests). Default: all CLIPS. */
  keys?: string[];
  log?: (msg: string) => void;
}

/**
 * Pre-generate every clip once and cache the WAVs. Clips already cached with the same text and
 * voice are skipped, so restarts are instant. A clip that fails is logged and retried on demand
 * by the clip route; it never throws the whole init.
 */
export async function initVoice(opts: InitVoiceOptions): Promise<void> {
  state.cacheDir = opts.cacheDir;
  state.synth = opts.synth ?? geminiSynth({ apiKey: opts.apiKey });
  state.synthIsGemini = !opts.synth;
  state.saySynth = undefined;
  state.failed = [];
  const log = opts.log ?? ((m: string) => console.log(`[voice] ${m}`));
  fs.mkdirSync(state.cacheDir, { recursive: true });

  const manifest = readManifest();
  const voice = voiceId();
  const keys = opts.keys ?? Object.keys(CLIPS);
  const todo = keys.filter((k) => {
    const m = manifest[k];
    const f = clipPath(k);
    const cached = m && m.text === CLIPS[k] && m.voice === voice && fs.existsSync(f) && fs.statSync(f).size > 44;
    if (cached && !m.trimmed) {
      // Clip cached before silence trimming existed: trim in place instead of regenerating.
      fs.writeFileSync(f, trimSilence(fs.readFileSync(f)));
      m.trimmed = true;
    }
    return !cached;
  });

  const t0 = Date.now();
  await pool(todo, opts.concurrency ?? 4, async (key) => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const wav = trimSilence(await state.synth!(CLIPS[key]));
        fs.writeFileSync(clipPath(key), wav);
        manifest[key] = { text: CLIPS[key], voice, model: TTS_MODEL, trimmed: true };
        return;
      } catch (e) {
        if (attempt === 2) {
          state.failed.push(key);
          log(`clip ${key} failed: ${(e as Error).message?.slice(0, 160)}`);
        } else await sleep(1500);
      }
    }
  });
  fs.writeFileSync(manifestPath(), JSON.stringify(manifest, null, 1));
  state.ready = true;
  log(
    `${keys.length - todo.length} cached, ${todo.length - state.failed.length} generated in ${Date.now() - t0} ms` +
      (state.failed.length ? `, ${state.failed.length} failed: ${state.failed.join(", ")}` : ""),
  );
}

/** Cached WAV for a clip key, generating it now if it's missing. null for unknown keys. */
export async function getClip(key: string): Promise<Buffer | null> {
  if (!(key in CLIPS)) return null;
  const f = clipPath(key);
  if (fs.existsSync(f)) return fs.readFileSync(f);
  const wav = trimSilence(await getSynth()(CLIPS[key]));
  fs.mkdirSync(state.cacheDir, { recursive: true });
  fs.writeFileSync(f, wav);
  return wav;
}

export function voiceStatus() {
  return { ready: state.ready, cacheDir: state.cacheDir, clips: Object.keys(CLIPS).length, failed: [...state.failed] };
}

const sayCache = new Map<string, Buffer>();

const sayInFlight = new Map<string, Promise<Buffer>>();
const CLIP_BY_TEXT = new Map(Object.entries(CLIPS).map(([k, v]) => [v, k]));

/** Build id of the dashboard's JS (hash of public/app.js, voice-player.js, index.html, read now). */
const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));
export function dashboardBuild(): string {
  const h = createHash("sha1");
  for (const f of ["app.js", "voice-player.js", "index.html"]) {
    try {
      h.update(fs.readFileSync(path.join(PUBLIC_DIR, f)));
    } catch {
      h.update(f);
    }
  }
  return h.digest("hex").slice(0, 10);
}

/** Live TTS: SAY_TTS_MODELS order with a short per-model timeout (tests inject via initVoice's synth). */
function getSaySynth(): Synth {
  if (state.saySynth) return state.saySynth;
  if (state.synth && !state.synthIsGemini) return state.synth; // injected (tests)
  const apiKey = loadGeminiKey();
  if (!apiKey) throw new Error("GEMINI_API_KEY not set (repo-root .env)");
  state.saySynth = geminiSynth({ apiKey, models: SAY_TTS_MODELS, timeoutMs: SAY_TTS_TIMEOUT_MS });
  return state.saySynth;
}

/**
 * The part of a coach line that gets spoken: the first sentence, at most 15 words (cut at a comma or
 * colon if it's longer). The full line is shown on screen. Same rule as LWAudio's spokenPart().
 */
export function spokenPart(text: string, maxWords = SPOKEN_FIRST_SENTENCE_MAX_WORDS): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const first = (t.match(/^.*?[.!?](?=\s|$)/) ?? [t])[0].trim();
  const w = first.split(" ");
  if (w.length <= maxWords) return first;
  const head = w.slice(0, maxWords).join(" ");
  const cut = Math.max(head.lastIndexOf(","), head.lastIndexOf(":"), head.lastIndexOf(";"));
  const out = (cut > 20 ? head.slice(0, cut) : head).replace(/[,:;\s]+$/, "");
  return out + ".";
}

/**
 * Live Gemini TTS for summaries and Q&A answers. Short in-memory cache by text, and concurrent
 * calls for the same text share one Gemini request (the server's pre-TTS and the speaker tab's
 * /voice/say never pay twice).
 */
export async function speak(text: string): Promise<Buffer> {
  const t = text.trim().slice(0, 600);
  if (!t) throw new Error("empty text");
  // A fixed line that's also a clip (e.g. the countdown lead): serve the cached clip.
  const clipKey = CLIP_BY_TEXT.get(t);
  if (clipKey) {
    const wav = await getClip(clipKey).catch(() => null);
    if (wav) return wav;
  }
  const hit = sayCache.get(t);
  if (hit) return hit;
  const pending = sayInFlight.get(t);
  if (pending) return pending;
  const p = (async () => {
    try {
      const wav = trimSilence(await getSaySynth()(t));
      sayCache.set(t, wav);
      if (sayCache.size > 50) sayCache.delete(sayCache.keys().next().value!);
      return wav;
    } finally {
      sayInFlight.delete(t);
    }
  })();
  sayInFlight.set(t, p);
  return p;
}

function wavResponse(wav: Buffer, cache: boolean): Response {
  return new Response(new Uint8Array(wav), {
    headers: {
      "content-type": "audio/wav",
      "content-length": String(wav.length),
      // no-cache: clips can be regenerated (new text/voice), so the browser always revalidates.
      "cache-control": cache ? "no-cache" : "no-store",
    },
  });
}

/**
 * GET  /voice/clips          -> {keys, clips, ready, failed} (the player preloads from this)
 * GET  /voice/clip/:key.wav  -> audio/wav
 * POST /voice/say {text}     -> audio/wav (live TTS)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerVoiceRoutes(app: Hono<any, any, any>): void {
  app.get("/voice/clips", (c) => c.json({ ...voiceStatus(), keys: Object.keys(CLIPS), texts: CLIPS }));
  // The dashboard polls this; if it changes after the tab loaded, the tab's JS is stale -> "Reload this tab".
  app.get("/voice/build", (c) => c.json({ build: dashboardBuild() }, 200, { "cache-control": "no-store" }));

  app.get("/voice/clip/:file", async (c) => {
    const key = c.req.param("file").replace(/\.wav$/i, "");
    try {
      const wav = await getClip(key);
      if (!wav) return c.json({ error: `unknown clip '${key}'` }, 404);
      if (!isWav(wav)) return c.json({ error: "bad clip" }, 500);
      return wavResponse(wav, true);
    } catch (e) {
      return c.json({ error: `clip unavailable: ${(e as Error).message?.slice(0, 120)}` }, 503);
    }
  });

  app.post("/voice/say", async (c) => {
    let text = "";
    try {
      const body = (await c.req.json()) as { text?: unknown };
      text = typeof body.text === "string" ? body.text : "";
    } catch {
      /* fall through */
    }
    if (!text.trim()) return c.json({ error: "body must be {text}" }, 400);
    try {
      return wavResponse(await speak(text), false);
    } catch (e) {
      return c.json({ error: `tts failed: ${(e as Error).message?.slice(0, 120)}` }, 503);
    }
  });
}

/** Test hook: reset module state. */
export function _resetVoiceForTests(): void {
  state.synth = undefined;
  state.saySynth = undefined;
  state.synthIsGemini = undefined;
  state.ready = false;
  state.failed = [];
  state.cacheDir = DEFAULT_VOICE_CACHE;
  sayCache.clear();
}
