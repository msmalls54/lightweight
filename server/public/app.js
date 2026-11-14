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
  // ?mute=1: no voice at all (testing at the venue). Cue keys are still logged to the console.
  const MUTED = new URLSearchParams(location.search).has("mute");
  if (MUTED) document.title = "Lightweight (muted)";
  // Only ONE dashboard speaks: the server picks the speaker (oldest non-muted tab; click the pill to
  // take over). Every other tab shows text only and never calls /voice/say.
  let isSpeaker = false, clientId = null;
  const silent = () => MUTED || !isSpeaker;
  function speakFallback(text) {
    if (silent() || !("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
  function playClip(keys) { // a clip key or an array of keys stitched in order (e.g. ["rep_6", "delt_took_over"])
    if (!keys || (Array.isArray(keys) && !keys.length)) return;
    if (silent()) { console.info("[cue]", keys); return; }
    const A = window.LWAudio;
    if (A && typeof A.playClip === "function") { try { A.playClip(keys); } catch (e) { console.warn("playClip failed", e); } return; }
    speakFallback([].concat(keys).map(k => k.replace(/_/g, " ")).join(". "));
  }
  function say(text) {
    if (!text) return;
    if (silent()) { console.info("[say]", text); return; }
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
    el.className = `raw ${c.kind}`;
    el.innerHTML = `<span class="lbl">${c.arm} ${c.kind === "bi" ? "biceps" : "front delt"}</span><div class="track"><div class="fill"></div><div class="mvc" style="left:${(100 / BAR_MAX).toFixed(1)}%"></div></div><span class="val">0%</span>`;
    $("bars").appendChild(el);
    return { el, val: el.querySelector(".val"), fill: el.querySelector(".fill"), i };
  });

  // ------------------------------------------------------------ muscle map
  const mapShapes = {}; // "biceps/right" -> [polygon]
  fetch("/muscle-map.json").then(r => r.json()).then(data => {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "-4 -4 108 208");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    const tracked = new Set(CH_INFO.map(c => `${c.muscle}/${c.side}`));
    for (const s of data.shapes) {
      const p = document.createElementNS(NS, "polygon");
      p.setAttribute("points", s.points);
      const key = `${s.muscle}/${s.side}`;
      p.setAttribute("fill", tracked.has(key) ? "#252A32" : "#1A1E24");
      p.setAttribute("stroke", tracked.has(key) ? "#3A414B" : "#22272E");
      p.setAttribute("stroke-width", tracked.has(key) ? "0.5" : "0.3");
      if (tracked.has(key)) (mapShapes[key] ||= []).push(p);
      svg.appendChild(p);
    }
    for (const [x, t] of [[6, "R"], [94, "L"]]) {
      const tx = document.createElementNS(NS, "text");
      tx.setAttribute("x", x); tx.setAttribute("y", 30); tx.setAttribute("fill", "#8A9099");
      tx.setAttribute("font-size", "8"); tx.setAttribute("font-weight", "600"); tx.setAttribute("text-anchor", "middle");
      tx.textContent = t; svg.appendChild(tx);
    }
    $("map").appendChild(svg);
  }).catch(() => { $("map").textContent = "Muscle map not available"; });

  function heat(v) { // 0..1 -> dark gray to red
    const t = Math.max(0, Math.min(1, v));
    const a = [37, 42, 50], b = [239, 68, 68];
    return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * t)).join(",")})`;
  }

  // ------------------------------------------------------------ live render loop
  let live = [0, 0, 0, 0], liveAt = 0;
  let activeArms = ["R", "L"];
  function frame() {
    const stale = performance.now() - liveAt > 1500;
    bars.forEach(b => {
      const v = live[b.i] || 0;
      b.fill.style.width = `${Math.min(100, (v / BAR_MAX) * 100)}%`;
      b.val.textContent = pct(v);
      b.el.classList.toggle("hot", CH_INFO[b.i].kind === "delt" && v > 0.5);
      b.el.classList.toggle("stale", stale);
      const used = activeArms.includes(b.i < 2 ? "R" : "L");
      b.el.style.opacity = used ? "1" : "0.35";
    });
    for (const arm of ["R", "L"]) meters[arm].classList.toggle("off", !activeArms.includes(arm));
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
      ? `Rep ${n}<span class="counts">Set ${setState.set_no ?? "–"} · <b>${n - cheat}</b> clean · <b>${cheat}</b> cheat</span>`
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
  // ------------------------------------------------------------ cheat meter (per arm)
  // Up-phase shoulder help as a multiple of the arm's clean reference: up_delt_ratio / baseline_up_delt_ratio.
  // Zones: green < 1.2x, amber 1.2-1.35x, red >= 1.35x. The verdict is the CODE's flag: rep.cheat -> CHEAT.
  const METER_MAX = 2; // gauge scale 0..2x; bigger values pin to the right edge with their number
  function repMultiple(r) {
    const up = r.up_delt_ratio, base = r.baseline_up_delt_ratio;
    return up != null && base != null && base > 0 ? up / base : null;
  }
  function verdictOf(r) {
    const m = repMultiple(r);
    if (r.cheat) return "CHEAT";
    if (m != null && m >= 1.2) return "LOOSE";
    return "CLEAN";
  }
  const fmtX = m => (m >= 10 ? `${Math.round(m)}×` : `${m.toFixed(1)}×`);
  const VERDICT_LABEL = { CLEAN: "Clean", LOOSE: "Loose", CHEAT: "Cheat" };
  const meters = {};
  for (const arm of ["R", "L"]) {
    const el = document.createElement("div");
    el.className = "meter";
    el.innerHTML = `<div class="m-top"><span class="side">${arm === "R" ? "Right arm" : "Left arm"}</span><span>Shoulder help vs your clean rep</span></div>
      <div class="verdict">–</div>
      <div class="gauge"><div class="z zg"></div><div class="z za"></div><div class="z zr"></div><div class="mk" style="display:none"></div><div class="mv"></div><div class="learn"></div></div>
      <div class="m-foot"><span class="msub">Learning your clean rep (2 reps)</span><span class="scale"><span>0×</span><span>1.2×</span><span>2×</span></span></div>`;
    $("meters").appendChild(el);
    meters[arm] = el;
  }
  function resetMeters() {
    for (const arm of ["R", "L"]) {
      const el = meters[arm];
      el.classList.remove("cheat", "loose", "clean");
      el.querySelector(".mk").style.display = "none";
      el.querySelector(".mv").textContent = "";
      el.querySelector(".verdict").textContent = "–";
      el.querySelector(".msub").textContent = "Learning your clean rep (2 reps)";
    }
  }
  function updateMeter(r) {
    const el = meters[r.arm];
    if (!el) return;
    const m = repMultiple(r), v = verdictOf(r);
    el.classList.remove("cheat", "loose", "clean");
    el.classList.add(v === "CHEAT" ? "cheat" : v === "LOOSE" ? "loose" : "clean");
    const mk = el.querySelector(".mk"), msub = el.querySelector(".msub");
    if (m == null) {
      mk.style.display = "none";
      msub.textContent = r.cheat ? `Rep ${r.rep} · no clean reference yet, obvious swing` : `Rep ${r.rep} · learning your clean rep (${Math.min(r.rep, 2)} of 2)`;
    } else {
      const x = Math.min(m, METER_MAX) / METER_MAX * 100;
      mk.style.display = ""; mk.style.left = `${Math.max(1, Math.min(99, x))}%`;
      msub.textContent = `Rep ${r.rep}`;
    }
    el.querySelector(".verdict").innerHTML = `${VERDICT_LABEL[v]}${m != null ? `<span class="mx">${fmtX(m)}</span>` : ""}`;
  }
  function pulseMap(r) {
    const side = r.arm === "L" ? "left" : "right";
    const key = r.cheat ? `front-deltoids/${side}` : `biceps/${side}`;
    const cls = r.cheat ? "pulse-red" : "pulse-green";
    for (const p of mapShapes[key] || []) {
      p.classList.remove("pulse-red", "pulse-green");
      void p.getBBox(); // restart the animation
      p.classList.add(cls);
      setTimeout(() => p.classList.remove(cls), 1700);
    }
  }

  // "Set N report" card from the coach's detailed summary (headline, bullets, cue, engine decision).
  function renderReport(e) {
    const d = e.detail;
    if (!d) return;
    const dec = d.decision ? `${esc(d.decision.next.replace(/_/g, " "))}${d.decision.reason ? `: ${esc(d.decision.reason)}` : ""}` : "";
    $("report").innerHTML = `<div class="r-head"><span>Set ${e.set_no ?? ""} report · ${esc(d.headline || "")}</span><span class="src">${esc(d.source || "")}</span></div>
      <ul>${(d.bullets || []).map(b => `<li>${esc(b)}</li>`).join("")}</ul>
      ${d.cue ? `<div class="r-cue"><b>Cue</b>${esc(d.cue)}</div>` : ""}
      ${dec ? `<div class="r-dec"><b>Decision</b>${dec}</div>` : ""}`;
  }

  function repHtml(r) {
    const armName = r.arm === "L" ? "Left" : "Right";
    const bi = r.arm === "L" ? 2 : 0, de = bi + 1;
    const v = verdictOf(r), m = repMultiple(r);
    const cls = v.toLowerCase();
    const bal = r.r_share != null ? ` · R/L ${Math.round(r.r_share * 100)}/${Math.round((1 - r.r_share) * 100)}` : "";
    const base = r.baseline_delt_share != null ? ` (base ${pct(r.baseline_delt_share)})` : "";
    return `<span class="v ${cls}"></span><span class="t">Rep ${r.rep} <span class="arm">· ${armName}</span></span><span class="x" title="shoulder help vs your clean rep">${m != null ? fmtX(m) : ""}</span><span class="w ${cls}">${VERDICT_LABEL[v]}${r.cheat && r.cheat_reason === "delt_peak" ? " · spike" : ""}</span>
      <span class="d">Delt share ${pct(r.delt_share)}${base} · biceps peak ${pct(r.peak_pct[bi])} · delt peak ${pct(r.peak_pct[de])}${bal}</span>`;
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
    addFeed(repHtml(r), "");
    updateMeter(r);
    if (!fresh) return;
    pulseMap(r);
    const key = `${r.set_id}:${r.rep}`, prev = cuePlayed.get(key);
    const cheatArms = new Set(prev?.cheatArms ?? []);
    if (r.cheat) cheatArms.add(r.arm);
    if (r.cheat) {
      const arm = activeArms.length < 2 ? "" : cheatArms.size > 1 ? " · both arms" : ` · ${r.arm === "L" ? "left" : "right"} arm`;
      banner(`Rep ${r.rep}${arm}: the front delt took over`);
    }
    // One call-out per rep number: the other arm's event only speaks if it upgrades clean -> cheat.
    if (!prev || (r.cheat && !prev.cheat)) playClip(r.cue);
    cuePlayed.set(key, { cheat: !!(prev?.cheat || r.cheat), cheatArms: [...cheatArms] });
    if (cuePlayed.size > 200) cuePlayed.delete(cuePlayed.keys().next().value);
  }
  function onSetEnd(e) {
    if (e.too_short) {
      addFeed(`<span class="v none"></span><span class="t">Set ${e.set_no ?? ""} done · ${e.n_reps} rep${e.n_reps === 1 ? "" : "s"}</span><span class="x"></span><span class="w none">Too short</span>`, "setend");
      currentSetId = null;
      $("coach").textContent = `Set too short (${e.n_reps} rep${e.n_reps === 1 ? "" : "s"}): no summary.`;
      return;
    }
    playClip(e.cue);
    const total = e.clean + e.cheats;
    addFeed(`<span class="v none"></span><span class="t">Set ${e.set_no ?? ""} done · ${total} reps · ${e.clean} clean, ${e.cheats} cheat</span><span class="x"></span><span class="w none">${e.first_cheat_rep ? `First cheat rep ${e.first_cheat_rep}` : ""}</span>`, "setend");
    currentSetId = null;
    $("coach").textContent = "Coach is thinking…";
    $("report").innerHTML = "";
  }

  // ------------------------------------------------------------ status
  function ago(ms) { return ms == null ? "never" : ms < 1500 ? "now" : `${Math.round(ms / 1000)} s ago`; }
  let lastStatus = null;
  // A page load must not show an old run as if it were live. If the open session is fake, a finished
  // replay, or >10 min old with no device streaming, show a clean idle state until something new
  // happens (new session, a rep, calibration, a replay). Fake/replay runs stay in the Replay list.
  let staleId = null, firstStatus = true;
  function sessionAgeMs(id) { // ids are s-MMDD-HHMMSS-xxx / replay-MMDD-HHMMSS-xxx (server local time)
    const m = /^(?:s|replay)-(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id || "");
    if (!m) return 0;
    const now = new Date();
    return now - new Date(now.getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4], +m[5]);
  }
  function clearStale() { if (staleId) { staleId = null; renderSetLine(); } }
  function renderIdle() {
    $("who").textContent = "No session";
    $("setline").innerHTML = "Ready";
    $("setmeta").textContent = "Start a new session (or a walk-up), then start a set.";
    $("armState").className = "idle"; $("armState").textContent = "Idle";
    $("heroStart").classList.remove("show");
    $("coach").textContent = "";
  }
  // Both arms' MVCs, so an imbalance like 5k vs 15k is visible (each %MVC is relative to its own MVC).
  function mvcText(mvc) {
    if (!mvc) return " · MVC default";
    const k = x => `${(x / 1000).toFixed(1)}k`;
    const lop = (a, b) => Math.max(a, b) / Math.max(1, Math.min(a, b)) > 1.5 ? " (uneven)" : "";
    return ` · MVC biceps R ${k(mvc[0])} / L ${k(mvc[2])}${lop(mvc[0], mvc[2])} · delt R ${k(mvc[1])} / L ${k(mvc[3])}${lop(mvc[1], mvc[3])}`;
  }
  function onStatus(s) {
    lastStatus = s;
    if (firstStatus) {
      firstStatus = false;
      const ss0 = s.session;
      if (ss0 && s.mode === "live" && (ss0.kind !== "live" || (sessionAgeMs(ss0.id) > 10 * 60_000 && !s.device.streaming))) staleId = ss0.id;
    }
    if (staleId && (s.mode !== "live" || s.session?.id !== staleId)) clearStale();
    const d = s.device;
    $("devDot").className = `dot ${d.streaming ? "on" : d.last_batch_age_ms == null ? "" : "off"}`;
    $("devText").textContent = d.streaming ? `Streaming · ${d.batches_per_s.toFixed(1)}/s` : d.last_batch_age_ms == null ? "No device" : `Silent · ${ago(d.last_batch_age_ms)}`;
    const hb = d.heartbeat;
    $("hbText").textContent = hb ? `RSSI ${hb.rssi ?? "?"}${hb.queue ? ` · queue ${hb.queue}` : ""}${hb.age_ms > 5000 ? ` · heartbeat ${ago(hb.age_ms)}` : ""}` : "No heartbeat";
    const m = $("mode");
    m.textContent = s.mode === "replay" ? `Replay ${s.replay ? `${Math.round((s.replay.i / s.replay.n) * 100)}%` : ""}` : "Live";
    m.classList.toggle("replay", s.mode === "replay");
    const ss = s.session;
    if (staleId) {
      renderIdle();
      $("btnReplayStop").disabled = s.mode !== "replay";
      $("btnReplay").disabled = s.mode === "replay";
      return;
    }
    if (ss) {
      activeArms = s.set?.arms ?? ss.arms;
      $("who").innerHTML = `${esc(ss.person)}${ss.walkup ? " <small>walk-up</small>" : ""} <small>${ss.calibrating ? "Calibrating…" : `Calibration ${ss.cal_source === "saved" ? "saved" : ss.cal_source === "calibrated" ? "done" : "auto"}${ss.cal_problems?.length ? " (check)" : ""}${mvcText(ss.mvc)}`}</small>`;
    } else $("who").textContent = "No session";
    const armed = !!s.set && !ss?.calibrating;
    if (s.countdown_ms_left != null) { $("armState").className = "armed"; $("armState").textContent = "Countdown · pick them up"; }
    else if (!loopTimer) {
      $("armState").className = armed ? "armed" : "idle";
      $("armState").textContent = armed ? (s.set.set_no ? `Set ${s.set.set_no} running` : "Armed · curl to start") : ss?.calibrating ? "Calibrating" : "Idle";
    }
    $("heroStart").classList.toggle("show", !armed && s.countdown_ms_left == null && !ss?.calibrating && s.mode === "live" && !loopTimer);
    if (s.set) {
      $("setmeta").textContent = `${s.set.exercise} · ${s.set.variant}${s.set.load_lb != null ? ` · ${s.set.load_lb} lb` : ""} · ${s.set.arms.join(" + ")}`;
    } else $("setmeta").textContent = ss?.calibrating ? "Calibrating…" : "Pick up the weights after the countdown.";
    $("btnReplayStop").disabled = s.mode !== "replay";
    $("btnReplay").disabled = s.mode === "replay";
  }

  function renderSpeaker(hasSpeaker) {
    const el = $("spk");
    const on = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6h2l3-2.5v9L4.5 10h-2z"/><path d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6.5 6.5 0 0 1 0 9"/></svg>';
    const off = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6h2l3-2.5v9L4.5 10h-2z"/><path d="M11 6l3.5 4M14.5 6L11 10"/></svg>';
    if (MUTED) { el.innerHTML = `${off}Muted`; el.title = "Opened with ?mute=1: never plays voice"; el.className = ""; return; }
    el.innerHTML = isSpeaker ? `${on}This tab speaks` : `${off}${hasSpeaker ? "Text only · click to speak here" : "No speaker"}`;
    el.title = isSpeaker ? "Voice plays on this tab" : "Click to play the voice on this tab";
    el.className = isSpeaker ? "on" : "";
  }
  $("spk").onclick = run(async () => {
    if (MUTED || isSpeaker || !clientId) return;
    await post("/speaker/claim", { client_id: clientId });
    try { window.LWAudio?.unlock?.(); } catch { /* ignore */ }
  });

  // ------------------------------------------------------------ hands-free countdown
  // Start set = a server-timed countdown ("Pick them up. Three, two, one, curl!"); the set arms at 0,
  // so picking the weights up never counts. Only the speaker tab plays the voice.
  const LEAD_TEXT = "Pick them up. Three, two, one, curl!";
  let lead = null; // { audio, ms } preloaded once on the speaker tab (the server caches the TTS)
  function preloadCountdownVoice() {
    if (lead || silent()) return;
    lead = { audio: null, ms: 0 };
    fetch("/voice/say", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: LEAD_TEXT }) })
      .then(r => (r.ok ? r.blob() : null)).then(b => {
        if (!b) { lead = null; return; }
        const a = new Audio(URL.createObjectURL(b));
        a.addEventListener("loadedmetadata", () => { lead.ms = Math.round((a.duration || 0) * 1000); });
        lead.audio = a;
      }).catch(() => { lead = null; });
  }
  let cdTimer = null, cdVoiceTimer = null;
  function playCountdownVoice(msLeft) {
    if (silent()) { console.info("[say]", LEAD_TEXT); return; }
    if (!lead?.audio) { say(LEAD_TEXT); return; }
    const a = lead.audio, music = $("music");
    // End the voice on "curl!" right when the set arms; duck the music while it talks.
    cdVoiceTimer = setTimeout(() => {
      const vol = music.volume, playing = !music.paused;
      if (playing) music.volume = Math.min(vol, 0.25);
      a.currentTime = 0;
      a.play().catch(() => {}).finally(() => {});
      a.onended = () => { if (playing) music.volume = vol; };
    }, Math.max(0, msLeft - lead.ms - 150));
  }
  function showCountdown(endsAt) {
    clearInterval(cdTimer);
    $("cd").classList.add("show");
    const tick = () => {
      const left = endsAt - Date.now();
      const t = $("cdText");
      if (left > 3000) { t.textContent = "Pick them up"; t.className = ""; $("cdSub").textContent = "The set starts on curl."; }
      else if (left > 0) { t.textContent = String(Math.ceil(left / 1000)); t.className = ""; $("cdSub").textContent = "Get ready"; }
      else { t.textContent = "Curl"; t.className = "go"; $("cdSub").textContent = ""; }
    };
    tick();
    cdTimer = setInterval(tick, 100);
  }
  function hideCountdown(delay = 0) {
    setTimeout(() => { clearInterval(cdTimer); clearTimeout(cdVoiceTimer); $("cd").classList.remove("show"); }, delay);
  }
  function onCountdown(e) {
    if (e.phase === "start") { cancelLoop(); showCountdown(e.ends_at); playCountdownVoice(e.ms); }
    else if (e.phase === "go") hideCountdown(900);
    else hideCountdown();
  }

  // Hands-free loop: after a set ends and the coach is done talking, wait 20 s, then count down the
  // next set. Runs on the speaker tab (or any tab when nobody is the speaker). Any key/click cancels.
  let hasSpeaker = false, loopTimer = null, loopEndsAt = 0, waitingSet = null, waitTimer = null;
  const controller = () => isSpeaker || !hasSpeaker;
  function cancelLoop() {
    const was = !!(loopTimer || waitTimer);
    clearInterval(loopTimer); clearTimeout(waitTimer); loopTimer = null; waitTimer = null; waitingSet = null;
    if (was && lastStatus) onStatus(lastStatus);
    return was;
  }
  function scheduleNext() {
    clearTimeout(waitTimer); waitTimer = null;
    if (!$("handsFree").checked || !controller()) return;
    loopEndsAt = Date.now() + 20_000;
    clearInterval(loopTimer);
    loopTimer = setInterval(() => {
      const left = loopEndsAt - Date.now();
      $("armState").className = "idle";
      $("armState").textContent = `Next set in ${Math.max(0, Math.ceil(left / 1000))} s · any key cancels`;
      if (left <= 0) { cancelLoop(); startSet(); }
    }, 250);
  }
  function loopAfterSet(e) {
    cancelLoop();
    if (!$("handsFree").checked || !controller()) return;
    waitingSet = e.set_id;
    if (e.too_short) return scheduleNext();
    waitTimer = setTimeout(scheduleNext, 45_000); // coach audio never came: go on anyway
  }
  async function loopAfterCoach(setId) {
    if (waitingSet !== setId) return;
    await sleep(1000);
    for (let i = 0; i < 80 && window.LWAudio?.isSpeaking?.(); i++) await sleep(250); // let the coach finish
    if (waitingSet === setId) scheduleNext();
  }
  for (const ev of ["keydown", "pointerdown"]) window.addEventListener(ev, () => { cancelLoop(); }, true);

  // ------------------------------------------------------------ SSE
  let es;
  function connect() {
    es = new EventSource(MUTED ? "/events?mute=1" : "/events");
    es.onopen = () => { $("sseDot").className = "dot on"; $("sseText").textContent = "Linked"; $("sseWrap").classList.add("ok"); };
    es.onerror = () => { $("sseDot").className = "dot off"; $("sseText").textContent = "Server link lost, retrying"; $("sseWrap").classList.remove("ok"); };
    es.onmessage = ev => {
      let e; try { e = JSON.parse(ev.data); } catch { return; }
      switch (e.type) {
        case "live": live = e.pct; liveAt = performance.now(); break;
        case "status": onStatus(e); break;
        case "hello": clientId = e.client_id; break;
        case "speaker": isSpeaker = !!e.you; hasSpeaker = !!e.has_speaker; renderSpeaker(e.has_speaker); if (isSpeaker) preloadCountdownVoice(); break;
        case "history":
          $("feed").innerHTML = ""; currentSetId = null; setState = newSet();
          if (staleId) { renderIdle(); break; } // old fake/replay/stale run: don't show its reps
          for (const r of e.reps) onRep(r, false);
          break;
        case "rep": clearStale(); onRep(e, true); break;
        case "set_end": clearStale(); onSetEnd(e); loopAfterSet(e); break;
        case "countdown": onCountdown(e); break;
        case "coach":
          if (e.too_short) break;
          $("coach").textContent = e.text || "";
          if (e.audio !== "pending") { // older servers: speak now
            if (e.text) say(e.text); else playClip(e.fallback_clip);
            loopAfterCoach(e.set_id);
          }
          break;
        case "coach_audio": // the server finished the TTS for this set's line (once, cached)
          if (e.ok && e.text) say(e.text); else playClip(e.fallback_clip);
          loopAfterCoach(e.set_id);
          break;
        case "set_detail": renderReport(e); break;
        case "calibration": clearStale(); onCalEvent(e); break;
        case "calibrate_request": calibrate(); break;
        case "session":
          clearStale();
          $("feed").innerHTML = ""; currentSetId = null; setState = newSet(); renderSetLine(); $("coach").textContent = ""; $("report").innerHTML = ""; resetMeters();
          toast(`New session: ${e.person}${e.walkup ? " (walk-up)" : ""}`);
          break;
        case "replay":
          if (e.phase === "start") { clearStale(); resetMeters(); $("feed").innerHTML = ""; currentSetId = null; setState = newSet(); renderSetLine(); toast("Replay started"); }
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
        const side = a === "R" ? "Right" : "Left", base = a === "R" ? 0 : 2;
        steps.push({ ch: base, title: `${side} biceps`, hint: "Curl up and squeeze as hard as you can. Hold." });
        steps.push({ ch: base + 1, title: `${side} front delt`, hint: "Front raise, straight arm, and hold it up." });
      }
      const total = steps.length + 1;
      const lines = []; // per-channel captured MVC, shown under the countdown
      const showLines = () => { $("calResult").innerHTML = lines.join("<br>"); };
      const leadIn = preloadLeadIn(); // "Three. Two. One. Squeeze!" fetched once, during the relax step
      calShow(`Step 1 of ${total}`, "Relax", "Arms down, loose. Don't move.");
      playClip("calibrate_relax");
      await countdown(3);
      await post("/calibrate/capture", { step: "rest", window_ms: 2500 });
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        for (let attempt = 1; ; attempt++) {
          calShow(`Step ${i + 2} of ${total} · get ready${attempt > 1 ? ` · try ${attempt}` : ""}`, s.title, s.hint);
          await playLeadIn(leadIn);
          for (const n of [3, 2, 1]) { if (calAbort) throw new Error("cancelled"); $("calCount").textContent = n; await sleep(800); }
          calShow(`Step ${i + 2} of ${total}`, `Squeeze · ${s.title.toLowerCase()}`, s.hint, true);
          await countdown(4); // hold 4 s; the server keeps the last 3.5 s
          const r = await post("/calibrate/capture", { step: "mvc", ch: s.ch, window_ms: 3500 });
          const mvc = r.level?.[0] ?? 0, isBi = s.ch % 2 === 0;
          const weak = isBi && mvc < MIN_BICEPS_MVC;
          if (weak && attempt < 3) {
            lines.push(`<span class="bad">${CH_INFO[s.ch].name}: MVC ${Math.round(mvc).toLocaleString()} · flex harder: redo</span>`); showLines();
            await sleep(1500);
            continue;
          }
          lines.push(weak ? `<span class="bad">${CH_INFO[s.ch].name}: MVC ${Math.round(mvc).toLocaleString()}, still low (pad or gain?)</span>`
            : `<span class="good">${CH_INFO[s.ch].name}: MVC ${Math.round(mvc).toLocaleString()}</span>`);
          showLines();
          break;
        }
      }
      calShow("Done", "Calibrated", "");
      const { calibration: c } = await post("/calibrate");
      const weakBi = [0, 2].filter(i => arms.includes(i === 0 ? "R" : "L") && c.mvc[i] < MIN_BICEPS_MVC);
      const warn = [...(c.problems ?? []), ...weakBi.map(i => `${CH_INFO[i].name} MVC ${Math.round(c.mvc[i])} < ${MIN_BICEPS_MVC}: flex harder, recalibrate (C)`)];
      $("calResult").innerHTML =
        `<div style="font-size:22px">${CH_INFO.map((ch, i) => `${ch.name} <b>${Math.round(c.mvc[i]).toLocaleString()}</b>`).join(" · ")}</div>` +
        (warn.length ? `<div class="bad">${warn.map(esc).join("<br>")}</div>` : `<div class="good">All channels look good.</div>`) +
        `<div style="color:var(--dim);font-size:16px">rest ${c.rest.map(Math.round).join(" / ")} · MVC self-corrects upward from your real curls after each set</div>`;
      $("calTitle").textContent = warn.length ? "Calibrated, with warnings" : "Calibrated";
      c.problems = warn;
      $("calCancel").style.display = "none"; $("calClose").style.display = "";
      if (!c.problems?.length) setTimeout(() => { if (!calRunning) $("cal").classList.remove("show"); }, 2500);
    } catch (e) {
      if (e.message !== "cancelled") toast(`Calibration: ${e.message}`, 7000);
      post("/calibrate/cancel").catch(() => {});
      $("cal").classList.remove("show");
    } finally { calRunning = false; $("calCount").textContent = ""; }
  }
  const MIN_BICEPS_MVC = 8000;
  const LEAD_IN_TEXT = "Three. Two. One. Squeeze!";
  function preloadLeadIn() {
    if (silent()) return Promise.resolve(null);
    return fetch("/voice/say", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: LEAD_IN_TEXT }) })
      .then(r => (r.ok ? r.blob() : null)).then(b => (b ? URL.createObjectURL(b) : null)).catch(() => null);
  }
  async function playLeadIn(p) {
    if (silent()) { console.info("[say]", LEAD_IN_TEXT); return; }
    const url = await Promise.race([p, sleep(1500).then(() => null)]);
    if (url) { try { await new Audio(url).play(); return; } catch { /* fall through */ } }
    playClip("calibrate_flex");
  }
  function onCalEvent(e) {
    if (e.phase === "raised") { toast(`Auto-MVC from your set: ${e.mvc.map(Math.round).join(" / ")}`, 5000); return; }
    if (e.phase === "rest") return; // auto-rest at set start: quiet
    if (calRunning) return; // our own flow shows it
    if (e.phase === "begin") toast(`Calibration started${e.replay ? " (replay)" : ""}`);
    else if (e.phase === "captured") toast(`Calibration: captured ${e.step === "rest" ? "rest" : CH_INFO[e.ch].name}`, 2500);
    else if (e.phase === "done") toast(e.problems?.length ? `Calibrated with warnings: ${e.problems.join("; ")}` : "Calibrated", 5000);
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
  const startSet = run(() => post("/set/countdown", {
    exercise: $("exercise").value || "dumbbell curl", variant: $("variant").value,
    load_lb: Number($("load").value) || undefined, arms: arms(), auto_next: $("autoNext").checked,
  }));
  const stopSet = run(() => { cancelLoop(); return post("/set/stop"); });
  $("cdCancel").onclick = stopSet;
  $("btnStart").onclick = startSet;
  $("heroStart").onclick = startSet;
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
    if (k === " " || k === "spacebar") e.preventDefault();
    if (k === "c") calibrate(); else if (k === "s" || k === " " || k === "spacebar") startSet(); else if (k === "x") stopSet();
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
  // Browsers only start Web Audio after a user gesture: unlock on the first click/key.
  const unlock = () => { if (!silent()) try { window.LWAudio?.unlock?.(); } catch { /* ignore */ } };
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });
  if (window.__lwNoVoice) console.info("voice-player.js not found; using browser speech as a fallback.");
})();
