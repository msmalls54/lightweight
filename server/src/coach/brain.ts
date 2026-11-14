import { GoogleGenAI, type ThinkingLevel } from "@google/genai";
import { loadGeminiKey } from "../voice/env.js";
import { BRAIN_FALLBACK_MODELS, BRAIN_MODEL, BRAIN_THINKING_LEVEL } from "../voice/models.js";
import type { CoachContext } from "./context.js";
import {
  decisionLine,
  decisionShort,
  SPOKEN_MAX_WORDS,
  fallbackDetail,
  fallbackSummary,
  forLlm,
  historyBrief,
  lastSessionFacts,
  mentionsHistory,
  mentionsLoadChange,
  mentionsMedical,
  mentionsRawShare,
  namesAllReps,
  sameLift,
  scrubSnitch,
  setFacts,
  withSensorBullet,
  type LiftKey,
  type SetDetail,
} from "./facts.js";
import {
  fallbackSession,
  workoutFacts,
  workoutInputFromContext,
  WORKING_SET_MIN_REPS,
  WORKOUT_SPOKEN_MAX_WORDS,
  type SessionSummary,
  type WorkoutInput,
} from "./session.js";
import type { SetEndEvent, Variant } from "./types.js";

export interface BrainOptions {
  /** Ask for a JSON object (responseMimeType application/json). */
  json?: boolean;
}

/** (system, prompt) -> text. Swappable so tests never hit the network. */
export type Brain = (system: string, prompt: string, opts?: BrainOptions) => Promise<string>;

let brain: Brain | undefined;

/** Inject a brain (tests) or reset to Gemini with `undefined`. */
export function setBrain(b?: Brain): void {
  brain = b;
}

export function geminiBrain(apiKey: string, timeoutMs = 12000): Brain {
  const ai = new GoogleGenAI({ apiKey });
  const models = [BRAIN_MODEL, ...BRAIN_FALLBACK_MODELS];
  const noThinking = new Set<string>(); // models that rejected BRAIN_THINKING_LEVEL

  const call = async (model: string, system: string, prompt: string, opts?: BrainOptions): Promise<string> => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction: system,
          temperature: 0.6,
          abortSignal: ac.signal,
          ...(opts?.json ? { responseMimeType: "application/json" } : {}),
          ...(noThinking.has(model)
            ? {}
            : { thinkingConfig: { thinkingLevel: BRAIN_THINKING_LEVEL as ThinkingLevel } }),
        },
      });
      const text = (r.text ?? "").trim();
      if (!text) throw new Error(`${model} returned no text`);
      return text;
    } finally {
      clearTimeout(t);
    }
  };

  return async (system, prompt, opts) => {
    let lastErr: unknown;
    for (const model of models) {
      try {
        return await call(model, system, prompt, opts);
      } catch (e) {
        lastErr = e;
        // Model doesn't take our thinking level: remember, retry the same model without it.
        if (!noThinking.has(model) && /thinking/i.test(String((e as Error)?.message))) {
          noThinking.add(model);
          try {
            return await call(model, system, prompt, opts);
          } catch (e2) {
            lastErr = e2;
          }
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  };
}

function getBrain(): Brain {
  if (brain) return brain;
  const key = loadGeminiKey();
  if (!key) throw new Error("GEMINI_API_KEY not set");
  brain = geminiBrain(key);
  return brain;
}

export const SYSTEM_PROMPT = `You are Lightweight, an AI gym coach that can feel the lifter's muscles through EMG sensors on both biceps and both front delts. Your words are spoken through a speaker in the gym or shown on a dashboard.

How you talk:
- Blunt gym coach in plain words. Short, punchy sentences. Roast cheat reps a little, give clean work quick credit.
- Say "front delt" or "shoulder". Never say "snitch".
- Spoken words only: no markdown, no emojis. Multiples as whole numbers ("8 times its normal share"), never long decimals.

How to read the data (all computed by code):
- verdict / label: code already decided each rep. big_swing = the shoulder did the lifting (a swing or lean back). mild_cheat = flagged, but much smaller. loose = NOT a cheat: the shoulder crept up as the lifter tired; say "a bit loose", never "cheat". near_miss = clean, but the shoulder crept up. Never relabel a rep; "cheat" and "mild cheat" only for reps the code flagged.
- up_delt_x_clean: how much the shoulder helped on the way up, as a multiple of the lifter's OWN clean reps (1 = normal). 8 means "your shoulder did 8 times its normal share on the way up". That number is the WHY of a cheat.
- The front delt always works on a curl, and under load it works a lot: that is normal. Only the multiple vs the lifter's own clean reps matters. Never quote a raw shoulder or delt percentage or a "delt share".
- reference_status "learning": the engine is still learning this lifter's clean rep, so it can't make calls yet. Say that plainly.
- all_clean true: say the set was clean plainly ("your shoulder stayed in its normal range") and give one technique cue. No scary numbers.
- biceps_peak_pct: how hard each biceps peaked (100 = max flex). A low biceps peak on a cheat = momentum or the shoulder did the work.
- balance: left vs right biceps, only from reps where both arms curled. balance.verdict says which side slacked. null = don't talk about balance.
- tempo.fast_up_reps: reps that came up faster than fast_up_threshold_ms: only those are "rushed". tempo.faster_than_usual_reps: say "faster than your usual" for those, never "rushed".
- cheat_pattern says whether cheats came late (fatigue) or were scattered.

What you may say:
- Only facts in the data given. If something isn't there, say you don't have that data. Never make up reps, numbers, causes or history.
- Compare with a previous session ONLY using LAST_SESSION_SAME_LIFT (same exercise, variant and load). If it is "none", don't mention any previous session at all.
- The sensors measure relative muscle activation, not force. Never talk about strength, muscle growth, injury, pain, diagnosis, or anything medical.
- The decision (FACTS.decision) was made by code. Repeat it in your own words; never contradict it or add a different plan.
- The weight never changes (35 lb). Never suggest adding, dropping, or changing the weight, load or band, and never name a new weight.
- Hammer curls: say "less biceps", never claim the forearm took over (forearms aren't measured).
- A walk-up (isWalkUp true) has no history: never mention anyone else's sessions.`;

function compact(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "number" ? Math.round(x * 1000) / 1000 : x));
}

/** The lift (exercise/variant/load) of a set, if the server passed setMeta. */
function liftOf(ctx: CoachContext, set: SetEndEvent | undefined): LiftKey | undefined {
  return set ? ctx.today.setMeta?.[set.set_id] : undefined;
}

function setBlock(ctx: CoachContext, s: SetEndEvent, i: number) {
  const lift = liftOf(ctx, s);
  return { set_no: i + 1, ...(lift ? { lift } : {}), ...forLlm(setFacts(s, lift?.variant as Variant | undefined)) };
}

/** Shared context. `forSet`: history is reduced to like-for-like sets for that set's lift. */
function contextBlock(ctx: CoachContext, opts: { omitSetId?: string; forSet?: SetEndEvent } = {}): string {
  const sets = ctx.today.sets.filter((s) => s.set_id !== opts.omitSetId);
  const lines = [
    `PERSON: ${ctx.person}${ctx.isWalkUp ? " (walk-up, no history)" : ""}`,
    `PROFILE: ${compact(ctx.profile)}`,
    `PLAN: ${compact(ctx.plan)}`,
    `TODAY: ${compact({ date: ctx.today.date, planned: ctx.today.planned, checkin: ctx.today.checkin, sets_done: sets.map((s, i) => setBlock(ctx, s, i)) })}`,
  ];
  if (opts.forSet) {
    const same = lastSessionFacts(ctx.lastDay, liftOf(ctx, opts.forSet));
    lines.push(`LAST_SESSION_SAME_LIFT: ${same ? compact(same) : "none"}`);
  } else {
    // Q&A: the whole last day, labelled with its lift and expressed relative to its own clean/strict reps.
    const brief = historyBrief(ctx.lastDay);
    lines.push(
      `LAST_SESSION (may be a different lift; compare numbers with today only if exercise, variant and load all match): ${brief ? compact(brief) : "none"}`,
    );
  }
  return lines.join("\n");
}

/** Earlier sets today with the same lift (or unknown lift), as short facts. */
function previousSetsBrief(ctx: CoachContext, set: SetEndEvent) {
  const idx = ctx.today.sets.findIndex((s) => s.set_id === set.set_id);
  const lift = liftOf(ctx, set);
  const before = (idx >= 0 ? ctx.today.sets.slice(0, idx) : ctx.today.sets.filter((s) => s.set_id !== set.set_id))
    .filter((s) => !lift || !liftOf(ctx, s) || sameLift(lift, liftOf(ctx, s)))
    .slice(-3);
  return before.map((s) => {
    const f = setFacts(s);
    return { cheats: f.cheats, total_reps: f.total_reps, first_cheat_rep: f.first_cheat_rep, worst_rep: f.worst_rep };
  });
}

const lastRepNo = (set: SetEndEvent) => (set.reps.length ? Math.max(...set.reps.map((r) => r.rep)) : 0);

/** Strip markdown the TTS would read out, and "snitch" (Mike's call: plain words). */
function clean(s: string): string {
  return scrubSnitch(
    s
      .replace(/[*_#`>]+/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const sentences = (s: string) => s.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g)?.map((x) => x.trim()) ?? [s];

/** Keep whole sentences, in order, while they fit in `max` words ("" if even the first doesn't). */
function fitWords(text: string, max: number): string {
  const out: string[] = [];
  for (const s of sentences(text)) {
    if (words([...out, s].join(" ")) > max) break;
    out.push(s);
  }
  return out.join(" ");
}

/** Rules every LLM line must pass, or the code line is used instead. */
function breaksRules(text: string, opts: { historyAllowed: boolean; knownLoads?: number[] }): boolean {
  // Loads that are facts (e.g. a logged lift at 120 lb) may be named; any other number of pounds may not.
  const loadText = (opts.knownLoads ?? []).reduce(
    (t, n) => t.replace(new RegExp(`\\b${n}\\s*(lb|lbs|pounds?)\\b`, "gi"), "the logged load"),
    text,
  );
  return (
    mentionsLoadChange(loadText) ||
    mentionsMedical(text) ||
    mentionsRawShare(text) ||
    (!opts.historyAllowed && mentionsHistory(text))
  );
}


const STATE_HINT = (f: ReturnType<typeof setFacts>) =>
  f.total_reps === 0
    ? "No reps were counted."
    : f.reference_status === "learning"
      ? "reference_status is learning: say you're still learning their clean rep, so no calls yet; keep them strict. No numbers."
      : f.all_clean
        ? "All reps clean: say it plainly (the shoulder stayed in its normal range), add one technique cue, no numbers about the shoulder."
        : `Name every cheat rep by number (${f.cheat_reps.join(", ")}) and say WHY: which side's shoulder, and how many times its normal share on the way up (up_delt_x_clean). Group reps with the same story; give a group's multiples as one number or a range ("8 to 12 times"). If cheat_pattern starts with "fatigue", tell it as "From rep N on, ...".`;

/**
 * Spoken set summary (≤ 40 words, ~12 s): names the cheat reps and why, then the engine's
 * decision. Gemini phrases; code facts and decision are fixed; rule breaks fall back to code.
 */
export async function summarizeSet(ctx: CoachContext, set: SetEndEvent): Promise<string> {
  const lift = liftOf(ctx, set);
  const facts = setFacts(set, lift?.variant as Variant | undefined);
  const historyAllowed = !!lastSessionFacts(ctx.lastDay, lift);
  const prompt = `${contextBlock(ctx, { omitSetId: set.set_id, forSet: set })}

FACTS (this set, computed by code): ${compact({ ...(lift ? { lift } : {}), ...forLlm(facts) })}
EARLIER_SETS_TODAY (same lift): ${compact(previousSetsBrief(ctx, set))}
REQUIRED DECISION: ${decisionLine(set.decision?.next)} (engine reason: ${set.decision?.reason ?? ""})

Write the summary of this set: at most 3 short sentences, at most ${SPOKEN_MAX_WORDS} words. ONLY THE FIRST SENTENCE IS SPOKEN ALOUD (the rest is shown on screen), so the first sentence must carry the main point in at most 15 words: the cheat reps and why, or that the set was clean.
- ${STATE_HINT(facts)}
- End with the required decision in a few words ("${decisionShort(set.decision?.next)}").
Example of the style for a set with cheats (different numbers, 22 words): "Reps 4 and 8: right shoulder at 8 times normal, that's a swing. Rep 5 smaller. Next set, stop at the first cheat."`;
  try {
    let text = clean(await getBrain()(SYSTEM_PROMPT, prompt));
    if (words(text) > SPOKEN_MAX_WORDS) text = fitWords(text, SPOKEN_MAX_WORDS);
    if (!text || words(text) > SPOKEN_MAX_WORDS || breaksRules(text, { historyAllowed })) return fallbackSummary(set);
    if (!namesAllReps(text, facts.cheat_reps, lastRepNo(set))) return fallbackSummary(set);
    return text;
  } catch {
    return fallbackSummary(set);
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Dashboard card for a set: headline, 4–6 bullets (cheats and why, near-misses, tempo, L/R,
 * vs last time when like-for-like) and one cue for the next set. Same facts and guardrails as summarizeSet.
 */
export async function summarizeSetDetail(ctx: CoachContext, set: SetEndEvent): Promise<SetDetail> {
  const lift = liftOf(ctx, set);
  const facts = setFacts(set, lift?.variant as Variant | undefined);
  const historyAllowed = !!lastSessionFacts(ctx.lastDay, lift);
  const fallback = fallbackDetail(set, ctx.lastDay, { lift });
  const prompt = `${contextBlock(ctx, { omitSetId: set.set_id, forSet: set })}

FACTS (this set, computed by code): ${compact({ ...(lift ? { lift } : {}), ...forLlm(facts) })}
EARLIER_SETS_TODAY (same lift): ${compact(previousSetsBrief(ctx, set))}
REQUIRED DECISION: ${decisionLine(set.decision?.next)} (engine reason: ${set.decision?.reason ?? ""})

Write the dashboard breakdown of this set as a JSON object: {"headline": string, "bullets": string[], "cue": string}
- headline: under 12 words, the story of the set. ${facts.reference_status === "learning" ? "Say it's still learning their clean rep." : facts.all_clean ? "Say it was clean, plainly." : ""}
- bullets: 3 to 6, each one sentence under 25 words, in this order where the data exists:
  1) ${facts.reference_status === "learning" ? "that the coach is learning their clean rep, so no calls yet" : facts.all_clean ? "the set was clean: the shoulder stayed in its normal range on the way up" : "each cheat rep (or group with the same story) by number and WHY: which side's shoulder, how many times its normal share (up_delt_x_clean), biceps peak if it was low"};
  2) near-misses (label near_miss) and any mild cheat, as borderline;
  3) tempo: only call reps rushed if they are in tempo.fast_up_reps; say whether cheats came with fast tempo or late (cheat_pattern);
  4) left vs right biceps balance from balance (skip if null);
  5) comparison to LAST_SESSION_SAME_LIFT or EARLIER_SETS_TODAY (skip if none);
- cue: one concrete technique instruction for the next set that fits the required decision (form or tempo, never weight).
Never quote a raw shoulder/delt percentage. Only JSON, no prose around it.`;
  try {
    const obj = parseJsonObject(await getBrain()(SYSTEM_PROMPT, prompt, { json: true }));
    if (!obj) return fallback;
    const headline = typeof obj.headline === "string" ? clean(obj.headline) : "";
    const bullets = Array.isArray(obj.bullets)
      ? obj.bullets.filter((b): b is string => typeof b === "string").map(clean).filter(Boolean).slice(0, 6)
      : [];
    const cue = typeof obj.cue === "string" ? clean(obj.cue) : "";
    const all = [headline, ...bullets, cue].join(" ");
    if (!headline || bullets.length < 2 || !cue || breaksRules(all, { historyAllowed })) return fallback;
    if (!namesAllReps(`${headline} ${bullets.join(" ")}`, facts.cheat_reps, lastRepNo(set))) return fallback;
    return { headline, bullets: withSensorBullet(bullets, facts.delt_saturated), cue, decision: set.decision, source: "gemini" };
  } catch {
    return fallback;
  }
}

/** Q&A over the context packet ("Which rep did I cheat?", "Which arm is weaker?"). */
export async function answer(ctx: CoachContext, question: string): Promise<string> {
  const q = String(question ?? "").trim().slice(0, 500);
  if (!q) return "Ask me something about your sets.";
  // "How's my workout going?" -> the <= 20-word workout line (same facts as the Workout so far card).
  if (isWorkoutQuestion(q) && ctx.today.sets.length) return (await summarizeSession(ctx)).spoken;
  const prompt = `${contextBlock(ctx)}

QUESTION: ${q}

Answer out loud in at most 3 short sentences, using only the data above. When it's about cheats, name the rep numbers and the why (which shoulder, how many times its normal share on the way up). When it's about arms, use balance and biceps peaks. If LAST_SESSION is a different lift from today's sets, you may describe it on its own terms but don't compare its numbers to today.`;
  try {
    const text = clean(await getBrain()(SYSTEM_PROMPT, prompt));
    if (!text) throw new Error("empty");
    if (breaksRules(text, { historyAllowed: true })) {
      return "Weight stays where it is. " + (ctx.today.sets.length ? fallbackSummary(ctx.today.sets.at(-1)!) : "");
    }
    return text;
  } catch {
    const last = ctx.today.sets.at(-1);
    return last
      ? `Coach brain is offline. Last set: ${fallbackSummary(last)}`
      : "Coach brain is offline and there are no sets yet today.";
  }
}

// ---------------------------------------------------------------- workout so far

/** "How's my workout going?" style questions get the <= 20-word workout line. */
export function isWorkoutQuestion(q: string): boolean {
  const t = q.toLowerCase();
  if (/\brep\s*\d|\bwhich (rep|arm|set)\b/.test(t)) return false;
  return /\bworkout\b|\bsession\b|\bso far\b|\bhow('?s| is| am i| are we)\b[^?]*\b(going|doing)\b/.test(t);
}

/**
 * "Workout so far" card while Mike is mid-workout: trend across sets, when fatigue starts, which arm,
 * best set, and the one thing to fix next (code-chosen focus; Gemini phrases). Never throws.
 */
export async function summarizeSession(ctx: CoachContext, workout?: WorkoutInput): Promise<SessionSummary> {
  const input = workoutInputFromContext(ctx, workout);
  const fallback = fallbackSession(input);
  if (!input.sets.length && !input.logged.length) return fallback;
  const w = workoutFacts(input);
  const prompt = `PERSON: ${ctx.person}${ctx.isWalkUp ? " (walk-up)" : ""}
PROFILE: ${compact(ctx.profile)}
PLAN: ${compact(ctx.plan)}
WORKOUT_SO_FAR (today, computed by code; sets numbered per exercise in order; working sets have ${WORKING_SET_MIN_REPS}+ reps): ${compact(w)}
FOCUS (chosen by code, restate it): ${w.focus.text}

The lifter is MID-WORKOUT. Write the "Workout so far" card as a JSON object:
{"headline": string, "bullets": string[], "focus_next": string, "spoken": string}
- headline: under 12 words, "so far today" framing.
- bullets: 3 to 5, each one sentence under 22 words: the trend across sets (cleaner or sloppier), when fatigue starts (first cheat rep in the longer sets), which arm's shoulder cheats, the best set, and any logged lifts (sets x reps x load only, they were not sensed: never describe their muscles).
- focus_next: the FOCUS above in your own words, one sentence, for the rest of the session.
- spoken: at most ${WORKOUT_SPOKEN_MAX_WORDS} words, said out loud: where the workout stands plus the focus.
No raw shoulder/delt percentages, no previous sessions, never a weight change. Only JSON.`;
  try {
    const obj = parseJsonObject(await getBrain()(SYSTEM_PROMPT, prompt, { json: true }));
    if (!obj) return fallback;
    const str = (v: unknown) => (typeof v === "string" ? clean(v) : "");
    const headline = str(obj.headline);
    const bullets = Array.isArray(obj.bullets) ? obj.bullets.map(str).filter(Boolean).slice(0, 5) : [];
    const focus_next = str(obj.focus_next);
    let spoken = str(obj.spoken);
    // Over 20 words: trimming would drop the focus, so use the code line (status + focus, <= 20 words).
    if (words(spoken) > WORKOUT_SPOKEN_MAX_WORDS) spoken = fallback.spoken;
    const all = [headline, ...bullets, focus_next, spoken].join(" ");
    const knownLoads = [...w.exercises.map((e) => e.load_lb), ...w.logged.map((l) => l.load_lb)].filter((x): x is number => x != null);
    if (!headline || bullets.length < 3 || !focus_next || breaksRules(all, { historyAllowed: false, knownLoads })) return fallback;
    return { headline, bullets, focus_next, spoken: spoken || fallback.spoken, totals: w.totals, source: "gemini" };
  } catch {
    return fallback;
  }
}
