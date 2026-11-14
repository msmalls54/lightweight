// Lift library: a separate view showing the same system for any muscle. Off the live path: loaded only when
// opened (Settings → Lift library, or #lifts), static data from /public/lifts.json + the two body maps.
(() => {
  "use strict";
  if (window.LWLifts) return;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const NS = "http://www.w3.org/2000/svg";
  let root = null, data = null, bodies = {}, selected = "curl";

  const CSS = `
  #lifts { position: fixed; inset: 0; z-index: 30; background: var(--bg); color: var(--text); display: grid; grid-template-rows: auto minmax(0, 1fr); }
  #lifts header { display: flex; align-items: center; gap: 16px; padding: 12px 24px; border-bottom: 1px solid var(--line); }
  #lifts .brand { font-size: var(--fs-l); font-weight: 600; }
  #lifts .brand span { color: var(--muted); font-weight: 400; }
  #lifts .lmain { display: grid; grid-template-columns: minmax(0, .78fr) minmax(0, 1.55fr) minmax(0, 1.05fr); gap: 16px; padding: 16px 24px; min-height: 0; }
  #lifts .card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 16px 20px; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
  #lifts .scroll { overflow-y: auto; min-height: 0; flex: 1 1 0; scrollbar-width: thin; scrollbar-color: #2C333C transparent; }
  #lifts .label { font-size: 11px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin: 0 0 10px; }
  #lifts .grp { margin-bottom: 14px; }
  #lifts .grp .gname { font-size: 11px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
  #lifts .lrow { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 8px; text-align: left; padding: 8px 10px; margin-bottom: 4px;
    border: 1px solid transparent; border-radius: 10px; background: transparent; color: var(--text); font-size: var(--fs-m); font-weight: 400; }
  #lifts .lrow:hover { background: #181C22; border-color: var(--line); }
  #lifts .lrow.sel { background: #181C22; border-color: #2C333C; font-weight: 600; }
  #lifts .badge { flex: none; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
  #lifts .badge.live { color: #0b2a17; background: var(--ok); border-color: var(--ok); }
  #lifts .bodies { flex: 1 1 0; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  #lifts .bview { min-height: 0; display: flex; flex-direction: column; align-items: center; }
  #lifts .bview .vname { font-size: 11px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
  #lifts .bview svg { flex: 1 1 0; min-height: 0; width: 100%; height: 100%; }
  #lifts .legend { flex: none; display: flex; justify-content: center; gap: 22px; margin-top: 10px; font-size: var(--fs-s); color: var(--muted); }
  #lifts .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
  #lifts h2 { font-size: var(--fs-l); font-weight: 600; margin: 0 0 8px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  #lifts .kv { display: grid; grid-template-columns: 7.2em minmax(0, 1fr); gap: 6px 12px; font-size: var(--fs-m); line-height: 1.4; margin-bottom: 12px; }
  #lifts .kv dt { color: var(--muted); font-size: var(--fs-s); padding-top: 2px; }
  #lifts .kv dd { margin: 0; }
  #lifts .tgt { color: var(--ok); font-weight: 600; } #lifts .chk { color: var(--warn); font-weight: 600; }
  #lifts ol.sensors { margin: 0 0 14px; padding-left: 0; list-style: none; font-size: var(--fs-s); }
  #lifts ol.sensors li { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 8px; margin: 6px 0; color: var(--muted); }
  #lifts ol.sensors li b { color: var(--text); font-weight: 600; }
  #lifts .num { width: 20px; height: 20px; border-radius: 50%; background: var(--text); color: var(--bg); font-size: 11px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; }
  #lifts .gen { border-top: 1px solid var(--line); padding-top: 12px; font-size: var(--fs-s); line-height: 1.5; color: var(--muted); }
  #lifts .gen p { margin: 0 0 8px; color: var(--text); font-size: var(--fs-m); }
  #lifts pre { margin: 8px 0 10px; padding: 10px 12px; border-radius: 10px; background: #0F1216; border: 1px solid var(--line); font: 12px/1.45 ui-monospace, Consolas, monospace; color: #C9CED6; white-space: pre-wrap; }
  #lifts ul.limits { margin: 0; padding-left: 18px; }
  #lifts ul.limits li { margin: 3px 0; }
  @media (max-width: 1000px), (max-height: 620px) { #lifts { overflow: auto; } #lifts .lmain { grid-template-columns: 1fr; } #lifts .card { min-height: 420px; } }`;

  function shapesFor(view) { return (bodies[view]?.shapes) || []; }
  function centroid(points) {
    const n = points.trim().split(/\s+/).map(Number); let x = 0, y = 0, k = 0;
    for (let i = 0; i + 1 < n.length; i += 2) { x += n[i]; y += n[i + 1]; k++; }
    return [x / k, y / k];
  }
  function drawBody(view) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", bodies[view].viewBox === "0 0 100 220" ? "-4 -4 108 228" : "-4 -4 108 208");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    for (const s of shapesFor(view)) {
      const p = document.createElementNS(NS, "polygon");
      p.setAttribute("points", s.points);
      p.dataset.key = `${s.muscle}/${s.side}`;
      p.setAttribute("fill", "#1E2228"); p.setAttribute("stroke", "#2A3038"); p.setAttribute("stroke-width", "0.4");
      p.style.transition = "fill 160ms ease";
      svg.appendChild(p);
    }
    // R / L marks: front view shows the person's right on the viewer's left; back view is the opposite.
    for (const [x, t] of view === "front" ? [[4, "R"], [96, "L"]] : [[4, "L"], [96, "R"]]) {
      const tx = document.createElementNS(NS, "text");
      tx.setAttribute("x", x); tx.setAttribute("y", 30); tx.setAttribute("fill", "#8A9099"); tx.setAttribute("font-size", "7"); tx.setAttribute("font-weight", "600"); tx.setAttribute("text-anchor", "middle");
      tx.textContent = t; svg.appendChild(tx);
    }
    const dots = document.createElementNS(NS, "g"); dots.setAttribute("class", "dots"); svg.appendChild(dots);
    return svg;
  }
  function paint(lift) {
    const tgt = new Set(lift.target.map(t => `${t.v}|${t.m}`)), chk = new Set(lift.cheat.map(t => `${t.v}|${t.m}`));
    for (const view of ["front", "back"]) {
      const svg = root.querySelector(`[data-view="${view}"] svg`);
      for (const p of svg.querySelectorAll("polygon")) {
        const m = p.dataset.key.split("/")[0];
        const k = `${view}|${m}`;
        p.setAttribute("fill", tgt.has(k) ? "rgba(34,197,94,.78)" : chk.has(k) ? "rgba(245,158,11,.82)" : "#1E2228");
      }
      const g = svg.querySelector("g.dots"); g.innerHTML = "";
      lift.sensors.forEach((s, i) => {
        if (s.v !== view) return;
        const poly = shapesFor(view).find(sh => sh.muscle === s.m && sh.side === s.side) || shapesFor(view).find(sh => sh.muscle === s.m);
        if (!poly) return;
        const [cx, cy] = centroid(poly.points);
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", "3.2"); c.setAttribute("fill", "#E8EAED"); c.setAttribute("stroke", "#0B0D10"); c.setAttribute("stroke-width", "0.8");
        const t = document.createElementNS(NS, "text");
        t.setAttribute("x", cx); t.setAttribute("y", cy + 1.5); t.setAttribute("font-size", "4"); t.setAttribute("font-weight", "600"); t.setAttribute("text-anchor", "middle"); t.setAttribute("fill", "#0B0D10");
        t.textContent = String(i + 1);
        g.appendChild(c); g.appendChild(t);
      });
    }
  }
  const muscleName = m => ({ "front-deltoids": "front delt", "back-deltoids": "rear delt", "upper-back": "lats / upper back", "lower-back": "lower back", gluteal: "glutes", hamstring: "hamstrings", quadriceps: "quads", trapezius: "upper traps", abs: "abs", chest: "chest", biceps: "biceps", triceps: "triceps", calves: "calves" }[m] || m);
  function details(lift) {
    const badge = lift.status === "live" ? '<span class="badge live">Live today</span>' : '<span class="badge">Config ready · not yet tested</span>';
    const names = list => [...new Set(list.map(t => muscleName(t.m)))].join(", ");
    root.querySelector(".ldetail").innerHTML = `
      <h2>${esc(lift.name)} ${badge}</h2>
      <dl class="kv">
        <dt>Target</dt><dd class="tgt">${esc(names(lift.target))}</dd>
        <dt>Cheat check</dt><dd class="chk">${esc(names(lift.cheat))}</dd>
        <dt>Catches</dt><dd>${esc(lift.catches)}</dd>
      </dl>
      <div class="label">Sensors (${lift.sensors.length} of 4)</div>
      <ol class="sensors">${lift.sensors.map((s, i) => `<li><span class="num">${i + 1}</span><span><b>${esc(s.label)}</b> · ${esc(s.where)}</span></li>`).join("")}</ol>
      <div class="gen">
        <div class="label">How it generalizes</div>
        <p>One engine, one rule: the cheat-check muscle's share of the lifting phase, compared with <b>your</b> clean reps. A new lift is a config entry, not new code.</p>
        <pre>${esc(JSON.stringify({ lift: lift.id, ...lift.config }, null, 2))}</pre>
        <ul class="limits">
          <li>Only curls are validated with real data today.</li>
          <li>Surface EMG reads superficial muscles only; neighbouring muscles cross-talk.</li>
          <li>Four sensors at a time.</li>
          <li>Each lift needs its own placement guide and its own validation before it's trusted.</li>
        </ul>
      </div>`;
  }
  function select(id) {
    selected = id;
    const lift = data.lifts.find(l => l.id === id) || data.lifts[0];
    for (const b of root.querySelectorAll(".lrow")) b.classList.toggle("sel", b.dataset.id === lift.id);
    paint(lift); details(lift);
  }
  async function build() {
    const [lifts, front, back] = await Promise.all([fetch("/public/lifts.json").then(r => r.json()), fetch("/muscle-map.json").then(r => r.json()), fetch("/public/body-posterior.json").then(r => r.json())]);
    data = lifts; bodies = { front, back };
    const style = document.createElement("style"); style.textContent = CSS; document.head.appendChild(style);
    root = document.createElement("div");
    root.id = "lifts";
    root.innerHTML = `
      <header><div class="brand">Lightweight <span>· Lift library</span></div><span style="flex:1"></span><button id="liftsBack" class="primary">Back to dashboard<kbd>Esc</kbd></button></header>
      <div class="lmain">
        <section class="card"><div class="label">Lifts</div><div class="scroll lpick"></div></section>
        <section class="card">
          <div class="bodies"><div class="bview" data-view="front"><div class="vname">Front</div></div><div class="bview" data-view="back"><div class="vname">Back</div></div></div>
          <div class="legend"><span><i style="background:rgba(34,197,94,.78)"></i>Target</span><span><i style="background:rgba(245,158,11,.82)"></i>Cheat check</span><span><i style="background:#E8EAED;border-radius:50%"></i>Sensor pad</span></div>
        </section>
        <section class="card"><div class="scroll ldetail"></div></section>
      </div>`;
    const pick = root.querySelector(".lpick");
    for (const g of data.groups) {
      const items = data.lifts.filter(l => l.group === g);
      if (!items.length) continue;
      const div = document.createElement("div"); div.className = "grp";
      div.innerHTML = `<div class="gname">${esc(g)}</div>`;
      for (const l of items) {
        const b = document.createElement("button"); b.className = "lrow"; b.dataset.id = l.id;
        b.innerHTML = `<span>${esc(l.name)}</span>${l.status === "live" ? '<span class="badge live">Live</span>' : '<span class="badge">Config</span>'}`;
        b.onclick = () => select(l.id);
        div.appendChild(b);
      }
      pick.appendChild(div);
    }
    root.querySelector('[data-view="front"]').appendChild(drawBody("front"));
    root.querySelector('[data-view="back"]').appendChild(drawBody("back"));
    root.querySelector("#liftsBack").onclick = close;
    document.body.appendChild(root);
    select(selected);
  }
  // While the library is open, no key reaches the dashboard (Space would start a set).
  function onKey(e) { e.stopPropagation(); if (e.key === "Escape") close(); }
  async function open() {
    if (!root) await build(); else root.style.display = "";
    document.addEventListener("keydown", onKey, true);
    if (location.hash !== "#lifts") history.replaceState(null, "", "#lifts");
  }
  function close() {
    if (root) root.style.display = "none";
    document.removeEventListener("keydown", onKey, true);
    if (location.hash === "#lifts") history.replaceState(null, "", location.pathname + location.search);
  }
  window.LWLifts = { open, close, select: id => { if (root) select(id); else selected = id; } };
})();
