import { GoogleGenAI } from "@google/genai";
import { TTS_API_VERSION, TTS_FALLBACK_MODELS, TTS_MODEL, VOICE_STYLE, voiceId } from "./models.js";
import { ensureWav, trimSilence } from "./wav.js";

/** text -> WAV bytes. Swappable so tests never hit the network. */
export type Synth = (text: string, opts?: { style?: string }) => Promise<Buffer>;

export interface GeminiSynthOptions {
  apiKey: string;
  models?: string[];
  voice?: string;
  timeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

/** Gemini TTS through the Interactions API. Falls back to the next model on error. */
export function geminiSynth(o: GeminiSynthOptions): Synth {
  const ai = new GoogleGenAI({ apiKey: o.apiKey, httpOptions: { apiVersion: TTS_API_VERSION } });
  const models = o.models ?? [TTS_MODEL, ...TTS_FALLBACK_MODELS];
  const dead = new Set<string>(); // models that 404'd: skip them from now on
  return async (text, opts) => {
    let lastErr: unknown;
    for (const model of models) {
      if (dead.has(model) && model !== models[models.length - 1]) continue;
      try {
        const req = {
          model,
          input: [
            {
              type: "user_input",
              content: [
                {
                  type: "text",
                  text,
                  // 3.1 TTS doesn't take the style annotation either.
                  ...(/3\.1-flash-tts/.test(model) ? {} : { annotations: [{ type: "speech_metadata", style: opts?.style ?? VOICE_STYLE }] }),
                },
              ],
            },
          ],
          // Ask for raw PCM and wrap it ourselves: a header we control. gemini-3.1-flash-tts-preview
          // rejects an explicit mime type (400) but returns audio/l16 24 kHz by default.
          response_format: /3\.1-flash-tts/.test(model) ? { type: "audio" } : { type: "audio", mime_type: "audio/l16" },
          generation_config: { speech_config: [{ voice: o.voice ?? voiceId() }] },
        };
        // Cast: the SDK's interaction param types are a wide union; the shape matches the v1beta docs.
        const r = (await withTimeout(
          ai.interactions.create(req as never) as Promise<unknown>,
          o.timeoutMs ?? 20000,
          `TTS ${model}`,
        )) as { output_audio?: { data?: string; mime_type?: string } };
        const data = r.output_audio?.data;
        if (!data) throw new Error(`TTS ${model} returned no audio`);
        return trimSilence(ensureWav(Buffer.from(data, "base64"), r.output_audio?.mime_type));
      } catch (e) {
        lastErr = e;
        if (/not found|404/i.test(String((e as Error)?.message))) dead.add(model);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };
}
