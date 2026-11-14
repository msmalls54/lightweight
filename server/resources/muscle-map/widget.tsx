import { useEffect, useMemo, useRef, useState } from "react";
import { McpUseProvider, useWidget, type WidgetMetadata } from "mcp-use/react";
import type { MuscleMapView, RepView, compareArms } from "../../src/mcp/data.js";
import { ANTERIOR } from "./anterior.js";

export const widgetMetadata: WidgetMetadata = {
  title: "Lightweight: muscle map",
  description: "Front-body map of the 4 sensed muscles (L/R biceps, L/R front delt) shaded by %MVC, with a per-rep scrubber and cheat reps in red.",
  exposeAsTool: false,
};

type ArmsCompare = NonNullable<ReturnType<typeof compareArms>>;
type Props = Partial<MuscleMapView> & { empty?: boolean; mode?: "set" | "arms"; arms_compare?: ArmsCompare };
type View = "rep" | "set" | "session";

// Channel order everywhere: 0 R biceps, 1 R front delt, 2 L biceps, 3 L front delt.
const TRACKED: Record<string, number> = { "biceps/right": 0, "front-deltoids/right": 1, "biceps/left": 2, "front-deltoids/left": 3 };
const CH_LABEL = ["R biceps", "R front delt", "L biceps", "L front delt"];
const pct = (x: number) => `${Math.round(x * 100)}%`;

// Effort tint (neutral blue by %MVC). Red is only ever a cheat verdict, never effort.
function heat(v: number, dark: boolean) {
  const t = Math.max(0, Math.min(1, v));
  const a = dark ? [58, 64, 78] : [226, 222, 216], b = [61, 139, 253];
  return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * t)).join(",")})`;
}

type Verdict = "clean" | "loose" | "cheat";
/** Per working arm: the engine's arm verdicts when present (bilateral reps), else the rep's own arm. */
function armsOf(r: RepView): { arm: "R" | "L"; verdict: Verdict; x: number | null }[] {
  const a = r.arms ? Object.entries(r.arms).filter(([, d]) => d).map(([arm, d]) => ({ arm: arm as "R" | "L", verdict: d!.verdict, x: d!.shoulder_help_x })) : [];
  return a.length ? a : [{ arm: r.arm, verdict: r.verdict, x: r.shoulder_help_x }];
}
const worst = (vs: Verdict[]): Verdict => (vs.includes("cheat") ? "cheat" : vs.includes("loose") ? "loose" : "clean");

/** One entry per rep number; verdict = worst arm. Shading = max peak over arms. */
function groupReps(reps: RepView[]) {
  const m = new Map<number, { rep: number; cheat: boolean; verdict: Verdict; arms: Partial<Record<"R" | "L", Verdict>>; peak: number[]; events: RepView[] }>();
  for (const r of reps) {
    const g = m.get(r.rep) ?? { rep: r.rep, cheat: false, verdict: "clean" as Verdict, arms: {}, peak: [0, 0, 0, 0], events: [] };
    for (const a of armsOf(r)) g.arms[a.arm] = a.verdict;
    g.verdict = worst(Object.values(g.arms) as Verdict[]);
    g.cheat ||= r.cheat || g.verdict === "cheat";
    g.peak = g.peak.map((v, i) => Math.max(v, r.raw_effort.peak_pct[i] ?? 0));
    g.events.push(r);
    m.set(r.rep, g);
  }
  return [...m.values()].sort((a, b) => a.rep - b.rep);
}

const V_COLOR = { clean: "#2e9e5b", loose: "#d97706", cheat: "#e53935" };
/** verdicts (rep view): biceps green/amber for a clean/loose arm, front delt red for a cheating arm. */
function Body({ values, dark, arms, verdicts }: { values: number[]; dark: boolean; arms: string[]; verdicts?: Partial<Record<"R" | "L", Verdict>> }) {
  const untracked = dark ? "#2a2f3a" : "#d4d0ca", edge = dark ? "#11141a" : "#f6f3ee";
  return <svg viewBox="-6 -4 112 208" width="200" height="372" role="img" style={{ display: "block", flex: "none" }}
    aria-label={`Muscle map. ${CH_LABEL.map((l, i) => `${l} ${pct(values[i] ?? 0)}`).join(", ")}. Gray muscles are not measured.`}>
    {ANTERIOR.map((s, i) => {
      const ch = TRACKED[`${s.muscle}/${s.side}`];
      const used = ch !== undefined && arms.includes(ch < 2 ? "R" : "L");
      const v = ch !== undefined ? verdicts?.[ch < 2 ? "R" : "L"] : undefined;
      const isBi = ch !== undefined && ch % 2 === 0;
      const vFill = v && used ? (v === "cheat" ? (isBi ? null : V_COLOR.cheat) : isBi ? V_COLOR[v] : null) : null;
      return <polygon key={i} points={s.points} fill={ch === undefined ? untracked : !used ? untracked : vFill ?? heat(values[ch] ?? 0, dark)}
        stroke={ch === undefined ? edge : dark ? "#9aa3b5" : "#6b6258"} strokeWidth={ch === undefined ? 0.3 : 0.6} style={{ transition: "fill .3s" }} />;
    })}
    <text x="4" y="30" fontSize="9" fontWeight="700" fill={dark ? "#8a93a6" : "#7a7268"} textAnchor="middle">R</text>
    <text x="96" y="30" fontSize="9" fontWeight="700" fill={dark ? "#8a93a6" : "#7a7268"} textAnchor="middle">L</text>
  </svg>;
}

function MuscleMap({ p, dark }: { p: Props; dark: boolean }) {
  const reps = useMemo(() => groupReps(p.reps ?? []), [p.reps]);
  const [view, setView] = useState<View>("set");
  const [idx, setIdx] = useState<number | null>(null);
  const sel = reps.length ? reps[Math.min(idx ?? reps.length - 1, reps.length - 1)] : null;
  const fg = dark ? "#eef0f5" : "#1f2329", dim = dark ? "#8a93a6" : "#6f6a62", bg = dark ? "#151922" : "#faf8f5", line = dark ? "#2a3140" : "#e4dfd8";
  const red = "#e53935", green = "#2e9e5b";
  if (p.empty || !p.set) {
    return <div style={{ padding: 24, background: bg, color: fg, borderRadius: 14, fontFamily: "Segoe UI, system-ui, sans-serif" }}>
      <div style={{ fontSize: 20, fontWeight: 700 }}>Lightweight</div><div style={{ color: dim }}>No sets yet. Put the sensors on and curl.</div></div>;
  }
  const s = p.set, arms = p.arms ?? ["R", "L"];
  const values = view === "rep" && sel ? sel.peak : view === "session" ? p.views!.session : p.views!.set;
  const tab = (v: View, label: string) => <button key={v} onClick={() => setView(v)} style={{
    padding: "4px 12px", borderRadius: 999, border: `1px solid ${view === v ? fg : line}`, background: view === v ? fg : "transparent",
    color: view === v ? bg : fg, fontWeight: 600, fontSize: 13, cursor: "pointer" }}>{label}</button>;
  const ac = p.arms_compare;
  return <div style={{ background: bg, color: fg, borderRadius: 14, padding: 18, fontFamily: "Segoe UI, system-ui, sans-serif", border: `1px solid ${line}`, maxWidth: 720 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
      <div>
        <div style={{ fontSize: 13, color: dim, fontWeight: 600 }}>{p.replay_of ? "Replayed session" : p.walkup ? "Walk-up" : "Session"} · set {s.set_no}{p.sets && p.sets.length > 1 ? ` of ${p.sets.length}` : ""}</div>
        <div style={{ fontSize: 26, fontWeight: 800 }}>{p.person}</div>
        <div style={{ fontSize: 15, color: dim }}>{s.exercise} · {s.variant}{s.load_lb != null ? ` · ${s.load_lb} lb` : ""}</div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <span style={{ padding: "6px 12px", borderRadius: 10, background: green, color: "#fff", fontWeight: 800 }}>{s.clean} clean</span>
        <span style={{ padding: "6px 12px", borderRadius: 10, background: s.cheats ? red : line, color: s.cheats ? "#fff" : dim, fontWeight: 800 }}>{s.cheats} cheat</span>
      </div>
    </div>

    <div style={{ display: "flex", gap: 18, marginTop: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
      <Body values={values} dark={dark} arms={arms} verdicts={view === "rep" && sel ? sel.arms : undefined} />
      <div style={{ flex: 1, minWidth: 260 }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>{tab("rep", "Rep")}{tab("set", "Set")}{tab("session", "Session")}</div>
        <div style={{ fontSize: 12, color: dim, marginBottom: 6 }}>Raw effort, peak %MVC (context only) · {view === "rep" && sel ? `rep ${sel.rep}` : view === "set" ? `avg per rep, set ${s.set_no}` : "avg per rep, whole session"}</div>
        {CH_LABEL.map((l, i) => {
          const used = arms.includes(i < 2 ? "R" : "L");
          const v = values[i] ?? 0;
          return <div key={l} style={{ display: "grid", gridTemplateColumns: "100px 1fr 44px", alignItems: "center", gap: 8, marginBottom: 6, opacity: used ? 1 : 0.4 }}>
            <span style={{ fontSize: 14 }}>{l}</span>
            <span style={{ height: 10, background: line, borderRadius: 6, overflow: "hidden" }}>
              <span style={{ display: "block", height: "100%", width: `${Math.min(100, (v / 1.2) * 100)}%`, background: i % 2 ? "#f08a3c" : "#3d8bfd" }} />
            </span>
            <span style={{ fontSize: 14, fontWeight: 700, textAlign: "right" }}>{used ? pct(v) : "off"}</span>
          </div>;
        })}

        <div style={{ fontSize: 12, color: dim, margin: "14px 0 6px" }}>Reps (tap to scrub)</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {reps.map((r, i) => <button key={r.rep} onClick={() => { setIdx(i); setView("rep"); }} title={r.verdict === "cheat" ? "delt took over" : r.verdict} style={{
            width: 36, height: 36, borderRadius: 8, fontWeight: 800, cursor: "pointer", color: "#fff",
            background: V_COLOR[r.verdict], border: sel?.rep === r.rep && view === "rep" ? `3px solid ${fg}` : "3px solid transparent" }}>{r.rep}</button>)}
        </div>
        {reps.length > 1 && <input type="range" min={0} max={reps.length - 1} value={Math.min(idx ?? reps.length - 1, reps.length - 1)}
          onChange={e => { setIdx(Number(e.target.value)); setView("rep"); }} style={{ width: "100%", marginTop: 8 }} aria-label="Rep scrubber" />}
        {sel && view === "rep" && <div style={{ marginTop: 8, fontSize: 14 }}>
          {sel.events.flatMap(e => armsOf(e).map(a => <div key={`${e.arm}-${a.arm}`}>
            <b>Rep {e.rep}{arms.length > 1 ? ` ${a.arm === "R" ? "right" : "left"}` : ""}</b>: {a.x !== null ? `${a.x}× shoulder help vs your clean reps` : "learning your clean rep"}
            {a.verdict === "cheat" ? <b style={{ color: red }}> · cheat{e.reason ? `: ${e.reason}` : ""}</b> : a.verdict === "loose" ? <span style={{ color: V_COLOR.loose }}> · loose</span> : <span style={{ color: green }}> · clean</span>}
          </div>))}
        </div>}
        {s.coach_line && <div style={{ marginTop: 12, padding: "8px 12px", borderLeft: `3px solid #3d8bfd`, background: dark ? "#1c212c" : "#f0ece6", fontSize: 14 }}>{s.coach_line}</div>}
      </div>
    </div>

    {ac && <div style={{ marginTop: 14, borderTop: `1px solid ${line}`, paddingTop: 12 }}>
      <div style={{ fontSize: 13, color: dim, fontWeight: 600, marginBottom: 6 }}>
        Biceps balance, reps where both arms curled {ac.overall_r_share !== null ? `· ${pct(ac.overall_r_share)} R / ${pct(1 - ac.overall_r_share)} L · ${ac.overall_verdict}` : `· ${ac.overall_verdict ?? "one arm only: no balance"}`}
      </div>
      {ac.sets.map(r => <div key={r.set_no} style={{ display: "grid", gridTemplateColumns: "60px 1fr 90px", gap: 8, alignItems: "center", marginBottom: 6, fontSize: 14 }}>
        <span>Set {r.set_no}</span>
        <span style={{ position: "relative", height: 14, background: line, borderRadius: 7, overflow: "hidden" }}>
          <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(r.r_share ?? 0.5) * 100}%`, background: r.flagged ? red : "#3d8bfd" }} />
          <span style={{ position: "absolute", left: "50%", top: -2, bottom: -2, borderLeft: `2px solid ${fg}` }} />
        </span>
        <span style={{ textAlign: "right", fontWeight: 700 }}>{r.r_share === null ? "n/a" : `${pct(r.r_share)} R`}{r.flagged ? " ⚠" : ""}</span>
      </div>)}
    </div>}
    <div style={{ marginTop: 10, fontSize: 11, color: dim }}>Cheat call = shoulder help on the way up vs your clean reps. Raw effort is relative (%MVC); front delt at about half the biceps is normal under load. Gray muscles are not measured. Not force, not medical.</div>
  </div>;
}

export default function MuscleMapWidget() {
  const { props, theme, callTool, isAvailable } = useWidget<Props>();
  const [fresh, setFresh] = useState<Props | null>(null);
  const action = useRef(callTool); action.current = callTool;
  const tool = props?.mode === "arms" ? "compare_arms" : "show_last_set";
  useEffect(() => {
    // Keep refreshing while it shows the latest set, so a live set fills in.
    if (!isAvailable || props?.selected_set_no != null) return;
    let disposed = false, busy = false;
    const refresh = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const r = await action.current(tool, {});
        if (!disposed && !r.isError && r.structuredContent) setFresh(r.structuredContent as unknown as Props);
      } catch { /* keep the last view */ } finally { busy = false; }
    };
    const timer = setInterval(() => void refresh(), 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [isAvailable, props?.selected_set_no, tool]);
  const view = fresh ?? props ?? {};
  return <McpUseProvider autoSize><MuscleMap p={view} dark={theme === "dark"} /></McpUseProvider>;
}
