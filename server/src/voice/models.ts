// The ONE place for Gemini model IDs and voice settings (voice + coach brain).
// Checked Nov 14 with our key: `ai.models.list()` lists `models/gemini-4-hydrogen`;
// the TTS models don't show in the listing but answer on the v1beta Interactions API.

/** Coach brain: Gemini 4 Hydrogen (text). Fallbacks are tried in order if it errors. */
export const BRAIN_MODEL = "gemini-4-hydrogen";
export const BRAIN_FALLBACK_MODELS = ["gemini-3.8-flash"];
/** Hydrogen thinks by default (~3.5–8 s per answer); LOW cuts that to ~2.6–3 s. MINIMAL is rejected. */
export const BRAIN_THINKING_LEVEL = "LOW";

/** Voice: low-latency TTS first, higher fidelity as fallback. */
export const TTS_MODEL = "gemini-3.8-flash-lite-tts";
export const TTS_FALLBACK_MODELS = ["gemini-3.8-flash-tts"];
/** TTS only works through `ai.interactions.create` on v1beta (generateContent rejects speechConfig). */
export const TTS_API_VERSION = "v1beta";

/** Prebuilt voice. Algenib = "Gravelly": sounds most like a gym coach. Others: Orus/Alnilam/Kore = "Firm". */
export const VOICE_NAME = "Algenib";
/**
 * Hook for a custom/replicated voice later: set this (or env LW_VOICE_ID) to a stored voice
 * name and it is sent instead of VOICE_NAME.
 */
export const CUSTOM_VOICE_ID: string | null = null;
/** Style annotation sent with every line. */
export const VOICE_STYLE = "blunt gym coach, loud and punchy, short and confident, no hesitation";

/** Raw PCM from Gemini TTS: 24 kHz, mono, 16-bit signed little-endian. */
export const TTS_SAMPLE_RATE = 24000;

export function voiceId(): string {
  return process.env.LW_VOICE_ID || CUSTOM_VOICE_ID || VOICE_NAME;
}
