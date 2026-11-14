// Read-only check of what the real server stored from the UNO (run from the main checkout root):
//   node firmware/tools/verify_stream.mjs [--minutes 5] [--db data/lightweight.sqlite]
// Coalesced POSTs make seq jump by n_batches, so continuity is checked in device time:
// each stored batch must start exactly where the previous one ended (t0 + n*5 ms).
// Also prints delivery rate, coalescing, and the latest heartbeat.
import { createRequire } from "node:module";
import path from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const dbPath = path.resolve(arg("db", "data/lightweight.sqlite"));
const minutes = Number(arg("minutes", 5));
const require = createRequire(path.resolve("server/package.json"));
const Database = require("better-sqlite3");
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

const since = new Date(Date.now() - minutes * 60000).toISOString();
const rows = db.prepare("SELECT seq, t0_ms, n, received_at FROM batches WHERE device = 'lw-uno-1' AND received_at >= ? ORDER BY t0_ms").all(since);
if (!rows.length) { console.log(`no lw-uno-1 batches in the last ${minutes} min`); process.exit(1); }

let gaps = 0, gapMs = 0, overlaps = 0, reboots = 0, samples = 0, maxN = 0;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  samples += r.n; maxN = Math.max(maxN, r.n);
  if (!i) continue;
  const p = rows[i - 1], expect = p.t0_ms + p.n * 5;
  if (r.t0_ms < p.t0_ms - 60000) { reboots++; continue; }
  if (r.t0_ms > expect + 2) { gaps++; gapMs += r.t0_ms - expect; console.log(`gap ${Math.round(r.t0_ms - expect)} ms before seq ${r.seq}`); }
  else if (r.t0_ms < expect - 2) overlaps++;
}
const first = rows[0], last = rows.at(-1);
const deviceSpan = (last.t0_ms + last.n * 5 - first.t0_ms) / 1000;
const wallSpan = (Date.parse(last.received_at) - Date.parse(first.received_at)) / 1000;
const hb = db.prepare("SELECT received_at, payload FROM heartbeats WHERE device = 'lw-uno-1' ORDER BY rowid DESC LIMIT 1").get();
console.log(JSON.stringify({
  posts: rows.length, samples, batches_equiv: +(samples / 40).toFixed(1), device_span_s: +deviceSpan.toFixed(1),
  wall_span_s: +wallSpan.toFixed(1), samples_per_s: +(samples / deviceSpan).toFixed(1), posts_per_s: +(rows.length / wallSpan).toFixed(2),
  avg_batches_per_post: +(samples / 40 / rows.length).toFixed(2), max_batches_per_post: maxN / 40,
  gaps, gap_ms: Math.round(gapMs), overlaps, reboots, last_heartbeat: hb ? JSON.parse(hb.payload) : null,
}, null, 1));
console.log(gaps === 0 && Math.abs(samples / deviceSpan - 200) < 2 ? "PASS: continuous 200 Hz" : "CHECK: gaps or rate off");
