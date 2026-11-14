import { GoogleGenAI, type ThinkingLevel } from "@google/genai";
import { loadGeminiKey } from "../voice/env.js";
import { BRAIN_FALLBACK_MODELS, BRAIN_MODEL, BRAIN_THINKING_LEVEL } from "../voice/models.js";
import type { CoachContext } from "./context.js";
import {
  decisionLine,
  fallbackDetail,
  fallbackSummary,
  lastSessionFacts,
  mentionsLoadChange,
  mentionsMedical,
  namesAllReps,
  setFacts,
  type SetDetail,
} from "./facts.js";
import type { SetEndEvent } from "./types.js";

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
- Blunt gym coach. Short, punchy sentences. Roast cheat reps a little, give clean work quick credit.
- Spoken words only: no markdown, no emojis. Say shares as whole percents ("46 percent") and multiples as whole numbers ("9 times", "8x"), never long decimals.

How to read the data (all computed by code):
- verdict / label: code already decided each rep. big_swing = the front delt did the lifting (a swing or lean back). mild_cheat = flagged, but much smaller. near_miss = clean, but the delt crept up. Never relabel a rep.
- up_delt_x_clean: how hard the front delt worked relative to the biceps on the way up, as a multiple of this set's clean reps. 8 means "your shoulder fired 8 times harder than on your clean reps". That number is the WHY of a cheat: say it.
- delt_share: delt / (delt + biceps) over the whole rep. biceps_peak_pct: how hard each biceps peaked (100 = max flex). Low biceps peak on a cheat = momentum or the shoulder did the work instead.
- r_share: right biceps / (right + left). 0.5 is even; balance.verdict says which side slacked.
- tempo.fast_up_reps: reps that came up faster than fast_up_threshold_ms. Only say a rep was rushed if it is in that list. down_ms is rough; never judge the lowering from it.
- cheat_pattern says whether cheats came late (fatigue) or were scattered.

What you may say:
- Only facts in CONTEXT or FACTS. If something isn't there, say you don't have that data. Never make up reps, numbers, causes or history.
- The sensors measure relative muscle activation, not force. Never talk about strength, muscle growth, injury, pain, diagnosis, or anything medical.
- FACTS.decision was made by code. Repeat it in your own words; never contradict it or add a different plan.
- The weight never changes (35 lb). Never suggest adding, dropping, or changing the weight, load or band, and never name a new weight.
- Hammer curls: say "less biceps", never claim the forearm took over (forearms aren't measured).
- A walk-up (isWalkUp true) has no history: never mention anyone else's sessions.`;

function compact(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "number" ? Math.round(x * 1000) / 1000 : x));
}

function contextBlock(ctx: CoachContext, opts: { omitSetId?: string } = {}): string {
  const sets = ctx.today.sets.filter((s) => s.set_id !== opts.omitSetId);
  return [
    `PERSON: ${ctx.person}${ctx.isWalkUp ? " (walk-up, no history)" : ""}`,
    `PROFILE: ${compact(ctx.profile)}`,
    `PLAN: ${compact(ctx.plan)}`,
    `TODAY: ${compact({
      date: ctx.today.date,
      planned: ctx.today.planned,
      checkin: ctx.today.checkin,
      sets_done: sets.map((s, i) => ({ set_no: i + 1, ...setFacts(s) })),
    })}`,
    `LAST_SESSION: ${ctx.lastDay ? compact(lastSessionFacts(ctx.lastDay) ?? ctx.lastDay) : "none"}`,
    ctx.lastDay ? `LAST_SESSION_TAKEAWAYS: ${compact((ctx.lastDay as { coach_takeaways?: unknown }).coach_takeaways ?? [])}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Earlier sets today, as short facts, for "vs your last set". */
function previousSetsBrief(ctx: CoachContext, set: SetEndEvent) {
  const idx = ctx.today.sets.findIndex((s) => s.set_id === set.set_id);
  const before = (idx >= 0 ? ctx.today.sets.slice(0, idx) : ctx.today.sets.filter((s) => s.set_id !== set.set_id)).slice(-3);
  return before.map((s) => {
    const f = setFacts(s);
    return { cheats: f.cheats, total_reps: f.total_reps, first_cheat_rep: f.first_cheat_rep, avg_delt_share_cheat_reps: f.avg_delt_share_cheat_reps };
  });
}

const lastRepNo = (set: SetEndEvent) => (set.reps.length ? Math.max(...set.reps.map((r) => r.rep)) : 0);

/** Strip markdown the TTS would read out. */
function clean(s: string): string {
  return s
    .replace(/[*_#`>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const sentences = (s: string) => s.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g)?.map((x) => x.trim()) ?? [s];

/** Rules every LLM line must pass, or the code line is used instead. */
function breaksRules(text: string): boolean {
  return mentionsLoadChange(text) || mentionsMedical(text);
}

/** Spoken limit: about 12 s of speech. */
export const SPOKEN_MAX_WORDS = 40;

/**
 * Spoken set summary (≤ 3 short sentences, ~12 s): names the cheat reps and why, then the engine's
 * decision. Gemini phrases; code facts and decision are fixed; rule breaks fall back to code.
 */
export async function summarizeSet(ctx: CoachContext, set: SetEndEvent): Promise<string> {
  const facts = setFacts(set);
  const prompt = `${contextBlock(ctx, { omitSetId: set.set_id })}

FACTS (this set, computed by code): ${compact(facts)}
EARLIER_SETS_TODAY: ${compact(previousSetsBrief(ctx, set))}
REQUIRED DECISION: ${decisionLine(set.decision?.next)} (engine reason: ${set.decision?.reason ?? ""})

Write the spoken summary of this set: at most 3 short sentences, at most ${SPOKEN_MAX_WORDS} words, about 12 seconds out loud.
- Name every cheat rep by number (${facts.cheat_reps.length ? facts.cheat_reps.join(", ") : "none"}) and say WHY with the numbers: which side's shoulder fired, and how many times harder than the clean reps (up_delt_x_clean). Group reps with the same story; give a group's multiples as one number or a range ("8 to 12 times"), never one per rep.
- If cheat_pattern starts with "fatigue", tell it as fatigue: "From rep N on, ..." instead of listing every rep.
- If there are no cheats, give the clean set quick credit and mention the closest near-miss if any.
- End with the required decision in your own words.
Example of the style (different numbers): "Reps 4 and 8: your right shoulder fired 8 times harder than your clean reps, that's a swing. Rep 5 was a smaller cheat. Stop at the first cheat next set and rest longer, same weight."`;
  try {
    let text = clean(await getBrain()(SYSTEM_PROMPT, prompt));
    if (words(text) > SPOKEN_MAX_WORDS) text = sentences(text).slice(0, 3).join(" ");
    if (!text || words(text) > SPOKEN_MAX_WORDS + 8 || breaksRules(text)) return fallbackSummary(set);
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
 * vs last time) and one cue for the next set. Same facts and guardrails as summarizeSet.
 */
export async function summarizeSetDetail(ctx: CoachContext, set: SetEndEvent): Promise<SetDetail> {
  const facts = setFacts(set);
  const fallback = fallbackDetail(set, ctx.lastDay);
  const prompt = `${contextBlock(ctx, { omitSetId: set.set_id })}

FACTS (this set, computed by code): ${compact(facts)}
EARLIER_SETS_TODAY: ${compact(previousSetsBrief(ctx, set))}
REQUIRED DECISION: ${decisionLine(set.decision?.next)} (engine reason: ${set.decision?.reason ?? ""})

Write the dashboard breakdown of this set as a JSON object: {"headline": string, "bullets": string[], "cue": string}
- headline: under 12 words, the story of the set.
- bullets: 4 to 6, each one sentence under 25 words, in this order where the data exists:
  1) each cheat rep (or group with the same story) by number and WHY: which side's front delt, how many times the clean reps (up_delt_x_clean), biceps peak if it was low;
  2) near-misses (label near_miss), and any mild cheat, as borderline;
  3) tempo: only call reps rushed if they are in tempo.fast_up_reps; say whether cheats came with fast tempo or late (cheat_pattern);
  4) left vs right biceps balance from balance (skip if null);
  5) comparison to LAST_SESSION or EARLIER_SETS_TODAY with numbers (skip if none);
- cue: one concrete instruction for the next set that fits the required decision (form or tempo, never weight).
Only JSON, no prose around it.`;
  try {
    const obj = parseJsonObject(await getBrain()(SYSTEM_PROMPT, prompt, { json: true }));
    if (!obj) return fallback;
    const headline = typeof obj.headline === "string" ? clean(obj.headline) : "";
    const bullets = Array.isArray(obj.bullets)
      ? obj.bullets.filter((b): b is string => typeof b === "string").map(clean).filter(Boolean).slice(0, 6)
      : [];
    const cue = typeof obj.cue === "string" ? clean(obj.cue) : "";
    const all = [headline, ...bullets, cue].join(" ");
    if (!headline || bullets.length < 3 || !cue || breaksRules(all)) return fallback;
    if (!namesAllReps(`${headline} ${bullets.join(" ")}`, facts.cheat_reps, lastRepNo(set))) return fallback;
    return { headline, bullets, cue, decision: set.decision, source: "gemini" };
  } catch {
    return fallback;
  }
}

/** Q&A over the context packet ("Which rep did I cheat?", "Which arm is weaker?"). */
export async function answer(ctx: CoachContext, question: string): Promise<string> {
  const q = String(question ?? "").trim().slice(0, 500);
  if (!q) return "Ask me something about your sets.";
  const prompt = `${contextBlock(ctx)}

QUESTION: ${q}

Answer out loud in at most 3 short sentences, using only the data above. When it's about cheats, name the rep numbers and the why (which shoulder, how many times the clean reps). When it's about arms, use balance and biceps peaks.`;
  try {
    const text = clean(await getBrain()(SYSTEM_PROMPT, prompt));
    if (!text) throw new Error("empty");
    if (breaksRules(text)) {
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
