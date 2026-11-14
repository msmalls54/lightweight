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
/**
 * Live TTS for summaries/answers (speak, /voice/say). Measured Nov 14 ~1:45 pm: flash-tts median 3.3 s
 * (2.5–4.3 s, 6/6 ok) while flash-lite-tts timed out at 20 s 6/6, so summaries try flash first.
 * Clips keep TTS_MODEL (they're cached anyway).
 */
// Nov 14 ~3 pm: both 3.8 TTS models hit the free tier's 100 requests/day (104/100), which showed up as
// timeouts. gemini-3.1-flash-tts-preview has its own daily quota (3/100 used), so it goes first.
export const SAY_TTS_MODELS = ["gemini-3.8-flash-tts", "gemini-3.1-flash-tts-preview", "gemini-3.8-flash-lite-tts"];
/** Per-model timeout for live TTS: fail over fast (the browser voice takes over at 5 s anyway). */
export const SAY_TTS_TIMEOUT_MS = 8000;
/** Spoken part of a summary: Gemini TTS reads only the first sentence, at most this many words. */
export const SPOKEN_FIRST_SENTENCE_MAX_WORDS = 15;
/** TTS only works through `ai.interactions.create` on v1beta (generateContent rejects speechConfig). */
export const TTS_API_VERSION = "v1beta";

/** Prebuilt voice. Mike picked Alnilam ("Firm", quickest delivery) on Nov 14. Others: Algenib = "Gravelly", Orus/Kore = "Firm". */
export const VOICE_NAME = "Alnilam";
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
