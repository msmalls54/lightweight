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
  coachText(setId: string, text: string, opts?: { clips?: string[]; mode?: string }): void;
  coachAudio(setId: string, msg: { ok?: boolean; text?: string; spoken?: string; fallback_clip?: string }): Promise<boolean>;
  fallbackMs: number;
  coachSafetyMs: number;
  cooldownMs: number;
  ready: Promise<unknown>;
  isSpeaking(): boolean;
  playElement(el: unknown, opts?: { what?: string; dropIfBusy?: boolean }): Promise<boolean>;
  setEnabled(on: boolean): void;
  setSinkId(id: string): Promise<unknown>;
}

/** Loads voice-player.js with mocks. `sayDelayMs` = how long /voice/say takes. */
function load(o: { sayDelayMs?: number; clipMs?: number; speechMs?: number; sayHeader?: string } = {}) {
  const log: string[] = [];
  const spoken: { text: string; voice?: string; rate?: number }[] = [];
  const sayBodies: string[] = [];
  const voiceLog: { set_id: string; tier: string; ms: number; reason: string | null }[] = [];
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
      if (url.includes("/voice/clip/missing_clip")) return { ok: false, status: 503 };
      if (url.startsWith("/voice/clip/")) return { ok: true, arrayBuffer: async () => ({ clip: url }) };
      if (url === "/voice/log") {
        voiceLog.push(JSON.parse(init?.body ?? "{}"));
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (url === "/voice/say") {
        sayBodies.push(JSON.parse(init?.body ?? "{}").text);
        await sleep(o.sayDelayMs ?? 10);
        return { ok: true, headers: { get: (n: string) => (n === "x-lw-tts" ? o.sayHeader ?? null : null) }, arrayBuffer: async () => ({ say: true }) };
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
  /** A fake <audio> element that "plays" for ms and logs while audible. */
  const element = (name: string, ms = 30) => {
    const el: { duration: number; currentTime: number; onended?: () => void; onerror?: () => void; play(): Promise<void> } = {
      duration: ms / 1000,
      currentTime: 0,
      play() {
        log.push("element:" + name);
        on();
        setTimeout(() => (off(), el.onended?.()), ms);
        return Promise.resolve();
      },
    };
    return el;
  };
  return { A, log, spoken, events, music, minVol, sayBodies, live, element, voiceLog };
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
  assert.ok(events.includes("drop:nice_set:busy pending=1"));
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

test("coachAudio failure -> browser speaks the text it already has", async () => {
  const { A, log } = load();
  A.fallbackMs = 1000;
  A.coachText("set-3", "Every rep clean.");
  assert.equal(await A.coachAudio("set-3", { ok: false, fallback_clip: "nice_set" }), true);
  assert.deepEqual(log, ["browser:Every rep clean."]);
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


test("playElement (countdown / lead-in) goes through the same queue: never over another voice", async () => {
  const { A, log, live, element, minVol } = load({ clipMs: 120 });
  await A.ready;
  const clips = A.playClip(["set_done", "two_cheats"]);
  assert.equal(await A.playElement(element("countdown"), { what: "countdown", dropIfBusy: true }), false); // busy: dropped
  const lead = A.playElement(element("lead_in", 40), { what: "lead_in" }); // waits its turn
  await clips;
  assert.equal(await lead, true);
  assert.deepEqual(log, ["play:set_done", "play:two_cheats", "element:lead_in"]);
  assert.equal(live.max, 1);
  assert.ok(minVol.v < 0.17); // ducked like any voice
});

test("setEnabled(false) (not the speaker tab / stale build): nothing speaks", async () => {
  const { A, log, spoken, element } = load();
  await A.ready;
  A.setEnabled(false);
  assert.equal(await A.say("Same weight, keep going."), false);
  assert.equal(await A.playClip("rep_1"), false);
  assert.equal(await A.playElement(element("countdown")), false);
  A.fallbackMs = 10;
  A.coachText("off", "Every rep clean.");
  await sleep(100);
  assert.deepEqual(log, []);
  assert.equal(spoken.length, 0);
  A.setEnabled(true);
  assert.equal(await A.playClip("rep_1"), true);
});

test("a chosen output device: the browser voice can't be routed there, so text only (no wrong-speaker voice)", async () => {
  const { A, log, events } = load({ sayDelayMs: 300 });
  await A.setSinkId("bt-speaker-id");
  assert.equal(await A.say("Rep five smaller.", { fallbackMs: 20 }), false);
  await sleep(400);
  assert.deepEqual(log, []);
  assert.ok(events.includes("no_route:browser:say"));
});


test("a missing clip in a sequence is skipped; the rest still plays", async () => {
  const { A, log, events } = load();
  await A.ready;
  assert.equal(await A.playClip(["set_done", "missing_clip"]), true);
  assert.deepEqual(log, ["play:set_done"]);
  assert.ok(events.includes("missing:missing_clip"));
  assert.equal(await A.playClip(["missing_clip"]), false);
});





const CLIPS_R82 = ["rep_4", "word_and", "rep_8", "right_shoulder_took_over", "stop_first_cheat_next", "rest_longer"];
const LINE = "Reps 4 and 8: right shoulder at 9 and 7 times normal, that's a swing.";
const FULL = LINE + " Next set, stop at the first cheat.";

test("Gemini is waited for: audio 600 ms late still plays, no clip/browser race; tier logged", async () => {
  const { A, log, live, events, voiceLog, sayBodies } = load({ sayDelayMs: 1 });
  assert.equal(A.coachSafetyMs, 45000);
  A.coachText("w1", FULL, { clips: CLIPS_R82 });
  assert.ok(events.includes("voice_wait:coach:w1")); // dashboard: "Coach is thinking..."
  await sleep(600);
  await A.coachAudio("w1", { ok: true, text: FULL, spoken: LINE });
  await A.coachAudio("w1", { ok: true, text: FULL }); // duplicate: dropped
  await sleep(200);
  assert.deepEqual(log, ["play:gemini-say"]);
  assert.deepEqual(sayBodies, [LINE]); // first sentence only
  assert.ok(!events.some((e) => e.startsWith("fallback")));
  assert.equal(live.max, 1);
  assert.equal(voiceLog[0].tier, "gemini");
  assert.ok(voiceLog[0].ms >= 590);
});

test("REPRO live bug: coach text at t0, Gemini audio at t0+5.1 s -> exactly one voice", async () => {
  const { A, log, live, sayBodies } = load({ sayDelayMs: 1, clipMs: 900, speechMs: 300 });
  await A.ready;
  A.playClip(["set_done", "three_cheats"]);
  A.coachText("set-x", FULL, { clips: CLIPS_R82 });
  A.coachText("set-x", FULL, { clips: CLIPS_R82 });
  await sleep(5100);
  await A.coachAudio("set-x", { ok: true, text: FULL, spoken: LINE });
  await A.coachAudio("set-x", { ok: true, text: FULL });
  await sleep(600);
  assert.deepEqual(log, ["play:set_done", "play:three_cheats", "play:gemini-say"]);
  assert.equal(sayBodies.length, 1);
  assert.equal(live.max, 1);
});

test("Gemini failed on the server (coach_audio ok:false) -> the stitched clips; logged with the reason", async () => {
  const { A, log, live, voiceLog } = load({ clipMs: 10 });
  A.coachText("f1", FULL, { clips: CLIPS_R82 });
  await sleep(50);
  await A.coachAudio("f1", { ok: false, error: "timeout" } as never);
  await sleep(500);
  assert.deepEqual(log, CLIPS_R82.map((k) => "play:" + k));
  assert.equal(live.max, 1);
  assert.equal(voiceLog[0].tier, "clips");
  assert.equal(voiceLog[0].reason, "gemini failed (timeout)");
});

test("Gemini failed and the clips are missing -> browser voice (first sentence)", async () => {
  const { A, log, voiceLog } = load();
  A.coachText("f2", FULL, { clips: ["missing_clip"] });
  await A.coachAudio("f2", { ok: false });
  await sleep(500);
  assert.deepEqual(log, ["browser:" + LINE]);
  assert.equal(voiceLog[0].tier, "browser");
});

test("no coach_audio at all -> backup only after the 45 s safety net", async () => {
  const { A, log } = load({ clipMs: 10 });
  A.coachSafetyMs = 300;
  A.coachText("s1", FULL, { clips: ["rep_4", "rest_longer"] });
  await sleep(200);
  assert.deepEqual(log, []); // still waiting for Gemini
  await sleep(700);
  assert.deepEqual(log, ["play:rep_4", "play:rest_longer"]);
});

test("LW_SUMMARY_VOICE=clips -> clips right away, Gemini audio ignored; no text -> clips", async () => {
  const a = load({ sayDelayMs: 1, clipMs: 10 });
  a.A.coachText("c1", FULL, { clips: ["rep_4", "right_shoulder_took_over"], mode: "clips" });
  await sleep(10);
  assert.equal(await a.A.coachAudio("c1", { ok: true, text: FULL }), false);
  await sleep(300);
  assert.deepEqual(a.log, ["play:rep_4", "play:right_shoulder_took_over"]);
  assert.equal(a.voiceLog[0].reason, "forced by LW_SUMMARY_VOICE=clips");
  const b = load({ clipMs: 10 });
  b.A.coachText("n1", "", { clips: ["same_weight_keep_going"] });
  await sleep(300);
  assert.deepEqual(b.log, ["play:same_weight_keep_going"]);
});

test("set-end clips, then (Gemini failed) the clip summary: in order, never overlapping", async () => {
  const { A, log, live } = load({ clipMs: 40 });
  await A.ready;
  A.playClip(["set_done", "two_cheats"]);
  A.coachText("o1", FULL, { clips: ["rep_4", "rest_longer"] });
  A.coachAudio("o1", { ok: false });
  await sleep(1800);
  assert.deepEqual(log, ["play:set_done", "play:two_cheats", "play:rep_4", "play:rest_longer"]);
  assert.equal(live.max, 1);
});

test("a queued Gemini line waits behind a long browser line; identical line twice -> once", async () => {
  const { A, log, live } = load({ sayDelayMs: 1, clipMs: 200, speechMs: 2000 });
  await A.ready;
  A.coachText("z", "Every rep clean.");
  A.coachAudio("z", { ok: false }); // browser voice, runs 2 s
  await sleep(300);
  const p1 = A.say("Twenty-nine of forty reps clean so far.");
  const p2 = A.say("Twenty-nine of forty reps clean so far.");
  assert.equal(await p2, false);
  await p1;
  assert.deepEqual(log, ["browser:Every rep clean.", "play:gemini-say"]);
  assert.equal(live.max, 1);
});


test("backup with only rep-number clips cached is not a sentence -> browser voice instead", async () => {
  const { A, log } = load();
  A.coachText("r1", FULL, { clips: ["rep_4", "word_and", "rep_8", "missing_clip"] });
  await A.coachAudio("r1", { ok: false });
  await sleep(500);
  assert.deepEqual(log, ["browser:" + LINE]);
});


test("server fell back to ElevenLabs (x-lw-tts) -> the set's tier is logged as elevenlabs after gemini timeout", async () => {
  const { A, log, voiceLog } = load({ sayDelayMs: 1, sayHeader: "elevenlabs; ms=1200; after=gemini timeout" });
  A.coachText("e1", FULL, { clips: CLIPS_R82 });
  await A.coachAudio("e1", { ok: true, text: FULL, spoken: LINE });
  await sleep(300);
  assert.deepEqual(log, ["play:gemini-say"]); // the server's audio (ElevenLabs-made), one voice
  assert.deepEqual(voiceLog[0], { set_id: "e1", tier: "elevenlabs", ms: 1200, reason: "gemini timeout" });
});
