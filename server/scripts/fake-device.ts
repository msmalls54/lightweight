// Fake UNO: POSTs synthetic 4-channel ENV batches to /ingest (200 Hz, 40 samples / 200 ms) plus heartbeats.
// Default run: new "fake" session -> calibration (rest + flex each muscle) -> 1 set: clean reps, then swing reps.
//   npx tsx scripts/fake-device.ts                     (both arms, 5 clean + 3 swing)
//   npx tsx scripts/fake-device.ts --arms R --clean 4 --swing 2 --loop
//   npx tsx scripts/fake-device.ts --raw               (stream reps forever, no session/calibration/set calls)
// Flags: --url http://127.0.0.1:3000  --person Mike  --arms RL|R|L  --clean N  --swing N  --loop  --raw  --no-cal
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, def: string) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };

const URL_BASE = opt("url", "http://127.0.0.1:3000").replace(/\/$/, "");
const PERSON = opt("person", "Mike");
const ARMS = (opt("arms", "RL").toUpperCase().match(/[RL]/g) ?? ["R"]) as ("R" | "L")[];
const N_CLEAN = Number(opt("clean", "5"));
const N_SWING = Number(opt("swing", "3"));
const RAW = flag("raw"), LOOP = flag("loop") || RAW, NO_CAL = flag("no-cal") || RAW;

const HZ = 200, DT = 1000 / HZ, PER_BATCH = 40, REST = 550;
const DEVICE = "lw-fake-1";
const T_BASE = Date.now() % 10_000_000; // fake millis(); differs per run so the server's dedupe never drops a new run

type Action = () => Promise<unknown>;
interface Seg { len: number; gen: (k: number) => number[]; before?: Action; after?: Action; label?: string }

const noise = (a = 60) => (Math.random() * 2 - 1) * a;
const clampRaw = (x: number) => Math.max(0, Math.min(16383, Math.round(x)));
const restVals = () => [0, 1, 2, 3].map(() => REST + noise());
const sec = (s: number) => Math.round(s * HZ);

async function post(path: string, body: unknown) {
  const r = await fetch(URL_BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({})) as { ok?: boolean; error?: string };
  if (!r.ok) throw new Error(`${path}: ${r.status} ${j.error ?? ""}`);
  return j;
}
const step = (path: string, body?: unknown): Action => async () => {
  try { const j = await post(path, body); console.log(`  -> ${path} ok`, path === "/calibrate" ? JSON.stringify((j as any).calibration?.problems ?? []) : ""); }
  catch (e) { console.error(`  -> ${(e as Error).message}`); }
};

function rest(seconds: number, extra: Partial<Seg> = {}): Seg { return { len: sec(seconds), gen: () => restVals(), ...extra }; }

function flex(ch: number, seconds = 3.5): Seg {
  const ramp = sec(0.3);
  return {
    len: sec(seconds), label: `flex ch${ch}`,
    gen: k => {
      const v = restVals();
      const e = Math.min(1, k / ramp);
      v[ch] = REST + e * (12800 + noise(300));
      const partner = ch % 2 === 0 ? ch + 1 : ch - 1; // a curl hold lights the delt a little, and vice versa
      v[partner] = REST + e * (ch % 2 === 0 ? 700 : 1400) + noise();
      return v;
    },
  };
}

/** One rep: 1.6 s concentric+eccentric, then 0.7 s at the bottom. */
function rep(kind: "clean" | "swing"): Seg {
  const active = 1.6, total = 2.3;
  const biAmp = kind === "clean" ? 10500 : 7400;
  const deltAmp = kind === "clean" ? 850 : 9800;
  return {
    len: sec(total), label: `${kind} rep`,
    gen: k => {
      const t = k / HZ;
      const e = t < active ? Math.pow(Math.sin((Math.PI * t) / active), 1.5) : 0;
      const tail = t >= active ? 0.04 * Math.exp(-(t - active) / 0.3) : 0; // slow ENV decay after the rep
      const de = kind === "swing" ? Math.pow(Math.sin(Math.min(Math.PI, (Math.PI * t) / (active * 0.85))), 0.8) * (t < active * 0.85 ? 1 : 0) : e;
      const v = restVals();
      if (ARMS.includes("R")) { v[0] = REST + biAmp * (e + tail) + noise(120); v[1] = REST + deltAmp * de + noise(); }
      if (ARMS.includes("L")) { v[2] = REST + 0.85 * biAmp * (e + tail) + noise(120); v[3] = REST + 0.9 * deltAmp * de + noise(); }
      return v;
    },
  };
}

function setSegs(): Seg[] {
  const reps: Seg[] = [];
  for (let i = 0; i < N_CLEAN; i++) reps.push(rep("clean"));
  for (let i = 0; i < N_SWING; i++) reps.push(rep("swing"));
  if (RAW) return [...reps, rest(12)];
  reps[0].before = step("/set/start", { exercise: "dumbbell curl", variant: "standing", load_lb: 35, arms: ARMS, auto_next: false });
  return [rest(1.5), ...reps, rest(11.5, { after: step("/set/stop") })]; // >10 s of rest so the engine auto-ends the set
}

function plan(): Seg[] {
  const segs: Seg[] = [];
  if (!RAW) segs.push(rest(1, { before: step("/session/start", { person: PERSON, walkup: false, kind: "fake", arms: ARMS }) }));
  if (!NO_CAL) {
    segs.push(rest(3.5, { label: "relax", before: step("/calibrate/begin"), after: step("/calibrate/capture", { step: "rest", window_ms: 2500 }) }));
    const chans = ARMS.flatMap(a => (a === "R" ? [0, 1] : [2, 3]));
    for (const ch of chans) {
      segs.push(rest(1.2));
      segs.push({ ...flex(ch), after: step("/calibrate/capture", { step: "mvc", ch, window_ms: 2500 }) });
    }
    segs.push(rest(0.5, { after: step("/calibrate") }));
  }
  segs.push(...setSegs());
  return segs;
}

let seq = 0, sampleIdx = 0, hbSeq = 0, sent = 0, failed = 0;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function sendBatch(rows: number[][]) {
  const ch = [0, 1, 2, 3].map(c => rows.map(r => clampRaw(r[c])));
  const body = { device: DEVICE, seq: seq++, t0_ms: T_BASE + Math.round((sampleIdx - rows.length) * DT), dt_ms: DT, ch };
  try { await post("/ingest", body); sent++; } catch (e) { failed++; if (failed % 25 === 1) console.error(`ingest failed (${failed}x): ${(e as Error).message}`); }
}

async function runPlan(segs: Seg[], t0: number, batchNo: { n: number }) {
  let rows: number[][] = [];
  for (const seg of segs) {
    if (seg.label) console.log(`[fake] ${seg.label}`);
    if (seg.before) await seg.before();
    for (let k = 0; k < seg.len; k++) {
      rows.push(seg.gen(k)); sampleIdx++;
      if (rows.length === PER_BATCH) {
        const wait = t0 + batchNo.n * 200 - performance.now();
        if (wait > 0) await sleep(wait);
        batchNo.n++;
        await sendBatch(rows);
        rows = [];
      }
    }
    if (seg.after) {
      if (rows.length) { await sendBatch(rows); rows = []; } // the window must include this segment's samples
      await seg.after();
    }
  }
  if (rows.length) await sendBatch(rows);
}

async function main() {
  console.log(`[fake] ${URL_BASE} arms=${ARMS.join("+")} clean=${N_CLEAN} swing=${N_SWING}${RAW ? " raw" : ""}${LOOP ? " loop" : ""}`);
  const hb = setInterval(() => {
    post("/heartbeat", { device: DEVICE, seq: hbSeq++, uptime_ms: Math.round(sampleIdx * DT), rssi: -24 - Math.round(Math.random() * 4), queue: 0, fw: "fake-0.1" }).catch(() => {});
  }, 2000);
  const t0 = performance.now(), batchNo = { n: 0 };
  await runPlan(plan(), t0, batchNo);
  while (LOOP) await runPlan(setSegs(), t0, batchNo);
  clearInterval(hb);
  console.log(`[fake] done: ${sent} batches sent, ${failed} failed`);
}
main().catch(e => { console.error(e); process.exit(1); });
