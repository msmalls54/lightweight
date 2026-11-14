// TTS provider chain: Gemini first, ElevenLabs only when Gemini errors or times out.
import type { Synth } from "./tts.js";

export interface TtsStep {
  name: string; // "gemini" | "elevenlabs" | "test"
  synth: Synth;
}

export interface TtsResult {
  wav: Buffer; // WAV, or MP3 bytes when ElevenLabs only allows mp3
  provider: string;
  /** How long the provider that answered took. */
  ms: number;
  /** What failed before it, e.g. "gemini timeout". null when the first provider answered. */
  after: string | null;
}

/** LW_TTS_PROVIDER: auto (default: Gemini, then ElevenLabs) | gemini | elevenlabs (skip Gemini). */
export type TtsMode = "auto" | "gemini" | "elevenlabs";
export function ttsProviderMode(): TtsMode {
  const m = String(process.env.LW_TTS_PROVIDER ?? "auto").trim().toLowerCase();
  return m === "gemini" || m === "elevenlabs" ? m : "auto";
}

export function failureKind(e: unknown): "timeout" | "error" {
  return /timed out|timeout|abort/i.test(String((e as Error)?.message ?? e)) ? "timeout" : "error";
}

/** Steps for a mode. Without an ElevenLabs synth (no key) it's exactly the Gemini path of before. */
export function buildSteps(mode: TtsMode, gemini?: Synth, eleven?: Synth): TtsStep[] {
  const g = gemini ? [{ name: "gemini", synth: gemini }] : [];
  const e = eleven ? [{ name: "elevenlabs", synth: eleven }] : [];
  if (mode === "elevenlabs") return e.length ? e : g;
  if (mode === "gemini") return g.length ? g : e;
  return [...g, ...e];
}

/** Try each provider in order; the first that answers wins. Throws "gemini timeout, elevenlabs error" if all fail. */
export async function runChain(steps: TtsStep[], text: string): Promise<TtsResult> {
  const fails: string[] = [];
  for (const s of steps) {
    const t0 = Date.now();
    try {
      const wav = await s.synth(text);
      return { wav, provider: s.name, ms: Date.now() - t0, after: fails.length ? fails.join(", ") : null };
    } catch (e) {
      fails.push(`${s.name} ${failureKind(e)}`);
    }
  }
  throw new Error(fails.length ? `TTS failed: ${fails.join(", ")}` : "no TTS provider configured");
}
