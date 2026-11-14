import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Batch, Calibration, RepEvent, SetContext, SetEndEvent, Arm } from "./modules.js";
import type { Heartbeat } from "./schemas.js";

export type SessionKind = "live" | "fake" | "replay";
export interface SessionRow {
  session_id: string; person: string; is_walkup: number; kind: SessionKind; arms: string;
  source_session_id: string | null; started_at: string; ended_at: string | null; calibration: string | null;
}
export interface SetRow {
  set_id: string; session_id: string; set_no: number; ctx: string; started_at: string;
  ended_at: string | null; summary: string | null; coach_line: string | null;
}
export interface EventRow { event_id: number; session_id: string; after_batch_id: number; kind: string; payload: string }

export class Store {
  readonly db: Database.Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 3000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY, person TEXT NOT NULL, is_walkup INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL DEFAULT 'live', arms TEXT NOT NULL DEFAULT '["R","L"]',
        source_session_id TEXT, started_at TEXT NOT NULL, ended_at TEXT, calibration TEXT
      );
      CREATE TABLE IF NOT EXISTS batches (
        batch_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, received_at TEXT NOT NULL,
        device TEXT NOT NULL, seq INTEGER NOT NULL, t0_ms REAL NOT NULL, n INTEGER NOT NULL, payload TEXT NOT NULL,
        UNIQUE(device, seq, t0_ms)
      );
      CREATE INDEX IF NOT EXISTS batches_session ON batches(session_id, batch_id);
      CREATE TABLE IF NOT EXISTS session_events (
        event_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, after_batch_id INTEGER NOT NULL,
        kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_session ON session_events(session_id, event_id);
      CREATE TABLE IF NOT EXISTS sets (
        set_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, set_no INTEGER NOT NULL, ctx TEXT NOT NULL,
        started_at TEXT NOT NULL, ended_at TEXT, summary TEXT, coach_line TEXT
      );
      CREATE INDEX IF NOT EXISTS sets_session ON sets(session_id, set_no);
      CREATE TABLE IF NOT EXISTS reps (
        rep_id INTEGER PRIMARY KEY, set_id TEXT NOT NULL, session_id TEXT NOT NULL, arm TEXT NOT NULL,
        rep INTEGER NOT NULL, cheat INTEGER NOT NULL, delt_share REAL NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(set_id, arm, rep)
      );
      CREATE TABLE IF NOT EXISTS heartbeats (
        heartbeat_id INTEGER PRIMARY KEY, received_at TEXT NOT NULL, device TEXT NOT NULL, payload TEXT NOT NULL
      );
    `);
  }

  createSession(s: { session_id: string; person: string; is_walkup: boolean; kind: SessionKind; arms: Arm[]; source_session_id?: string }) {
    this.db.prepare(`INSERT INTO sessions(session_id,person,is_walkup,kind,arms,source_session_id,started_at) VALUES (?,?,?,?,?,?,?)`)
      .run(s.session_id, s.person, s.is_walkup ? 1 : 0, s.kind, JSON.stringify(s.arms), s.source_session_id ?? null, new Date().toISOString());
  }
  endSession(id: string) { this.db.prepare("UPDATE sessions SET ended_at=? WHERE session_id=? AND ended_at IS NULL").run(new Date().toISOString(), id); }
  saveCalibration(id: string, c: Calibration) { this.db.prepare("UPDATE sessions SET calibration=? WHERE session_id=?").run(JSON.stringify(c), id); }
  getSession(id: string) { return this.db.prepare("SELECT * FROM sessions WHERE session_id=?").get(id) as SessionRow | undefined; }

  /** Returns the new batch_id, or null for a duplicate (same device+seq+t0, i.e. a resend). */
  saveBatch(sessionId: string, b: Batch): number | null {
    const r = this.db.prepare(`INSERT OR IGNORE INTO batches(session_id,received_at,device,seq,t0_ms,n,payload) VALUES (?,?,?,?,?,?,?)`)
      .run(sessionId, new Date().toISOString(), b.device, b.seq, b.t0_ms, b.ch[0]?.length ?? 0, JSON.stringify(b));
    return r.changes ? Number(r.lastInsertRowid) : null;
  }
  batchesFor(sessionId: string) {
    return (this.db.prepare("SELECT batch_id, payload FROM batches WHERE session_id=? ORDER BY batch_id").all(sessionId) as { batch_id: number; payload: string }[])
      .map(r => ({ batch_id: r.batch_id, batch: JSON.parse(r.payload) as Batch }));
  }
  addEvent(sessionId: string, afterBatchId: number, kind: string, payload: unknown) {
    this.db.prepare("INSERT INTO session_events(session_id,after_batch_id,kind,payload,created_at) VALUES (?,?,?,?,?)")
      .run(sessionId, afterBatchId, kind, JSON.stringify(payload ?? null), new Date().toISOString());
  }
  eventsFor(sessionId: string) { return this.db.prepare("SELECT * FROM session_events WHERE session_id=? ORDER BY event_id").all(sessionId) as EventRow[]; }

  /** Creates the set row on its first rep. Returns its set_no within the session. */
  ensureSet(ctx: SetContext): number {
    const old = this.db.prepare("SELECT set_no FROM sets WHERE set_id=?").get(ctx.set_id) as { set_no: number } | undefined;
    if (old) return old.set_no;
    const { n } = this.db.prepare("SELECT COALESCE(MAX(set_no),0)+1 AS n FROM sets WHERE session_id=?").get(ctx.session_id) as { n: number };
    this.db.prepare("INSERT INTO sets(set_id,session_id,set_no,ctx,started_at) VALUES (?,?,?,?,?)")
      .run(ctx.set_id, ctx.session_id, n, JSON.stringify(ctx), new Date().toISOString());
    return n;
  }
  saveRep(sessionId: string, r: RepEvent) {
    this.db.prepare("INSERT OR REPLACE INTO reps(set_id,session_id,arm,rep,cheat,delt_share,payload,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(r.set_id, sessionId, r.arm, r.rep, r.cheat ? 1 : 0, r.delt_share, JSON.stringify(r), new Date().toISOString());
  }
  endSet(e: SetEndEvent) { this.db.prepare("UPDATE sets SET ended_at=?, summary=? WHERE set_id=?").run(new Date().toISOString(), JSON.stringify(e), e.set_id); }
  saveCoachLine(setId: string, line: string) { this.db.prepare("UPDATE sets SET coach_line=? WHERE set_id=?").run(line, setId); }

  saveHeartbeat(h: Heartbeat) {
    this.db.prepare("INSERT INTO heartbeats(received_at,device,payload) VALUES (?,?,?)").run(new Date().toISOString(), h.device, JSON.stringify(h));
  }

  listSessions(limit = 30) {
    return this.db.prepare(`SELECT s.session_id, s.person, s.is_walkup, s.kind, s.arms, s.started_at, s.ended_at, s.source_session_id,
        (SELECT COUNT(*) FROM batches b WHERE b.session_id=s.session_id) AS batches,
        (SELECT COUNT(*) FROM sets t WHERE t.session_id=s.session_id AND t.summary IS NOT NULL) AS sets,
        (SELECT COUNT(*) FROM reps r WHERE r.session_id=s.session_id) AS reps,
        (SELECT COUNT(*) FROM reps r WHERE r.session_id=s.session_id AND r.cheat=1) AS cheats
      FROM sessions s ORDER BY s.started_at DESC LIMIT ?`).all(limit) as (Omit<SessionRow, "calibration"> & { batches: number; sets: number; reps: number; cheats: number })[];
  }
  setsFor(sessionId: string) { return this.db.prepare("SELECT * FROM sets WHERE session_id=? ORDER BY set_no").all(sessionId) as SetRow[]; }
  repsFor(setId: string) {
    return (this.db.prepare("SELECT payload FROM reps WHERE set_id=? ORDER BY rep, arm").all(setId) as { payload: string }[]).map(r => JSON.parse(r.payload) as RepEvent);
  }
  recentReps(sessionId: string, limit = 30) {
    return (this.db.prepare("SELECT r.payload, s.set_no FROM reps r JOIN sets s ON s.set_id=r.set_id WHERE r.session_id=? ORDER BY r.rep_id DESC LIMIT ?")
      .all(sessionId, limit) as { payload: string; set_no: number }[]).map(r => ({ ...(JSON.parse(r.payload) as RepEvent), set_no: r.set_no }));
  }
  /** Today's finished sets for a person, live (non-walk-up) sessions only. */
  todaySetEnds(person: string) {
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    return (this.db.prepare(`SELECT t.summary FROM sets t JOIN sessions s ON s.session_id=t.session_id
        WHERE s.person=? AND s.kind='live' AND s.is_walkup=0 AND t.summary IS NOT NULL AND t.started_at>=? ORDER BY t.started_at`)
      .all(person, midnight.toISOString()) as { summary: string }[]).map(r => JSON.parse(r.summary) as SetEndEvent);
  }
  close() { this.db.close(); }
}
