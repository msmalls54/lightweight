// Coalesced /ingest (firmware fix, Nov 14): several 40-sample batches in one POST, resends and overlaps
// deduped by device time, fed to the engine in order, stored so replay still works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { Store } from "../src/store.js";
import { Hub } from "../src/hub.js";
import { Pipeline, trimIngested, updateLag, type LagWindow } from "../src/pipeline.js";
import { addGuard, addReceiver } from "../src/receiver.js";

const DT = 5;
const sig = (i: number, c: number) => 600 + ((i * 7 + c * 13) % 50); // sample value from its global index
function post(seq: number, firstSample: number, n: number, nBatches?: number) {
  const ch = [0, 1, 2, 3].map(c => Array.from({ length: n }, (_, k) => sig(firstSample + k, c)));
  return { device: "lw-uno-test", seq, t0_ms: 10_000 + firstSample * DT, dt_ms: DT, ch, ...(nBatches ? { n_batches: nBatches } : {}) };
}

test("trimIngested: new, full resend, partial overlap (seq advances by whole batches), device reboot", () => {
  const b = post(10, 400, 400, 10); // samples 400..799, t0 12000, end 14000
  assert.equal(trimIngested(b, null).batch, b);
  assert.equal(trimIngested(b, 14_000).batch, null); // already have all of it
  const t = trimIngested(b, 13_000).batch!; // have up to sample 599
  assert.equal(t.ch[0].length, 200);
  assert.equal(t.t0_ms, 13_000);
  assert.equal(t.seq, 15); // 200 skipped = 5 batches of 40
  assert.deepEqual(t.ch[1].slice(0, 3), [sig(600, 1), sig(601, 1), sig(602, 1)]);
  const reboot = trimIngested(post(0, 0, 40), 500_000);
  assert.equal(reboot.reset, true);
  assert.equal(reboot.batch!.ch[0].length, 40);
});

test("/ingest: coalesced POSTs up to 400 samples, a repeated or overlapping POST never feeds samples twice", async () => {
  const store = new Store(":memory:");
  const hub = new Hub();
  const sent: { type: string; t_ms?: number }[] = [];
  hub.send = (e: object) => { sent.push(e as { type: string }); };
  const pipeline = new Pipeline(store, hub);
  const app = new Hono();
  addGuard(app);
  addReceiver(app, pipeline);
  const send = async (body: unknown) => {
    const r = await app.request("/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as { ok?: boolean; duplicate?: boolean; error?: string } };
  };

  assert.deepEqual((await send(post(0, 0, 400, 10))).json, { ok: true, duplicate: false }); // samples 0..399
  assert.deepEqual((await send(post(10, 400, 400, 10))).json, { ok: true, duplicate: false }); // 400..799
  assert.deepEqual((await send(post(10, 400, 400, 10))).json, { ok: true, duplicate: true }); // the same POST again
  assert.deepEqual((await send(post(15, 600, 400, 10))).json, { ok: true, duplicate: false }); // 600..999: only 800..999 new
  assert.deepEqual((await send(post(25, 1000, 40))).json, { ok: true, duplicate: false }); // a plain 40-sample batch still works
  const big = await send(post(26, 1040, 2000, 50)); // the largest allowed body (~50 KB) passes the body limit
  assert.equal(big.status, 200, big.json.error);

  // Stored in order, contiguous, every sample exactly once.
  const sid = pipeline.active!.id;
  const rows = store.batchesFor(sid).map(r => r.batch);
  assert.deepEqual(rows.map(b => b.t0_ms), [10_000, 12_000, 14_000, 15_000, 15_200]);
  const all = rows.flatMap(b => b.ch[2]);
  assert.equal(all.length, 3040);
  assert.ok(all.every((v, i) => v === sig(i, 2)), "stored samples are exactly the original signal");

  // The engine saw them in order: live frames strictly increasing in device time, covering the whole span.
  const live = sent.filter(e => e.type === "live").map(e => e.t_ms!);
  assert.ok(live.length > 50);
  assert.ok(live.every((t, i) => i === 0 || t > live[i - 1]), "live frames in order");
  assert.ok(live[live.length - 1] >= 10_000 + 3000 * DT);

  // Header lag: the device's newest sample vs receive time, relative to the best seen (all sent at once here).
  const st = pipeline.status() as { device: { lag_ms: number | null; batches_per_s: number; streaming: boolean } };
  assert.equal(typeof st.device.lag_ms, "number");
  // Rate counts samples, not POSTs: 3040 samples in the 5 s window = 76 batches of 40 = 15.2/s.
  assert.equal(st.device.batches_per_s, 15.2);
  assert.equal(st.device.streaming, true);
});

test("/heartbeat: firmware 0.2.0 delivery stats are accepted and shown in status", async () => {
  const store = new Store(":memory:");
  const hub = new Hub();
  hub.send = () => {};
  const pipeline = new Pipeline(store, hub);
  const app = new Hono();
  addGuard(app);
  addReceiver(app, pipeline);
  const hb = { device: "lw-uno-test", uptime_ms: 120000, rssi: -24, queue: 3, fw: "0.2.0", dropped: 0, post_rtt_ms: 140, post_rtt_max_ms: 610, coalesce_max: 8, posts: 300, batches: 1500 };
  const r = await app.request("/heartbeat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(hb) });
  assert.equal(r.status, 200);
  const bad = await app.request("/heartbeat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...hb, post_rtt_ms: -1 }) });
  assert.equal(bad.status, 400);
  const h = (pipeline.status() as { device: { heartbeat: Record<string, unknown> } }).device.heartbeat;
  assert.deepEqual({ dropped: h.dropped, post_rtt_ms: h.post_rtt_ms, post_rtt_max_ms: h.post_rtt_max_ms, coalesce_max: h.coalesce_max, fw: h.fw },
    { dropped: 0, post_rtt_ms: 140, post_rtt_max_ms: 610, coalesce_max: 8, fw: "0.2.0" });
});

// Nov 14 23:35: boot 6 ran 36 s, the board rebooted (boot 7: seq 7,000,000, clock back to ~0). The clock
// went back less than the old 60 s rule, so every POST was trimmed as "already seen" until a server restart.
test("a board reboot recovers by itself: fresh session, engine fed again, no duplicates", () => {
  const store = new Store(":memory:");
  const hub = new Hub();
  const sent: { type: string; t_ms?: number; session_id?: string }[] = [];
  hub.send = (e: object) => { sent.push(e as { type: string }); };
  const pipeline = new Pipeline(store, hub);
  const mk = (seq: number, t0: number, k: number) => ({ device: "lw-uno-1", seq, t0_ms: t0, dt_ms: 5, n_batches: k,
    ch: [0, 1, 2, 3].map(c => Array.from({ length: 40 * k }, (_, i) => 600 + ((i + c) % 30))) });
  // boot 6: 36 s of data, 8 batches per POST
  for (let i = 0; i < 180; i += 8) assert.equal(pipeline.ingest(mk(6_000_000 + i, 60 + i * 200, 8)).duplicate, false);
  const first = pipeline.active!.id;
  // a resend of the last POST is still a duplicate
  assert.equal(pipeline.ingest(mk(6_000_176, 60 + 176 * 200, 8)).duplicate, true);
  // boot 7: seq jumps, clock restarts at ~20 s (less than boot 6's 36 s)
  sent.length = 0;
  const r = pipeline.ingest(mk(7_000_000, 20_060, 8));
  assert.equal(r.duplicate, false, "first POST after the reboot is accepted");
  const second = pipeline.active!.id;
  assert.notEqual(second, first, "a fresh session after the reboot");
  assert.ok(sent.some(e => e.type === "session" && e.session_id === second));
  for (let i = 8; i < 40; i += 8) assert.equal(pipeline.ingest(mk(7_000_000 + i, 20_060 + i * 200, 8)).duplicate, false);
  const live = sent.filter(e => e.type === "live").map(e => e.t_ms!);
  assert.ok(live.length > 20 && live[0] >= 20_060 && live.every((t, i) => i === 0 || t > live[i - 1]), "engine runs on the new clock");
  assert.equal((pipeline.status() as { device: { streaming: boolean } }).device.streaming, true);
  assert.equal(store.batchesFor(second).length, 5);
  // a resend inside boot 7 is still deduped
  assert.equal(pipeline.ingest(mk(7_000_032, 20_060 + 32 * 200, 8)).duplicate, true);
});

test("trimIngested: reboot rules (seq forward + clock back, old firmware seq restart, clock far back)", () => {
  const b = (seq: number, t0: number) => ({ device: "d", seq, t0_ms: t0, dt_ms: 5, ch: [[1], [1], [1], [1]].map(() => Array(40).fill(600)) });
  assert.equal(trimIngested(b(7_000_000, 20_000), 36_460, 6_000_181).reset, true); // 0.2.0 reboot, short boot
  assert.equal(trimIngested(b(6_000_181, 36_260), 36_460, 6_000_181).batch, null); // resend of the last batch
  assert.equal(trimIngested(b(6_000_182, 36_459), 36_460, 6_000_181).reset, false); // next batch, 1 ms millis jitter
  assert.equal(trimIngested(b(0, 100), 100_000, 499).reset, true); // old firmware: seq back to 0
  assert.equal(trimIngested(b(450, 92_000), 100_000, 499).batch, null); // a queued resend 8 s back is not a reboot
  assert.equal(trimIngested(b(10, 1_000), 30_000, 140).reset, true); // clock 29 s back
});

test("lag baseline is a sliding window: clock drift stays near 0, a real 3 s backlog shows ~3 s", () => {
  // 30 min at 5 POSTs/s, the device clock running 50 ms/min slow vs the laptop (offset grows 1.5 s total).
  const win: LagWindow = [];
  let lag = 0;
  for (let ms = 0; ms <= 30 * 60_000; ms += 200) lag = updateLag(win, 50 + (ms / 60_000) * 50 + (ms % 1000 === 0 ? 30 : 0), 1_000_000 + ms);
  assert.ok(lag < 150, `drift read as ${lag} ms of lag`);
  assert.ok(win.length <= 7, "window stays bounded");
  // then a real backlog builds over 5 s: the newest samples arrive 3 s late
  const t1 = 1_000_000 + 30 * 60_000;
  for (let k = 1; k <= 25; k++) lag = updateLag(win, 50 + 1500 + (3000 * k) / 25, t1 + k * 200);
  assert.ok(Math.abs(lag - 3000) < 200, `backlog read as ${lag} ms`);
});
