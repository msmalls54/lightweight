// Stand-in receiver for testing the firmware before the real server exists. No deps.
//   node firmware/tools/ingest_logger.mjs [--port 3000] [--minutes 5]
// Accepts POST /ingest and /heartbeat (replies 200 {"ok":true}), prints every 5 s:
//   batches/s, samples per batch, seq gaps, duplicate (resent) seqs, t0 continuity, per-channel min/mean/max.
// With --minutes N it prints a final PASS/FAIL verdict after N minutes and exits.
// Don't run it while the real server is on port 3000 (same port).
import http from "node:http";
import os from "node:os";

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const PORT = arg("port", 3000);
const MINUTES = arg("minutes", 0);
const NAMES = ["R_bi", "R_delt", "L_bi", "L_delt"];
const BATCH_MS = 200;

for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
  for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) console.log(`laptop ip ${a.address}  (${name})`);
}

// Totals for the whole run.
const total = { batches: 0, dupes: 0, gapEvents: 0, missingBatches: 0, badShape: 0, t0Jumps: 0, reboots: 0, heartbeats: 0, samples: 0 };
let firstAt = 0;
let lastSeq = null, lastT0 = null;
const seen = new Set();
let lastHb = null;
// Window stats (reset every 5 s).
let win = newWindow();
function newWindow() {
  return { start: Date.now(), batches: 0, samples: 0, lens: new Set(), gaps: [], dupes: 0,
    ch: NAMES.map(() => ({ min: Infinity, max: -Infinity, sum: 0, n: 0 })), lateMs: [] };
}

function onBatch(b, remote) {
  if (!firstAt) { firstAt = Date.now(); console.log(`first batch from ${remote}, seq ${b.seq}`); }
  const okShape = b && typeof b.seq === "number" && typeof b.t0_ms === "number" && b.dt_ms === 5 &&
    Array.isArray(b.ch) && b.ch.length === 4 && b.ch.every((c) => Array.isArray(c) && c.length === b.ch[0].length);
  if (!okShape) { total.badShape++; console.log("BAD SHAPE", JSON.stringify(b).slice(0, 200)); return; }
  if (seen.has(b.seq)) { total.dupes++; win.dupes++; return; } // resend we already have
  seen.add(b.seq);
  if (lastSeq !== null) {
    if (b.seq > lastSeq + 1 && b.seq - lastSeq < 100000) {
      const miss = b.seq - lastSeq - 1;
      total.gapEvents++; total.missingBatches += miss; win.gaps.push(`${lastSeq + 1}..${b.seq - 1}`);
    } else if (b.seq < lastSeq || b.seq - lastSeq >= 100000) {
      total.reboots++; console.log(`seq jumped ${lastSeq} -> ${b.seq} (device reboot?)`);
      lastT0 = null;
    } else if (lastT0 !== null) {
      const d = b.t0_ms - lastT0;
      if (Math.abs(d - BATCH_MS) > 3) { total.t0Jumps++; console.log(`t0 step ${d} ms between seq ${lastSeq} and ${b.seq} (expected 200)`); }
    }
  }
  if (lastSeq === null || b.seq > lastSeq) { lastSeq = b.seq; lastT0 = b.t0_ms; }
  const n = b.ch[0].length;
  total.batches++; total.samples += n;
  win.batches++; win.samples += n; win.lens.add(n);
  b.ch.forEach((arr, i) => {
    const s = win.ch[i];
    for (const v of arr) { if (v < s.min) s.min = v; if (v > s.max) s.max = v; s.sum += v; s.n++; }
  });
}

function report() {
  const secs = (Date.now() - win.start) / 1000;
  const rate = (win.batches / secs).toFixed(2);
  const lens = [...win.lens].join("/") || "-";
  const chs = win.ch.map((s, i) => s.n ? `${NAMES[i]} ${s.min}/${Math.round(s.sum / s.n)}/${s.max}` : `${NAMES[i]} -`).join("  ");
  const hb = lastHb ? `hb rssi ${lastHb.rssi} q ${lastHb.queue} drop ${lastHb.dropped ?? "?"} up ${Math.round(lastHb.uptime_ms / 1000)}s` : "no heartbeat yet";
  console.log(`${new Date().toLocaleTimeString()}  ${rate} batch/s  ${lens} samp/batch  gaps ${win.gaps.length ? win.gaps.join(",") : 0}  resent ${win.dupes}  | ${hb}`);
  console.log(`          min/mean/max  ${chs}`);
  win = newWindow();
}
setInterval(report, 5000);

if (MINUTES > 0) {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (!firstAt || Date.now() - firstAt < MINUTES * 60000) return;
    clearInterval(timer);
    const secs = (Date.now() - firstAt) / 1000;
    const rate = total.batches / secs;
    const pass = total.missingBatches === 0 && total.badShape === 0 && total.t0Jumps === 0 && rate > 4.8 && rate < 5.2;
    console.log("\n==== verdict after", MINUTES, "min ====");
    console.log(JSON.stringify({ seconds: Math.round(secs), batches: total.batches, batches_per_s: +rate.toFixed(3),
      samples: total.samples, samples_per_s: +(total.samples / secs).toFixed(1), missing_batches: total.missingBatches,
      gap_events: total.gapEvents, resent_dupes: total.dupes, t0_discontinuities: total.t0Jumps, bad_shape: total.badShape,
      reboots: total.reboots, heartbeats: total.heartbeats, last_heartbeat: lastHb, waited_s: Math.round((Date.now() - startedAt) / 1000) }, null, 1));
    console.log(pass ? "PASS" : "FAIL");
    process.exit(pass ? 0 : 1);
  }, 1000);
}

http.createServer((req, res) => {
  const reply = (code, obj) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(obj));
  if (req.method !== "POST" || (req.url !== "/ingest" && req.url !== "/heartbeat")) return reply(404, { ok: false });
  let data = "";
  req.setEncoding("utf8");
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    let body;
    try { body = JSON.parse(data); } catch { console.log("BAD JSON", data.slice(0, 200)); return reply(400, { ok: false }); }
    if (req.url === "/ingest") onBatch(body, req.socket.remoteAddress);
    else { total.heartbeats++; lastHb = body; }
    reply(200, { ok: true });
  });
}).listen(PORT, "0.0.0.0", () => console.log(`ingest logger on :${PORT}${MINUTES ? `, verdict after ${MINUTES} min` : ""}; waiting for the UNO...`));
