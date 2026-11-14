// Lightweight dashboard. Plain browser JS, no build step.
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const CH_INFO = [
    { name: "R biceps", arm: "Right", muscle: "biceps", side: "right", kind: "bi" },
    { name: "R delt", arm: "Right", muscle: "front-deltoids", side: "right", kind: "delt" },
    { name: "L biceps", arm: "Left", muscle: "biceps", side: "left", kind: "bi" },
    { name: "L delt", arm: "Left", muscle: "front-deltoids", side: "left", kind: "delt" },
  ];
  const BAR_MAX = 1.5; // %MVC shown at the top of a bar
  const pct = x => `${Math.round(x * 100)}%`;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ------------------------------------------------------------ audio (voice-player.js is optional)
  function speakFallback(text) {
    if (!("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
  function playClip(key) {
    if (!key) return;
    const A = window.LWAudio;
    if (A && typeof A.playClip === "function") { try { A.playClip(key); } catch (e) { console.warn("playClip failed", e); } return; }
    speakFallback(key.replace(/_/g, " "));
  }
  function say(text) {
    if (!text) return;
    const A = window.LWAudio;
    if (A && typeof A.say === "function") { try { A.say(text); } catch (e) { console.warn("say failed", e); } return; }
    speakFallback(text);
  }

  // ------------------------------------------------------------ API
  async function post(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
    if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  let toastTimer;
  function toast(msg, ms = 4000) {
    const t = $("toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), ms);
  }
  const run = fn => async () => { try { await fn(); } catch (e) { toast(e.message, 6000); } };

  // ------------------------------------------------------------ bars
  const bars = CH_INFO.map((c, i) => {
    const el = document.createElement("div");
    el.className = `bar ${c.kind}`;
    el.innerHTML = `<div class="val">0%</div><div class="track"><div class="mvc" style="bottom:${(100 / BAR_MAX).toFixed(1)}%"></div><div class="fill"></div></div>
      <div class="lbl">${c.arm}<small>${c.kind === "bi" ? "biceps · target" : "front delt · snitch"}</small></div>`;
    $("bars").appendChild(el);
    return { el, val: el.querySelector(".val"), fill: el.querySelector(".fill"), i };
  });

  // ------------------------------------------------------------ muscle map
  const mapShapes = {}; // "biceps/right" -> [polygon]
  fetch("/muscle-map.json").then(r => r.json()).then(data => {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "-4 -4 108 208");
    const tracked = new Set(CH_INFO.map(c => `${c.muscle}/${c.side}`));
    for (const s of data.shapes) {
      const p = document.createElementNS(NS, "polygon");
      p.setAttribute("points", s.points);
      const key = `${s.muscle}/${s.side}`;
      p.setAttribute("fill", tracked.has(key) ? "#2b303b" : "#3a3f4b");
      p.setAttribute("stroke", tracked.has(key) ? "#6b7385" : "#4a505e");
      p.setAttribute("stroke-width", tracked.has(key) ? "0.6" : "0.3");
      if (tracked.has(key)) (mapShapes[key] ||= []).push(p);
      svg.appendChild(p);
    }
    for (const [x, t] of [[6, "R"], [94, "L"]]) {
      const tx = document.createElementNS(NS, "text");
      tx.setAttribute("x", x); tx.setAttribute("y", 30); tx.setAttribute("fill", "#8a93a6");
      tx.setAttribute("font-size", "9"); tx.setAttribute("font-weight", "700"); tx.setAttribute("text-anchor", "middle");
      tx.textContent = t; svg.appendChild(tx);
    }
    $("map").appendChild(svg);
  }).catch(() => { $("map").textContent = "Muscle map not available"; });

  function heat(v) { // 0..1 -> dark gray to red
    const t = Math.max(0, Math.min(1, v));
    const a = [43, 48, 59], b = [255, 45, 45];
    return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * t)).join(",")})`;
  }

  // ------------------------------------------------------------ live render loop
  let live = [0, 0, 0, 0], liveAt = 0;
  let activeArms = ["R", "L"];
  function frame() {
    const stale = performance.now() - liveAt > 1500;
    bars.forEach(b => {
      const v = live[b.i] || 0;
      b.fill.style.height = `${Math.min(100, (v / BAR_MAX) * 100)}%`;
      b.val.textContent = pct(v);
      b.el.classList.toggle("hot", CH_INFO[b.i].kind === "delt" && v > 0.5);
      b.el.classList.toggle("stale", stale);
      const used = activeArms.includes(b.i < 2 ? "R" : "L");
      b.el.style.opacity = used ? "1" : "0.35";
    });
    CH_INFO.forEach((c, i) => {
      for (const p of mapShapes[`${c.muscle}/${c.side}`] || []) p.setAttribute("fill", heat(stale ? 0 : live[i] || 0));
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ------------------------------------------------------------ set + rep feed
  // Bilateral sets emit one rep event per arm; count by rep number (a rep is a cheat if either arm cheated).
  const newSet = () => ({ set_no: null, reps: new Map() });
  let setState = newSet();
  let currentSetId = null;
  function renderSetLine() {
    const n = setState.reps.size, cheat = [...setState.reps.values()].filter(Boolean).length;
    $("setline").innerHTML = currentSetId || n
      ? `Set ${setState.set_no ?? "–"} · Rep ${n} <span class="cnt-clean">${n - cheat} clean</span> · <span class="cnt-cheat">${cheat} cheat</span>`
      : "Ready";
  }
  function addFeed(html, cls) {
    const li = document.createElement("li");
    li.className = `${cls} fresh`;
    li.innerHTML = html;
    const feed = $("feed");
    feed.prepend(li);
    while (feed.children.length > 40) feed.lastChild.remove();
    setTimeout(() => li.classList.remove("fresh"), 600);
  }
  function repHtml(r) {
    const armName = r.arm === "L" ? "Left" : "Right";
    const bi = r.arm === "L" ? 2 : 0, de = bi + 1;
    const why = r.cheat ? (r.cheat_reason === "delt_peak" ? "DELT SPIKE" : "DELT TOOK OVER") : "CLEAN";
    const bal = r.r_share != null ? ` · R/L ${Math.round(r.r_share * 100)}/${Math.round((1 - r.r_share) * 100)}` : "";
    const base = r.baseline_delt_share != null ? ` (base ${pct(r.baseline_delt_share)})` : "";
    return `<span class="t">${r.set_no ? `S${r.set_no} · ` : ""}Rep ${r.rep}${activeArms.length > 1 ? ` · ${armName}` : ""}</span><span class="tag">${why}</span>
      <span class="d">delt share ${pct(r.delt_share)}${base} · biceps peak ${pct(r.peak_pct[bi])} · delt peak ${pct(r.peak_pct[de])}${bal}</span>`;
  }
  let bannerTimer;
  function banner(text) {
    $("bannerText").textContent = text;
    $("banner").classList.add("show");
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => $("banner").classList.remove("show"), 3500);
  }
  const cuePlayed = new Map(); // "set:rep" -> {cheat, arms}
  function onRep(r, fresh) {
    if (r.set_id !== currentSetId) { currentSetId = r.set_id; setState = newSet(); }
    setState.set_no = r.set_no ?? setState.set_no;
    setState.reps.set(r.rep, !!(setState.reps.get(r.rep) || r.cheat));
    renderSetLine();
    addFeed(repHtml(r), r.cheat ? "cheat" : "");
    if (!fresh) return;
    const key = `${r.set_id}:${r.rep}`, prev = cuePlayed.get(key);
    const cheatArms = new Set(prev?.cheatArms ?? []);
    if (r.cheat) cheatArms.add(r.arm);
    if (r.cheat) {
      const arm = activeArms.length < 2 ? "" : cheatArms.size > 1 ? " (BOTH ARMS)" : ` (${r.arm === "L" ? "LEFT" : "RIGHT"})`;
      banner(`REP ${r.rep}${arm}: DELT TOOK OVER`);
    }
    // One call-out per rep number: the other arm's event only speaks if it upgrades clean -> cheat.
    if (!prev || (r.cheat && !prev.cheat)) playClip(r.cue);
    cuePlayed.set(key, { cheat: !!(prev?.cheat || r.cheat), cheatArms: [...cheatArms] });
    if (cuePlayed.size > 200) cuePlayed.delete(cuePlayed.keys().next().value);
  }
  function onSetEnd(e) {
    const total = e.clean + e.cheats;
    addFeed(`<span class="t">Set ${e.set_no ?? ""} done</span><span class="tag" style="color:var(--blue)">${total} reps</span>
      <span class="d">${e.clean} clean · ${e.cheats} cheat${e.first_cheat_rep ? ` · first cheat rep ${e.first_cheat_rep}` : ""} · next: ${esc(e.decision?.next ?? "")}</span>`, "setend");
    currentSetId = null;
    $("coach").textContent = "Coach is thinking…";
  }

  // ------------------------------------------------------------ status
  function ago(ms) { return ms == null ? "never" : ms < 1500 ? "now" : `${Math.round(ms / 1000)} s ago`; }
  let lastStatus = null;
  function onStatus(s) {
    lastStatus = s;
    const d = s.device;
    $("devDot").className = `dot ${d.streaming ? "on" : d.last_batch_age_ms == null ? "" : "off"}`;
    $("devText").textContent = d.streaming ? `Device streaming · ${d.batches_per_s.toFixed(1)} batches/s` : d.last_batch_age_ms == null ? "No device yet" : `Device silent · last ${ago(d.last_batch_age_ms)}`;
    const hb = d.heartbeat;
    $("hbText").textContent = hb ? `Heartbeat ${ago(hb.age_ms)} · RSSI ${hb.rssi ?? "?"} · queue ${hb.queue ?? "?"}` : "Heartbeat: none";
    const m = $("mode");
    m.textContent = s.mode === "replay" ? `REPLAY ${s.replay ? `${Math.round((s.replay.i / s.replay.n) * 100)}%` : ""}` : "LIVE";
    m.classList.toggle("replay", s.mode === "replay");
    const ss = s.session;
    if (ss) {
      activeArms = s.set?.arms ?? ss.arms;
      $("who").innerHTML = `${esc(ss.person)}${ss.walkup ? " <small>walk-up</small>" : ""} <small>${ss.calibrated ? (ss.cal_problems.length ? "calibrated ⚠" : "calibrated ✓") : ss.calibrating ? "calibrating…" : "not calibrated (raw)"}</small>`;
    } else $("who").textContent = "No session";
    if (s.set) {
      $("setmeta").textContent = `${s.set.exercise} · ${s.set.variant}${s.set.load_lb != null ? ` · ${s.set.load_lb} lb` : ""} · ${s.set.arms.join("+")} · set armed${s.set.set_no ? ` (#${s.set.set_no})` : ", waiting for first rep"}`;
    } else $("setmeta").textContent = ss?.calibrating ? "Calibrating…" : "No set armed. Press Start set.";
    $("btnReplayStop").disabled = s.mode !== "replay";
    $("btnReplay").disabled = s.mode === "replay";
  }

  // ------------------------------------------------------------ SSE
  let es;
  function connect() {
    es = new EventSource("/events");
    es.onopen = () => { $("sseDot").className = "dot on"; $("sseText").textContent = "Dashboard linked"; };
    es.onerror = () => { $("sseDot").className = "dot off"; $("sseText").textContent = "Server link lost, retrying"; };
    es.onmessage = ev => {
      let e; try { e = JSON.parse(ev.data); } catch { return; }
      switch (e.type) {
        case "live": live = e.pct; liveAt = performance.now(); break;
        case "status": onStatus(e); break;
        case "history":
          $("feed").innerHTML = ""; currentSetId = null; setState = newSet();
          for (const r of e.reps) onRep(r, false);
          break;
        case "rep": onRep(e, true); break;
        case "set_end": onSetEnd(e); break;
        case "coach":
          if (e.text) { $("coach").textContent = e.text; say(e.text); }
          else { $("coach").textContent = ""; playClip(e.fallback_clip); }
          break;
        case "calibration": onCalEvent(e); break;
        case "calibrate_request": calibrate(); break;
        case "session":
          $("feed").innerHTML = ""; currentSetId = null; setState = newSet(); renderSetLine(); $("coach").textContent = "";
          toast(`New session: ${e.person}${e.walkup ? " (walk-up)" : ""}`);
          break;
        case "replay":
          if (e.phase === "start") { $("feed").innerHTML = ""; currentSetId = null; setState = newSet(); renderSetLine(); toast("Replay started"); }
          else { toast(`Replay ${e.phase}`); loadSessions(); }
          break;
      }
    };
  }
  connect();

  // ------------------------------------------------------------ calibration flow
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let calRunning = false, calAbort = false;
  function calShow(step, title, hint, go) {
    $("calStep").textContent = step; $("calTitle").textContent = title; $("calHint").textContent = hint || "";
    $("calTitle").classList.toggle("go", !!go);
  }
  async function countdown(sec) {
    for (let s = sec; s > 0; s--) { if (calAbort) throw new Error("cancelled"); $("calCount").textContent = s; await sleep(1000); }
    $("calCount").textContent = "";
  }
  async function calibrate() {
    if (calRunning) return;
    calRunning = true; calAbort = false;
    $("cal").classList.add("show"); $("calResult").innerHTML = ""; $("calClose").style.display = "none"; $("calCancel").style.display = "";
    try {
      const { arms } = await post("/calibrate/begin");
      const steps = [];
      for (const a of ["R", "L"]) if (arms.includes(a)) {
        const side = a === "R" ? "RIGHT" : "LEFT", base = a === "R" ? 0 : 2;
        steps.push({ ch: base, title: `${side} BICEPS`, hint: "Curl up and squeeze as hard as you can. Hold." });
        steps.push({ ch: base + 1, title: `${side} FRONT DELT`, hint: "Front raise, straight arm, and hold it up." });
      }
      const total = steps.length + 1;
      calShow(`Step 1 / ${total}`, "RELAX", "Arms down, loose. Don't move.");
      playClip("calibrate_relax");
      await countdown(3);
      await post("/calibrate/capture", { step: "rest", window_ms: 2500 });
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        calShow(`Step ${i + 2} / ${total} · get ready`, s.title, s.hint);
        $("calCount").textContent = "…";
        await sleep(1500);
        if (calAbort) throw new Error("cancelled");
        calShow(`Step ${i + 2} / ${total}`, `FLEX! ${s.title}`, s.hint, true);
        playClip("calibrate_flex");
        await countdown(3);
        await post("/calibrate/capture", { step: "mvc", ch: s.ch, window_ms: 2500 });
      }
      calShow("Done", "CALIBRATED", "");
      const { calibration: c } = await post("/calibrate");
      $("calResult").innerHTML = c.problems?.length
        ? `<div class="bad">Check: ${c.problems.map(esc).join("<br>")}</div><div>Fix the pad and recalibrate, or carry on.</div>`
        : `<div class="good">All channels look good.</div>` +
          `<div style="color:var(--dim);font-size:18px">rest ${c.rest.map(Math.round).join(" / ")} · mvc ${c.mvc.map(Math.round).join(" / ")}</div>`;
      $("calTitle").textContent = c.problems?.length ? "CALIBRATED ⚠" : "CALIBRATED ✓";
      $("calCancel").style.display = "none"; $("calClose").style.display = "";
      if (!c.problems?.length) setTimeout(() => { if (!calRunning) $("cal").classList.remove("show"); }, 2500);
    } catch (e) {
      if (e.message !== "cancelled") toast(`Calibration: ${e.message}`, 7000);
      post("/calibrate/cancel").catch(() => {});
      $("cal").classList.remove("show");
    } finally { calRunning = false; $("calCount").textContent = ""; }
  }
  function onCalEvent(e) {
    if (calRunning) return; // our own flow shows it
    if (e.phase === "begin") toast(`Calibration started${e.replay ? " (replay)" : ""}`);
    else if (e.phase === "captured") toast(`Calibration: captured ${e.step === "rest" ? "rest" : CH_INFO[e.ch].name}`, 2500);
    else if (e.phase === "done") toast(e.problems?.length ? `Calibrated with warnings: ${e.problems.join("; ")}` : "Calibrated ✓", 5000);
  }
  $("calCancel").onclick = () => { calAbort = true; };
  $("calClose").onclick = () => $("cal").classList.remove("show");

  // ------------------------------------------------------------ controls
  const arms = () => { const a = []; if ($("armR").checked) a.push("R"); if ($("armL").checked) a.push("L"); return a.length ? a : ["R"]; };
  $("btnNew").onclick = run(() => post("/session/start", { person: "Mike", walkup: false, arms: arms() }));
  $("btnWalkup").onclick = run(async () => {
    const name = (prompt("Walk-up's name?") || "").trim();
    if (!name) return;
    $("armR").checked = true; $("armL").checked = false;
    await post("/session/start", { person: name, walkup: true, arms: ["R"] });
  });
  $("btnCal").onclick = () => calibrate();
  const startSet = run(() => post("/set/start", {
    exercise: $("exercise").value || "dumbbell curl", variant: $("variant").value,
    load_lb: Number($("load").value) || undefined, arms: arms(), auto_next: $("autoNext").checked,
  }));
  const stopSet = run(() => post("/set/stop"));
  $("btnStart").onclick = startSet;
  $("btnStop").onclick = stopSet;
  $("btnReplay").onclick = run(async () => {
    const id = $("replaySel").value;
    if (!id) throw new Error("No recorded session to replay yet.");
    await post(`/replay/${encodeURIComponent(id)}`);
  });
  $("btnReplayStop").onclick = run(() => post("/replay/stop"));
  document.addEventListener("keydown", e => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "c") calibrate(); else if (k === "s") startSet(); else if (k === "x") stopSet();
  });

  async function loadSessions() {
    try {
      const { sessions } = await (await fetch("/sessions")).json();
      const sel = $("replaySel"), keep = sel.value;
      sel.innerHTML = "";
      for (const s of sessions.filter(s => s.batches > 0 && s.kind !== "replay")) {
        const o = document.createElement("option");
        o.value = s.session_id;
        const mins = (s.batches * 0.2 / 60).toFixed(1);
        o.textContent = `${s.started_at.slice(11, 16)}Z · ${s.person}${s.kind === "fake" ? " (fake)" : ""} · ${s.reps} reps, ${s.cheats} cheat · ${mins} min`;
        sel.appendChild(o);
      }
      if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
      if (!sel.options.length) sel.innerHTML = "<option value=''>No recordings yet</option>";
    } catch { /* server down; the SSE dot shows it */ }
  }
  loadSessions();
  setInterval(loadSessions, 15000);

  // ------------------------------------------------------------ music
  const audio = $("music");
  let playlist = [], track = 0;
  function playTrack(i) {
    if (!playlist.length) return;
    track = (i + playlist.length) % playlist.length;
    audio.src = playlist[track].url;
    audio.play().catch(() => {});
  }
  $("musicFiles").onchange = e => {
    for (const p of playlist) URL.revokeObjectURL(p.url);
    playlist = [...e.target.files].map(f => ({ name: f.name, url: URL.createObjectURL(f) }));
    playTrack(0);
  };
  audio.addEventListener("ended", () => playTrack(track + 1));
  function hookMusic() {
    if (window.LWAudio && typeof window.LWAudio.setMusic === "function") { try { window.LWAudio.setMusic(audio); } catch (e) { console.warn(e); } return true; }
    return false;
  }
  if (!hookMusic()) window.addEventListener("load", hookMusic);
  if (window.__lwNoVoice) console.info("voice-player.js not found; using browser speech as a fallback.");
})();
