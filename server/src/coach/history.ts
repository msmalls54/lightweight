import fs from "node:fs";
import path from "node:path";
import { coachDir, isWalkUpPerson, localDate } from "./context.js";
import { decisionLine, plural, r2, setFacts } from "./facts.js";
import type { SetEndEvent, Variant } from "./types.js";

export interface SetMeta {
  exercise?: string;
  variant?: Variant;
  load_lb?: number;
}

export interface WriteHistoryOptions {
  /** Defaults to data/coach. */
  dataDir?: string;
  /** Defaults to today (local). */
  date?: string;
  /** Walk-ups are never written into Mike's history. */
  person?: string;
  /** set_id -> exercise/variant/load from the server's SetContext. */
  setMeta?: Record<string, SetMeta>;
  /** Optional one-liners (e.g. from Hydrogen) appended after the code-computed takeaways. */
  takeaways?: string[];
}

/** Code-computed takeaways: numbers only, no LLM. */
export function codeTakeaways(sets: SetEndEvent[]): string[] {
  const out: string[] = [];
  sets.forEach((s, i) => {
    const f = setFacts(s);
    out.push(
      `Set ${i + 1}: ${plural(f.total_reps, "rep")}, ${plural(f.cheats, "cheat")}` +
        (f.first_cheat_rep ? ` (first at rep ${f.first_cheat_rep})` : "") +
        (f.avg_delt_share != null ? `, avg delt share ${f.avg_delt_share}` : "") +
        `. ${decisionLine(s.decision?.next)}`,
    );
  });
  const all = sets.flatMap((s) => s.reps);
  const clean = all.filter((r) => !r.cheat).map((r) => r.delt_share);
  const cheat = all.filter((r) => r.cheat).map((r) => r.delt_share);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  if (clean.length && cheat.length)
    out.push(`Clean reps: delt share about ${r2(mean(clean))}. Cheat reps: about ${r2(mean(cheat))}.`);
  else if (clean.length) out.push(`Every rep clean: delt share about ${r2(mean(clean))}.`);
  return out;
}

/**
 * Write data/coach/history/<date>.json from today's sets (code computes every number).
 * Returns the file path, or null if skipped (walk-up, or no sets).
 */
export function writeTodayHistory(sets: SetEndEvent[], opts: WriteHistoryOptions = {}): string | null {
  const dir = opts.dataDir ?? coachDir();
  if (opts.person && isWalkUpPerson(opts.person, readProfileName(dir))) return null;
  if (!sets?.length) return null;
  const date = opts.date ?? localDate();

  const day = {
    date,
    kind: "session",
    person: opts.person ?? "Mike",
    generated_by: "lightweight server (numbers computed by code)",
    sets: sets.map((s) => {
      const f = setFacts(s);
      const meta = opts.setMeta?.[s.set_id] ?? {};
      return {
        set_id: s.set_id,
        ...meta,
        reps: f.reps,
        clean: f.clean,
        cheats: f.cheats,
        cheat_reps: f.cheat_reps,
        first_cheat_rep: f.first_cheat_rep,
        avg_delt_share: f.avg_delt_share,
        avg_r_share: f.avg_r_share,
        decision: s.decision,
      };
    }),
    coach_takeaways: [...codeTakeaways(sets), ...(opts.takeaways ?? []).slice(0, 2)],
  };

  const histDir = path.join(dir, "history");
  fs.mkdirSync(histDir, { recursive: true });
  const file = path.join(histDir, `${date}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(day, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return file;
}

function readProfileName(dir: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "profile.json"), "utf8")).name;
  } catch {
    return "Mike";
  }
}
