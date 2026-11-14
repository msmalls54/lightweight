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
  coachAudio(setId: string, msg: { ok?: boolean; text?: string; spoken?: string; fallback_clip?: string }): Promise<boolean>;
  fallbackMs: number;
  cooldownMs: number;
  ready: Promise<unknown>;
  isSpeaking(): boolean;
}

/** Loads voice-player.js with mocks. `sayDelayMs` = how long /voice/say takes. */
function load(o: { sayDelayMs?: number; clipMs?: number; speechMs?: number } = {}) {
  const log: string[] = [];
  const spoken: { text: string; voice?: string; rate?: number }[] = [];
  const sayBodies: string[] = [];
  // How many voices are audible at once (Web Audio sources + browser utterances); must never exceed 1.
  const live = { now: 0, max: 0 };
  const on = () => { live.now++; live.max = Math.max(live.max, live.now); };
  const off = () => { live.now--; };
  const synth = { speaking: null as null | { onend?: () => void; timer: ReturnType<typeof setTimeout> } };
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
    fetch: async (url: string, init?: { body?: string }) => {
      if (url === "/voice/clips") return { ok: true, json: async () => ({ keys: ["set_done", "two_cheats", "rep_1", "nice_set"] }) };
      if (url.startsWith("/voice/clip/")) return { ok: true, arrayBuffer: async () => ({ clip: url }) };
      if (url === "/voice/say") {
        sayBodies.push(JSON.parse(init?.body ?? "{}").text);
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
            on();
            setTimeout(() => (off(), src.onended?.()), o.clipMs ?? 20);
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
      cancel() {
        // Real browsers stop the current utterance on cancel().
        if (synth.speaking) { clearTimeout(synth.speaking.timer); const u = synth.speaking; synth.speaking = null; off(); u.onend?.(); }
      },
      speak(u: { text: string; voice?: { name: string }; rate?: number; onend?: () => void }) {
        spoken.push({ text: u.text, voice: u.voice?.name, rate: u.rate });
        log.push("browser:" + u.text);
        on();
        const entry = { onend: u.onend, timer: setTimeout(() => { if (synth.speaking === entry) { synth.speaking = null; off(); } u.onend?.(); }, o.speechMs ?? 20) };
        synth.speaking = entry;
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
  return { A, log, spoken, events, music, minVol, sayBodies, live };
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
  a.A.coachText("s1", line);
  await a.A.coachAudio("s1", { ok: true, text: line });
  assert.deepEqual(a.sayBodies, ["Reps 4 and 8: right shoulder at 9 times normal, that's a swing."]);
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


test("REPRO live bug: coach text at t0, Gemini audio at t0+5.1 s -> exactly one voice (7 s clock)", async () => {
  const line = "Reps 6, 7, and 9: mild cheats, shoulders at 1 to 2 times normal. Next set, stop at the first cheat and rest longer.";
  const { A, log, live, sayBodies } = load({ sayDelayMs: 1, clipMs: 900, speechMs: 300 });
  await A.ready;
  assert.equal(A.fallbackMs, 7000);
  A.playClip(["set_done", "three_cheats"]); // instant set-end clips, still playing when the text lands
  A.coachText("set-x", line); // t0
  A.coachText("set-x", line); // a duplicate event must not start a second clock
  await sleep(5100);
  await A.coachAudio("set-x", { ok: true, text: line, spoken: "Reps 6, 7, and 9: mild cheats, shoulders at 1 to 2 times normal." });
  await A.coachAudio("set-x", { ok: true, text: line }); // a duplicate audio event is dropped too
  await sleep(2600); // past the 7 s mark: no browser voice may start
  assert.deepEqual(log, ["play:set_done", "play:three_cheats", "play:gemini-say"]);
  assert.equal(sayBodies.length, 1);
  assert.equal(live.max, 1);
});

test("Gemini audio later than the clock -> browser only, late audio dropped, never two voices", async () => {
  const { A, log, live, events } = load({ sayDelayMs: 1, speechMs: 50 });
  A.fallbackMs = 120;
  A.coachText("set-y", "All 3 reps clean, shoulder in its normal range.");
  await sleep(200);
  assert.equal(await A.coachAudio("set-y", { ok: true, text: "All 3 reps clean, shoulder in its normal range." }), false);
  await sleep(800);
  assert.deepEqual(log, ["browser:All 3 reps clean, shoulder in its normal range."]);
  assert.ok(events.includes("skip_late:coach:set-y"));
  assert.equal(live.max, 1);
});

test("anything that arrives while a voice plays waits; stray browser speech is cancelled first", async () => {
  const { A, log, live } = load({ sayDelayMs: 1, clipMs: 200, speechMs: 2000 });
  await A.ready;
  A.fallbackMs = 30;
  A.coachText("set-z", "Every rep clean."); // browser voice at 30 ms, would run 2 s
  await sleep(300);
  const p1 = A.say("Twenty-nine of forty reps clean so far."); // Gemini line queued behind it
  const p2 = A.say("Twenty-nine of forty reps clean so far."); // identical line twice: spoken once
  assert.equal(await p2, false);
  await p1;
  assert.deepEqual(log, ["browser:Every rep clean.", "play:gemini-say"]);
  assert.equal(live.max, 1);
});
