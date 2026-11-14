// voice-player.js in a sandbox: mocked fetch, Web Audio and speechSynthesis. Nothing plays.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const SRC = fs.readFileSync(new URL("../public/voice-player.js", import.meta.url), "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Player {
  setMusic(el: { volume: number }): void;
  playClip(k: string | string[]): Promise<boolean>;
  say(text: string, opts?: { fallbackMs?: number }): Promise<boolean>;
  coachText(setId: string, text: string): void;
  coachAudio(setId: string, msg: { ok?: boolean; text?: string; fallback_clip?: string }): Promise<boolean>;
  fallbackMs: number;
  cooldownMs: number;
  ready: Promise<unknown>;
  isSpeaking(): boolean;
}

/** Loads voice-player.js with mocks. `sayDelayMs` = how long /voice/say takes. */
function load(o: { sayDelayMs?: number; clipMs?: number; speechMs?: number } = {}) {
  const log: string[] = [];
  const spoken: { text: string; voice?: string; rate?: number }[] = [];
  const music = { volume: 0.8 };
  const minVol = { v: 1 };
  const sandbox: Record<string, unknown> = {
    console,
    setTimeout,
    clearTimeout,
    setInterval: (fn: () => void, ms: number) =>
      setInterval(() => {
        fn();
        minVol.v = Math.min(minVol.v, music.volume);
      }, ms),
    clearInterval,
    performance,
    Promise,
    JSON,
    Date,
    Math,
    document: { readyState: "complete", addEventListener() {} },
    CustomEvent: class {
      detail: unknown;
      constructor(_t: string, i: { detail: unknown }) {
        this.detail = i.detail;
      }
    },
    fetch: async (url: string) => {
      if (url === "/voice/clips") return { ok: true, json: async () => ({ keys: ["set_done", "two_cheats", "rep_1", "nice_set"] }) };
      if (url.startsWith("/voice/clip/")) return { ok: true, arrayBuffer: async () => ({ clip: url }) };
      if (url === "/voice/say") {
        await sleep(o.sayDelayMs ?? 10);
        return { ok: true, arrayBuffer: async () => ({ say: true }) };
      }
      return { ok: false, status: 404 };
    },
    AudioContext: class {
      state = "running";
      destination = {};
      decodeAudioData(buf: { clip?: string; say?: boolean }, ok: (b: unknown) => void) {
        ok({ name: buf.clip ? buf.clip.replace(/^.*\/|\.wav$/g, "") : "gemini-say" });
      }
      createBufferSource() {
        const src: { buffer?: { name: string }; onended?: () => void; connect(): void; start(): void } = {
          connect() {},
          start() {
            log.push("play:" + src.buffer!.name);
            setTimeout(() => src.onended?.(), o.clipMs ?? 20);
          },
        };
        return src;
      }
      resume() {
        return Promise.resolve();
      }
    },
    speechSynthesis: {
      getVoices: () => [
        { name: "Microsoft Zira - English (United States)", lang: "en-US" },
        { name: "Microsoft David - English (United States)", lang: "en-US" },
        { name: "Google UK English Female", lang: "en-GB" },
      ],
      cancel() {},
      speak(u: { text: string; voice?: { name: string }; rate?: number; onend?: () => void }) {
        spoken.push({ text: u.text, voice: u.voice?.name, rate: u.rate });
        log.push("browser:" + u.text);
        setTimeout(() => u.onend?.(), o.speechMs ?? 20);
      },
    },
    SpeechSynthesisUtterance: class {
      text: string;
      constructor(t: string) {
        this.text = t;
      }
    },
  };
  const events: string[] = [];
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.dispatchEvent = (e: { detail: { type: string; what: string } }) => events.push(`${e.detail.type}:${e.detail.what}`);
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const A = sandbox.LWAudio as Player;
  A.setMusic(music);
  return { A, log, spoken, events, music, minVol };
}

test("playClip ducks music to 20% and restores it", async () => {
  const { A, log, music, minVol } = load();
  await A.ready;
  assert.equal(await A.playClip(["rep_1"]), true);
  assert.deepEqual(log, ["play:rep_1"]);
  assert.ok(Math.abs(minVol.v - 0.16) < 0.01, String(minVol.v));
  assert.equal(music.volume, 0.8);
});

test("call-outs inside the cooldown are dropped; set-end sequences wait instead", async () => {
  const { A, log, events } = load({ clipMs: 60 });
  await A.ready;
  const first = A.playClip("rep_1");
  assert.equal(await A.playClip("nice_set"), false); // busy -> dropped
  const end = A.playClip(["set_done", "two_cheats"]); // waits for rep_1
  await first;
  assert.equal(await end, true);
  assert.deepEqual(log, ["play:rep_1", "play:set_done", "play:two_cheats"]);
  assert.ok(events.includes("drop:nice_set"));
});

test("say(): Gemini audio in time -> plays it, no browser voice", async () => {
  const { A, log, spoken } = load({ sayDelayMs: 10 });
  assert.equal(await A.say("Same weight, keep going.", { fallbackMs: 200 }), true);
  assert.deepEqual(log, ["play:gemini-say"]);
  assert.equal(spoken.length, 0);
});

test("say(): Gemini audio late -> browser voice (en-US male, rate 1.05), late audio never plays", async () => {
  const { A, log, spoken, events, music, minVol } = load({ sayDelayMs: 150 });
  assert.equal(await A.say("Reps 4 and 8: right shoulder at 8 times normal.", { fallbackMs: 40 }), true);
  await sleep(200); // the Gemini audio arrives after the fallback
  assert.deepEqual(log, ["browser:Reps 4 and 8: right shoulder at 8 times normal."]);
  assert.equal(spoken[0].voice, "Microsoft David - English (United States)");
  assert.equal(spoken[0].rate, 1.05);
  assert.ok(events.includes("fallback:say") && events.includes("skip_late:say"));
  assert.ok(minVol.v < 0.17); // ducked for the browser voice too
  assert.equal(music.volume, 0.8);
});

test("coachText + coachAudio in time -> Gemini audio only", async () => {
  const { A, log, spoken } = load({ sayDelayMs: 5 });
  A.fallbackMs = 100;
  A.coachText("set-1", "All 3 reps clean.");
  await sleep(20);
  assert.equal(await A.coachAudio("set-1", { ok: true, text: "All 3 reps clean." }), true);
  await sleep(150); // past the old deadline: nothing else plays
  assert.deepEqual(log, ["play:gemini-say"]);
  assert.equal(spoken.length, 0);
});

test("coachText, no coachAudio within fallbackMs -> browser speaks; late coachAudio is skipped", async () => {
  const { A, log, events } = load({ sayDelayMs: 5 });
  A.fallbackMs = 40;
  A.coachText("set-2", "From rep 6 on, your right shoulder took over.");
  await sleep(120);
  assert.equal(await A.coachAudio("set-2", { ok: true, text: "From rep 6 on, your right shoulder took over." }), false);
  await sleep(700); // duck (150 ms) + speech + restore (400 ms)
  assert.deepEqual(log, ["browser:From rep 6 on, your right shoulder took over."]);
  assert.ok(events.includes("skip_late:coach:set-2"));
});

test("coachAudio failure -> browser speaks the text it already has", async () => {
  const { A, log } = load();
  A.fallbackMs = 1000;
  A.coachText("set-3", "Every rep clean.");
  assert.equal(await A.coachAudio("set-3", { ok: false, fallback_clip: "nice_set" }), true);
  assert.deepEqual(log, ["browser:Every rep clean."]);
});

test("voices never overlap: set-end clips, then the browser line", async () => {
  const { A, log } = load({ clipMs: 50, speechMs: 30 });
  await A.ready;
  A.fallbackMs = 10;
  const clips = A.playClip(["set_done", "two_cheats"]);
  A.coachText("set-4", "Two cheats.");
  await clips;
  await sleep(900);
  assert.deepEqual(log, ["play:set_done", "play:two_cheats", "browser:Two cheats."]);
});

test("coach lines: only the first sentence is spoken (Gemini and browser), full text stays on screen", async () => {
  const line = "Reps 4 and 8: right shoulder at 9 times normal, that's a swing. Rep 5 smaller. Next set, stop at the first cheat.";
  const a = load({ sayDelayMs: 5 });
  const said: string[] = [];
  const realSay = a.A.say.bind(a.A);
  a.A.say = (t: string, o?: { fallbackMs?: number }) => (said.push(t), realSay(t, o));
  a.A.coachText("s1", line);
  await a.A.coachAudio("s1", { ok: true, text: line });
  assert.deepEqual(said, ["Reps 4 and 8: right shoulder at 9 times normal, that's a swing."]);
  const b = load();
  b.A.fallbackMs = 20;
  b.A.coachText("s2", line);
  await sleep(400);
  assert.deepEqual(b.spoken.map((x) => x.text), ["Reps 4 and 8: right shoulder at 9 times normal, that's a swing."]);
});

test("spokenPart is the same in the browser and on the server", async () => {
  const { spokenPart } = await import("../src/voice/index.js");
  const { A } = load();
  const js = (A as unknown as { spokenPart(t: string): string }).spokenPart;
  for (const t of [
    "All 3 reps clean, shoulder in its normal range. Same groove: elbows pinned, squeeze at the top.",
    "From rep 6 on, your right shoulder took over, 8 to 12 times normal, and it never came back down after that point. Next set.",
    "One sentence without a period",
    "Reps 4, 5 and 8: your right shoulder did the work on every one of those reps today, that is a swing, plain and simple.",
    "",
  ]) {
    assert.equal(js(t), spokenPart(t), t);
    assert.ok(spokenPart(t).split(/\s+/).filter(Boolean).length <= 15, spokenPart(t));
  }
  assert.equal(spokenPart("From rep 6 on, your right shoulder took over, 8 to 12 times normal, and it never came back down after that point. Next set."),
    "From rep 6 on, your right shoulder took over, 8 to 12 times normal.");
});
