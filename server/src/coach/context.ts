import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { relabelSnitch, type LiftKey } from "./facts.js";
import type { SetEndEvent } from "./types.js";

/** data/coach at the repo root. Override with env LW_COACH_DIR (tests use a temp dir). */
export function coachDir(): string {
  return process.env.LW_COACH_DIR || fileURLToPath(new URL("../../../data/coach/", import.meta.url));
}

export interface Checkin {
  sleep: number;
  energy: number;
  soreness: number;
}

export interface CoachContext {
  profile: unknown;
  plan: unknown;
  lastDay: unknown;
  today: {
    sets: SetEndEvent[];
    checkin?: Checkin;
    date?: string;
    planned?: unknown;
    /** set_id -> exercise/variant/load (server SetContext). History is only compared like-for-like. */
    setMeta?: Record<string, LiftKey>;
  };
  person: string;
  isWalkUp: boolean;
}

/** Local calendar date YYYY-MM-DD (the venue's day, not UTC). */
export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Drop "TODO ..." placeholders and `_note`s so the LLM never quotes them. */
export function stripTodos(v: unknown): unknown {
  if (typeof v === "string") {
    // "TODO: ..." -> dropped; "Preacher curls: TODO weight" -> "Preacher curls"
    const s = v.replace(/[\s:;,-]*\bTODO\b.*$/is, "").trim();
    return s ? s : undefined;
  }
  if (Array.isArray(v)) return v.map(stripTodos).filter((x) => x !== undefined);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "_note") continue;
      const s = stripTodos(x);
      if (s === undefined) continue;
      if (Array.isArray(s) && s.length === 0) continue;
      if (s && typeof s === "object" && !Array.isArray(s) && Object.keys(s).length === 0) continue;
      out[k] = s;
    }
    return out;
  }
  return v;
}

/** Newest history day strictly before `today` (falls back to newest overall). */
export function newestHistory(dir: string, today: string): unknown {
  let files: string[] = [];
  try {
    files = fs.readdirSync(path.join(dir, "history")).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    return null;
  }
  files.sort();
  const before = files.filter((f) => f.slice(0, 10) < today);
  const pick = before.at(-1) ?? files.at(-1);
  if (!pick) return null;
  const day = readJson(path.join(dir, "history", pick));
  if (day && typeof day === "object") delete (day as Record<string, unknown>).raw_csv;
  return day;
}

/** Walk-ups: blank profile, generic rules, no history. Never coached on Mike's data. */
export function walkUpProfile(person: string) {
  return {
    name: person,
    walk_up: true,
    coaching_style: "blunt gym coach, short sentences, no medical language, roast the cheat reps a little",
  };
}

export const WALKUP_PLAN = {
  program: "Walk-up challenge: 5 curls, try to beat the agent",
  rules: {
    load_policy: "Use whatever is in hand; the coach never recommends adding or dropping weight.",
    goal: "Clean reps: biceps does the work, no swing.",
  },
};

export function isWalkUpPerson(person: string, profileName: unknown): boolean {
  const p = (person ?? "").trim().toLowerCase();
  const owner = typeof profileName === "string" ? profileName.trim().toLowerCase() : "mike";
  return p !== "" && p !== owner;
}

/**
 * ONE context packet for every summary / Q&A / MCP call:
 * profile + plan + today's planned vs done sets + last history day + check-in.
 */
export function buildCoachContext(input: {
  person: string;
  todaySets: SetEndEvent[];
  checkin?: Checkin;
  dataDir?: string;
  /** set_id -> {exercise, variant, load_lb}, e.g. store.todaySetMeta(person). Without it, no history comparisons. */
  setMeta?: Record<string, LiftKey>;
}): CoachContext {
  const dir = input.dataDir ?? coachDir();
  const date = localDate();
  const rawProfile = readJson(path.join(dir, "profile.json")) as Record<string, unknown> | null;
  const person = (input.person ?? "").trim() || (typeof rawProfile?.name === "string" ? rawProfile.name : "Mike");
  const isWalkUp = isWalkUpPerson(person, rawProfile?.name);
  const sets = input.todaySets ?? [];

  if (isWalkUp) {
    return {
      profile: walkUpProfile(person),
      plan: WALKUP_PLAN,
      lastDay: null,
      today: { date, sets, ...(input.checkin ? { checkin: input.checkin } : {}), ...(input.setMeta ? { setMeta: input.setMeta } : {}) },
      person,
      isWalkUp: true,
    };
  }

  const plan = stripTodos(readJson(path.join(dir, "plan.json"))) as Record<string, unknown> | null;
  const planToday = plan?.today as { date?: string } | undefined;
  return {
    // Mike's call: plain words, so any "snitch" in the files becomes "front delt" before the LLM sees it.
    profile: relabelSnitch(stripTodos(rawProfile) ?? { name: person }),
    plan: plan ? relabelSnitch({ ...plan, today: undefined }) : null,
    lastDay: relabelSnitch(newestHistory(dir, date)),
    today: {
      date,
      planned: planToday && (!planToday.date || planToday.date === date) ? planToday : undefined,
      sets,
      ...(input.checkin ? { checkin: input.checkin } : {}),
      ...(input.setMeta ? { setMeta: input.setMeta } : {}),
    },
    person,
    isWalkUp: false,
  };
}
