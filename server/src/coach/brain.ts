import { GoogleGenAI, type ThinkingLevel } from "@google/genai";
import { loadGeminiKey } from "../voice/env.js";
import { BRAIN_FALLBACK_MODELS, BRAIN_MODEL, BRAIN_THINKING_LEVEL } from "../voice/models.js";
import type { CoachContext } from "./context.js";
import { decisionLine, fallbackSummary, mentionsLoadChange, setFacts } from "./facts.js";
import type { SetEndEvent } from "./types.js";

/** (system, prompt) -> text. Swappable so tests never hit the network. */
export type Brain = (system: string, prompt: string) => Promise<string>;

let brain: Brain | undefined;

/** Inject a brain (tests) or reset to Gemini with `undefined`. */
export function setBrain(b?: Brain): void {
  brain = b;
}

export function geminiBrain(apiKey: string, timeoutMs = 12000): Brain {
  const ai = new GoogleGenAI({ apiKey });
  const models = [BRAIN_MODEL, ...BRAIN_FALLBACK_MODELS];
  const noThinking = new Set<string>(); // models that rejected BRAIN_THINKING_LEVEL

  const call = async (model: string, system: string, prompt: string): Promise<string> => {
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

  return async (system, prompt) => {
    let lastErr: unknown;
    for (const model of models) {
      try {
        return await call(model, system, prompt);
      } catch (e) {
        lastErr = e;
        // Model doesn't take our thinking level: remember, retry the same model without it.
        if (!noThinking.has(model) && /thinking/i.test(String((e as Error)?.message))) {
          noThinking.add(model);
          try {
            return await call(model, system, prompt);
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

export const SYSTEM_PROMPT = `You are Lightweight, an AI gym coach that can feel the lifter's muscles through EMG sensors on the biceps and front delts. Your words are spoken out loud through a speaker in the gym.

How you talk:
- Blunt gym coach. Short, punchy sentences. Roast cheat reps a little, give clean work quick credit.
- Spoken words only: no markdown, no lists, no emojis. Say shares as whole percents ("46 percent"), never decimals.

What you may say:
- Only facts that are in CONTEXT or FACTS. If something isn't there, say you don't have that data. Never make up reps, numbers, dates or history.
- The sensors measure relative muscle activation: percent of max flex (%MVC) and delt share (delt / (delt + biceps)). Never talk about force, strength, muscle growth, injury, pain, diagnosis, or anything medical.
- Code already decided which reps were cheats and what to do next (FACTS.decision). Repeat that decision in your own words. Never contradict it, never add a different plan.
- The weight never changes. Never suggest adding, dropping, or changing the weight, load, or band, and never name a new weight.
- Hammer curls: say "less biceps", never claim the forearm took over (forearms aren't measured).
- Front delt = the "snitch": when it fires, the shoulder is helping (swing, lean back, elbows coming off the pad).
- A walk-up (isWalkUp true) has no history: never mention anyone else's sessions.`;

function compact(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "number" ? Math.round(x * 1000) / 1000 : x));
}

function contextBlock(ctx: CoachContext): string {
  return [
    `PERSON: ${ctx.person}${ctx.isWalkUp ? " (walk-up, no history)" : ""}`,
    `PROFILE: ${compact(ctx.profile)}`,
    `PLAN: ${compact(ctx.plan)}`,
    `TODAY: ${compact({
      date: ctx.today.date,
      planned: ctx.today.planned,
      checkin: ctx.today.checkin,
      sets_done: ctx.today.sets.map(setFacts),
    })}`,
    `LAST_SESSION: ${ctx.lastDay ? compact(ctx.lastDay) : "none"}`,
  ].join("\n");
}

/** 1–2 sentence spoken set summary. Gemini phrases; code facts and decision are fixed. */
export async function summarizeSet(ctx: CoachContext, set: SetEndEvent): Promise<string> {
  const facts = setFacts(set);
  const prompt = `${contextBlock(ctx)}

FACTS (this set, computed by code): ${compact(facts)}
REQUIRED DECISION: ${decisionLine(set.decision?.next)} (reason: ${set.decision?.reason ?? ""})

Write the spoken summary of this set in at most 2 short sentences: how it went (reps, cheats, when the delt took over) and the required decision. If LAST_SESSION has a comparable number, you may compare in a few words.`;
  try {
    const text = clean(await getBrain()(SYSTEM_PROMPT, prompt));
    if (!text || mentionsLoadChange(text)) return fallbackSummary(set);
    return text;
  } catch {
    return fallbackSummary(set);
  }
}

/** Q&A over the context packet ("Which rep did I cheat?", "Which arm is weaker?"). */
export async function answer(ctx: CoachContext, question: string): Promise<string> {
  const q = String(question ?? "").trim().slice(0, 500);
  if (!q) return "Ask me something about your sets.";
  const prompt = `${contextBlock(ctx)}

QUESTION: ${q}

Answer out loud in at most 3 short sentences, using only the data above.`;
  try {
    const text = clean(await getBrain()(SYSTEM_PROMPT, prompt));
    if (!text) throw new Error("empty");
    if (mentionsLoadChange(text)) {
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

/** Strip markdown the TTS would read out. */
function clean(s: string): string {
  return s
    .replace(/[*_#`>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
