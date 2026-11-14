// ElevenLabs fallback TTS, fetch mocked. No network, no playback.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import {
  buildSteps,
  CLIPS,
  ELEVEN_DOCS_EXAMPLE_VOICE,
  elevenSynth,
  isMp3,
  isWav,
  pcmToWav,
  pickCoachVoice,
  registerVoiceRoutes,
  runChain,
  speakInfo,
  ttsProviderMode,
  voiceLogLine,
  warmVoice,
  _resetVoiceForTests,
  type Synth,
} from "../src/voice/index.js";

const KEY = "sk_test_never_logged";
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lw-eleven-"));
const VOICES = {
  voices: [
    { voice_id: "female1", name: "Sarah", category: "premade", labels: { gender: "female", description: "soft" } },
    { voice_id: "male_calm", name: "Calm", category: "premade", labels: { gender: "male", description: "calm" } },
    { voice_id: "male_coach", name: "Coach", category: "premade", labels: { gender: "male", description: "deep, authoritative" } },
  ],
};

type Call = { url: string; headers: Record<string, string>; body: { text?: string; model_id?: string } | null };
function mockFetch(o: { tts?: (url: string, n: number) => { status: number; body: Buffer | string }; voices?: unknown; hangMs?: number } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const f = (async (url: string, init?: RequestInit & { signal?: AbortSignal }) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (o.hangMs)
      await new Promise((res, rej) => {
        const t = setTimeout(res, o.hangMs);
        init?.signal?.addEventListener("abort", () => (clearTimeout(t), rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      });
    if (url.endsWith("/v1/voices")) return new Response(JSON.stringify(o.voices ?? VOICES), { status: 200 });
    const r = o.tts ? o.tts(url, n++) : { status: 200, body: Buffer.alloc(4800, 1) };
    return new Response(typeof r.body === "string" ? r.body : new Uint8Array(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

test("ElevenLabs request: pcm_24000 -> WAV 24 kHz, xi-api-key header, flash model, coach voice from /v1/voices", async () => {
  delete process.env.ELEVENLABS_VOICE_ID;
  const { f, calls } = mockFetch();
  const synth = elevenSynth({ apiKey: KEY, fetchFn: f });
  const wav = await synth("Rep four. Right shoulder took over.");
  assert.ok(isWav(wav));
  assert.equal(wav.readUInt32LE(24), 24000);
  const tts = calls.find((c) => c.url.includes("/text-to-speech/"))!;
  assert.match(tts.url, /^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/male_coach\?output_format=pcm_24000$/);
  assert.equal(tts.headers["xi-api-key"], KEY);
  assert.equal(tts.body?.model_id, "eleven_flash_v2_5");
  assert.equal(tts.body?.text, "Rep four. Right shoulder took over.");
  assert.equal(await synth.voice(), "male_coach");
});

test("voice id: ELEVENLABS_VOICE_ID wins (no lookup); lookup failure -> the docs' example voice", async () => {
  process.env.ELEVENLABS_VOICE_ID = "env_voice";
  const a = mockFetch();
  await elevenSynth({ apiKey: KEY, fetchFn: a.f })("Hi.");
  assert.ok(!a.calls.some((c) => c.url.endsWith("/v1/voices")));
  assert.match(a.calls[0].url, /text-to-speech\/env_voice\?/);
  delete process.env.ELEVENLABS_VOICE_ID;
  const b = mockFetch({ voices: { voices: [] } });
  await elevenSynth({ apiKey: KEY, fetchFn: b.f })("Hi.");
  assert.match(b.calls.at(-1)!.url, new RegExp(`text-to-speech/${ELEVEN_DOCS_EXAMPLE_VOICE}\\?`));
  assert.equal(pickCoachVoice(VOICES.voices), "male_coach");
});

test("format not allowed on the plan -> wav_24000, then mp3_44100_128 (served as audio/mpeg)", async () => {
  process.env.ELEVENLABS_VOICE_ID = "v";
  const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(100, 7)]);
  const { f, calls } = mockFetch({
    tts: (url) =>
      url.includes("mp3_44100_128")
        ? { status: 200, body: mp3 }
        : { status: 403, body: '{"detail":{"message":"This output format requires a higher subscription tier"}}' },
  });
  const synth = elevenSynth({ apiKey: KEY, fetchFn: f });
  const out = await synth("Same weight, keep going.");
  assert.ok(isMp3(out));
  assert.deepEqual(calls.map((c) => c.url.split("output_format=")[1]), ["pcm_24000", "wav_24000", "mp3_44100_128"]);
  await synth("Again.");
  assert.equal(calls.at(-1)!.url.split("output_format=")[1], "mp3_44100_128"); // sticks
  delete process.env.ELEVENLABS_VOICE_ID;
});

test("errors and timeouts never include the API key", async () => {
  process.env.ELEVENLABS_VOICE_ID = "v";
  const bad = mockFetch({ tts: () => ({ status: 401, body: '{"detail":"invalid api key"}' }) });
  await assert.rejects(elevenSynth({ apiKey: KEY, fetchFn: bad.f })("x"), (e: Error) => /ElevenLabs 401/.test(e.message) && !e.message.includes(KEY));
  const slow = mockFetch({ hangMs: 500 });
  await assert.rejects(elevenSynth({ apiKey: KEY, fetchFn: slow.f, timeoutMs: 50 })("x"), /timed out after 50 ms/);
  delete process.env.ELEVENLABS_VOICE_ID;
});

test("chain: Gemini first; ElevenLabs only when Gemini errors/times out; LW_TTS_PROVIDER; no key = as today", async () => {
  const ok = (name: string): Synth => async () => pcmToWav(Buffer.alloc(480), 24000);
  const timeout: Synth = async () => {
    throw new Error("TTS gemini-3.8-flash-tts timed out after 8000 ms");
  };
  const r = await runChain(buildSteps("auto", timeout, ok("e")), "x");
  assert.equal(r.provider, "elevenlabs");
  assert.equal(r.after, "gemini timeout");
  assert.equal((await runChain(buildSteps("auto", ok("g"), ok("e")), "x")).provider, "gemini");
  assert.deepEqual(buildSteps("elevenlabs", ok("g"), ok("e")).map((s) => s.name), ["elevenlabs"]);
  assert.deepEqual(buildSteps("gemini", ok("g"), ok("e")).map((s) => s.name), ["gemini"]);
  assert.deepEqual(buildSteps("auto", ok("g"), undefined).map((s) => s.name), ["gemini"]); // no key: exactly as before
  assert.deepEqual(buildSteps("elevenlabs", ok("g"), undefined).map((s) => s.name), ["gemini"]);
  await assert.rejects(runChain(buildSteps("auto", timeout, undefined), "x"), /TTS failed: gemini timeout/);
  const old = process.env.LW_TTS_PROVIDER;
  process.env.LW_TTS_PROVIDER = "ElevenLabs";
  assert.equal(ttsProviderMode(), "elevenlabs");
  process.env.LW_TTS_PROVIDER = "x";
  assert.equal(ttsProviderMode(), "auto");
  if (old === undefined) delete process.env.LW_TTS_PROVIDER;
  else process.env.LW_TTS_PROVIDER = old;
  assert.equal(
    voiceLogLine({ set_id: "set-3", tier: "elevenlabs", ms: 1200, reason: "gemini timeout" }),
    "[voice] set set-3: gemini timeout -> elevenlabs 1.2 s",
  );
});

test("/voice/say: Gemini times out -> ElevenLabs answers; x-lw-tts says so", async () => {
  _resetVoiceForTests();
  const failing: Synth = async () => {
    throw new Error("timed out");
  };
  const eleven: Synth = async () => pcmToWav(Buffer.alloc(4800, 1), 24000);
  await warmVoice({ apiKey: "", cacheDir: tmp(), synth: failing, elevenlabs: eleven, keys: [], log: () => {} });
  const app = new Hono();
  registerVoiceRoutes(app);
  const r = await app.request("/voice/say", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Rep four, swing." }) });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("x-lw-tts") ?? "", /^elevenlabs; ms=\d+; after=gemini timeout$/);
  assert.equal((await speakInfo("Rep four, swing.")).provider, "elevenlabs"); // cached with its provider
  _resetVoiceForTests();
});

test("voice:warm: a clip that fails on Gemini is made with ElevenLabs; --provider elevenlabs redoes all; chars counted", async () => {
  _resetVoiceForTests();
  const dir = tmp();
  const geminiFails: Synth = async (t) => {
    if (t === CLIPS.rest_longer) throw new Error("timed out");
    return pcmToWav(Buffer.alloc(4800, 1), 24000);
  };
  const elevenCalls: string[] = [];
  const eleven = Object.assign((async (t: string) => (elevenCalls.push(t), pcmToWav(Buffer.alloc(4800, 2), 24000))) as Synth, {
    voice: async () => "male_coach",
  });
  const keys = ["rep_4", "rest_longer"];
  const r1 = await warmVoice({ apiKey: "", cacheDir: dir, synth: geminiFails, elevenlabs: eleven, keys, attempts: 1, log: () => {} });
  assert.deepEqual(r1.byProvider, { test: 1, elevenlabs: 1 });
  assert.equal(r1.chars.elevenlabs, CLIPS.rest_longer.length);
  const m = JSON.parse(fs.readFileSync(path.join(dir, "clips.json"), "utf8"));
  assert.equal(m.rest_longer.provider, "elevenlabs");
  assert.equal(m.rest_longer.voice, "male_coach");
  assert.equal(m.rep_4.provider, "gemini");
  // A normal run keeps the ElevenLabs clip (no regeneration).
  const r2 = await warmVoice({ apiKey: "", cacheDir: dir, synth: geminiFails, elevenlabs: eleven, keys, attempts: 1, log: () => {} });
  assert.equal(r2.generated, 0);
  // --provider elevenlabs: every clip in the ElevenLabs voice.
  elevenCalls.length = 0;
  const r3 = await warmVoice({ apiKey: "", cacheDir: dir, synth: geminiFails, elevenlabs: eleven, keys, provider: "elevenlabs", attempts: 1, log: () => {} });
  assert.deepEqual(r3.byProvider, { elevenlabs: 1 }); // only rep_4 needed redoing
  assert.deepEqual(elevenCalls, [CLIPS.rep_4]);
  await assert.rejects(
    warmVoice({ apiKey: "", cacheDir: dir, synth: geminiFails, elevenlabs: null, keys, provider: "elevenlabs", log: () => {} }),
    /ELEVENLABS_API_KEY not set/,
  );
  _resetVoiceForTests();
});

test("an MP3 clip/answer is served as audio/mpeg", async () => {
  _resetVoiceForTests();
  const dir = tmp();
  const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(200, 9)]);
  await warmVoice({ apiKey: "", cacheDir: dir, synth: async () => mp3, keys: ["rep_1"], log: () => {} });
  const app = new Hono();
  registerVoiceRoutes(app);
  const r = await app.request("/voice/clip/rep_1.wav");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "audio/mpeg");
  _resetVoiceForTests();
});
