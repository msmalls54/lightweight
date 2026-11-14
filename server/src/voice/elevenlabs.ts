// ElevenLabs TTS (fallback provider when Gemini TTS errors or times out). Plain fetch, no SDK.
// Docs checked Nov 14: POST /v1/text-to-speech/{voice_id}?output_format=..., header xi-api-key,
// body {text, model_id, voice_settings}; eleven_flash_v2_5 is a current ~100 ms model.
import { ensureWav, pcmToWav } from "./wav.js";
import type { Synth } from "./tts.js";

export const ELEVEN_BASE = "https://api.elevenlabs.io";
export const ELEVEN_MODEL = "eleven_flash_v2_5";
export const ELEVEN_TIMEOUT_MS = 8000;
/**
 * Used only if ELEVENLABS_VOICE_ID isn't set AND the live voice lookup (GET /v1/voices) finds no premade
 * male coach-style voice: the voice id the ElevenLabs API docs use in their own TTS example.
 */
export const ELEVEN_DOCS_EXAMPLE_VOICE = "JBFqnCBsd6RMkjVDRZzb";
/** Tried in order; the first one the plan accepts sticks. pcm/wav are wrapped as WAV, mp3 is served as audio/mpeg. */
export const ELEVEN_FORMATS = ["pcm_24000", "wav_24000", "mp3_44100_128"] as const;

export interface ElevenOptions {
  apiKey: string;
  voiceId?: string;
  modelId?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

interface VoiceInfo {
  voice_id: string;
  name?: string;
  category?: string;
  description?: string | null;
  labels?: Record<string, string | undefined>;
}

/** MP3 bytes (ID3 tag or an MPEG frame sync). */
export function isMp3(b: Buffer): boolean {
  return b.length > 3 && (b.toString("latin1", 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0));
}

/** Pick a firm male coach-style voice from a /v1/voices listing (premade first). null if none fits. */
export function pickCoachVoice(voices: VoiceInfo[]): string | null {
  const words = /deep|authoritative|firm|strong|confident|intense|commanding|gravel|husky|serious|energetic|middle.aged/i;
  const male = voices.filter((v) => (v.labels?.gender ?? "").toLowerCase() === "male");
  const score = (v: VoiceInfo) => {
    const text = [v.name, v.description, ...Object.values(v.labels ?? {})].filter(Boolean).join(" ");
    return (v.category === "premade" ? 2 : 0) + (text.match(new RegExp(words, "gi"))?.length ?? 0);
  };
  const best = [...male].sort((a, b) => score(b) - score(a))[0];
  return best ? best.voice_id : null;
}

async function withTimeout(fetchFn: typeof fetch, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetchFn(url, { ...init, signal: ac.signal });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw new Error(`ElevenLabs timed out after ${ms} ms`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** ELEVENLABS_VOICE_ID, else a live lookup, else the docs' example voice. */
export async function resolveElevenVoice(o: ElevenOptions): Promise<string> {
  const fromEnv = o.voiceId ?? process.env.ELEVENLABS_VOICE_ID;
  if (fromEnv) return fromEnv;
  try {
    const r = await withTimeout(o.fetchFn ?? fetch, `${ELEVEN_BASE}/v1/voices`, { headers: { "xi-api-key": o.apiKey } }, o.timeoutMs ?? ELEVEN_TIMEOUT_MS);
    if (r.ok) {
      const j = (await r.json()) as { voices?: VoiceInfo[] };
      const id = pickCoachVoice(j.voices ?? []);
      if (id) return id;
    }
  } catch {
    /* fall through */
  }
  return ELEVEN_DOCS_EXAMPLE_VOICE;
}

/** ElevenLabs as a Synth: text -> WAV (pcm/wav formats) or MP3 bytes. */
export function elevenSynth(o: ElevenOptions): Synth & { voice(): Promise<string> } {
  const fetchFn = o.fetchFn ?? fetch;
  let voiceP: Promise<string> | null = null;
  let fmtIdx = 0; // first format the plan accepted
  const voice = () => (voiceP ??= resolveElevenVoice(o));
  const synth = (async (text: string) => {
    const id = await voice();
    for (let i = fmtIdx; i < ELEVEN_FORMATS.length; i++) {
      const fmt = ELEVEN_FORMATS[i];
      const r = await withTimeout(
        fetchFn,
        `${ELEVEN_BASE}/v1/text-to-speech/${encodeURIComponent(id)}?output_format=${fmt}`,
        {
          method: "POST",
          headers: { "xi-api-key": o.apiKey, "content-type": "application/json", accept: "*/*" },
          body: JSON.stringify({
            text,
            model_id: o.modelId ?? process.env.ELEVENLABS_MODEL_ID ?? ELEVEN_MODEL,
            voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true },
          }),
        },
        o.timeoutMs ?? ELEVEN_TIMEOUT_MS,
      );
      if (r.ok) {
        fmtIdx = i;
        const buf = Buffer.from(await r.arrayBuffer());
        if (fmt.startsWith("pcm")) return pcmToWav(buf, 24000, 1, 16);
        if (fmt.startsWith("wav")) return ensureWav(buf);
        return buf; // mp3
      }
      const body = (await r.text().catch(() => "")).slice(0, 300);
      // Format not allowed on this plan: try the next one. Anything else is a real failure.
      if ([400, 401, 403, 422].includes(r.status) && /format|tier|plan|subscription|upgrade/i.test(body) && i < ELEVEN_FORMATS.length - 1) continue;
      throw new Error(`ElevenLabs ${r.status}: ${body.replace(/\s+/g, " ").slice(0, 120)}`);
    }
    throw new Error("ElevenLabs: no output format accepted");
  }) as Synth & { voice(): Promise<string> };
  synth.voice = voice;
  return synth;
}
