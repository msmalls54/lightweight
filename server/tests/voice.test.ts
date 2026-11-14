import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { CLIPS, initVoice, registerVoiceRoutes, speak, _resetVoiceForTests, type Synth } from "../src/voice/index.js";
import { ensureWav, isWav, pcmToWav, wavDurationMs } from "../src/voice/wav.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lw-voice-"));

/** Fake TTS: 0.1 s of PCM per call, records the texts. */
function fakeSynth(calls: string[], fail = new Set<string>()): Synth {
  return async (text) => {
    calls.push(text);
    if (fail.has(text)) throw new Error("boom");
    return pcmToWav(Buffer.alloc(4800, 1), 24000);
  };
}

test("pcmToWav writes a correct 44-byte PCM header", () => {
  const pcm = Buffer.alloc(48000); // 1 s of 24 kHz mono 16-bit
  const w = pcmToWav(pcm);
  assert.equal(w.length, 44 + 48000);
  assert.equal(w.toString("ascii", 0, 4), "RIFF");
  assert.equal(w.readUInt32LE(4), 36 + 48000);
  assert.equal(w.toString("ascii", 8, 12), "WAVE");
  assert.equal(w.toString("ascii", 12, 16), "fmt ");
  assert.equal(w.readUInt32LE(16), 16);
  assert.equal(w.readUInt16LE(20), 1); // PCM
  assert.equal(w.readUInt16LE(22), 1); // mono
  assert.equal(w.readUInt32LE(24), 24000);
  assert.equal(w.readUInt32LE(28), 48000); // byte rate
  assert.equal(w.readUInt16LE(32), 2); // block align
  assert.equal(w.readUInt16LE(34), 16);
  assert.equal(w.toString("ascii", 36, 40), "data");
  assert.equal(w.readUInt32LE(40), 48000);
  assert.equal(wavDurationMs(w), 1000);
});

test("ensureWav wraps raw l16 and passes WAV through", () => {
  const raw = Buffer.alloc(3200);
  const w = ensureWav(raw, "audio/l16; rate=16000; channels=1");
  assert.ok(isWav(w));
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(wavDurationMs(w), 100);
  const again = ensureWav(w, "audio/wav");
  assert.equal(again, w);
  assert.equal(ensureWav(Buffer.alloc(480)).readUInt32LE(24), 24000); // default rate
});

test("CLIPS has every key BUILD.md requires", () => {
  const need = [
    ...Array.from({ length: 20 }, (_, i) => `rep_${i + 1}`),
    "delt_took_over", "elbows_in", "clean_rep", "slow_it_down", "left_slacking", "right_slacking",
    "set_done", "stop_and_rest", "nice_set", "calibrate_relax", "calibrate_flex",
  ];
  for (const k of need) assert.ok(CLIPS[k]?.length, `missing clip ${k}`);
  assert.equal(CLIPS.rep_6, "Rep six.");
});

test("initVoice generates every clip once, then skips cached ones", async () => {
  _resetVoiceForTests();
  const dir = tmp();
  const calls: string[] = [];
  await initVoice({ apiKey: "x", cacheDir: dir, synth: fakeSynth(calls), log: () => {} });
  assert.equal(calls.length, Object.keys(CLIPS).length);
  for (const k of Object.keys(CLIPS)) assert.ok(isWav(fs.readFileSync(path.join(dir, `${k}.wav`))));
  const calls2: string[] = [];
  await initVoice({ apiKey: "x", cacheDir: dir, synth: fakeSynth(calls2), log: () => {} });
  assert.equal(calls2.length, 0);
});

test("initVoice survives a failing clip and the route regenerates it on demand", async () => {
  _resetVoiceForTests();
  const dir = tmp();
  const calls: string[] = [];
  await initVoice({ apiKey: "x", cacheDir: dir, synth: fakeSynth(calls, new Set([CLIPS.nice_set])), log: () => {} });
  assert.ok(!fs.existsSync(path.join(dir, "nice_set.wav")));
  await initVoice({ apiKey: "x", cacheDir: dir, synth: fakeSynth([]), keys: [], log: () => {} });
  const app = new Hono();
  registerVoiceRoutes(app);
  const r = await app.request("/voice/clip/nice_set.wav");
  assert.equal(r.status, 200);
  assert.ok(fs.existsSync(path.join(dir, "nice_set.wav")));
});

test("voice routes: clip, unknown clip, say, clip list", async () => {
  _resetVoiceForTests();
  const dir = tmp();
  const calls: string[] = [];
  await initVoice({ apiKey: "x", cacheDir: dir, synth: fakeSynth(calls), keys: ["rep_1"], log: () => {} });
  const app = new Hono();
  registerVoiceRoutes(app);

  const clip = await app.request("/voice/clip/rep_1.wav");
  assert.equal(clip.status, 200);
  assert.equal(clip.headers.get("content-type"), "audio/wav");
  assert.ok(isWav(Buffer.from(await clip.arrayBuffer())));

  assert.equal((await app.request("/voice/clip/nope.wav")).status, 404);

  const say = await app.request("/voice/say", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Nice set." }),
  });
  assert.equal(say.status, 200);
  assert.ok(isWav(Buffer.from(await say.arrayBuffer())));
  assert.equal(calls.at(-1), "Nice set.");

  const bad = await app.request("/voice/say", { method: "POST", body: "{}" , headers: { "content-type": "application/json" } });
  assert.equal(bad.status, 400);

  const list = (await (await app.request("/voice/clips")).json()) as { keys: string[] };
  assert.ok(list.keys.includes("delt_took_over"));
});

test("speak caches repeated text", async () => {
  _resetVoiceForTests();
  const calls: string[] = [];
  await initVoice({ apiKey: "x", cacheDir: tmp(), synth: fakeSynth(calls), keys: [], log: () => {} });
  await speak("Same line.");
  await speak("Same line.");
  assert.equal(calls.length, 1);
  await assert.rejects(speak("   "));
});

test("trimSilence cuts padding but keeps a little lead/tail", async () => {
  const { trimSilence } = await import("../src/voice/wav.js");
  const rate = 24000;
  const pcm = Buffer.alloc(rate * 2 * 1); // 1 s: 300 ms silence, 400 ms tone, 300 ms silence
  for (let i = Math.round(rate * 0.3); i < Math.round(rate * 0.7); i++) pcm.writeInt16LE(i % 2 ? 8000 : -8000, i * 2);
  const out = trimSilence(pcmToWav(pcm, rate));
  assert.ok(isWav(out));
  assert.equal(wavDurationMs(out), 400 + 30 + 100);
  const silent = pcmToWav(Buffer.alloc(4800), rate);
  assert.equal(trimSilence(silent), silent);
});
