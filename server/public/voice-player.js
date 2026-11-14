// Lightweight voice player (plain browser JS). Loaded by the dashboard with
//   <script src="/voice-player.js"></script>
// API (BUILD.md ④ + additions):
//   LWAudio.setMusic(audioEl)        music <audio> element to duck
//   LWAudio.playClip(key | [keys])   instant pre-generated call-out; an array plays back to back
//                                    (e.g. ["rep_6","delt_took_over"]). Dropped inside the cooldown or
//                                    while another voice plays, EXCEPT set-end sequences (first key
//                                    "set_done"), which wait their turn. Resolves true if it played.
//   LWAudio.say(text)                live TTS via POST /voice/say; waits its turn, never overlaps. If the
//                                    audio isn't back within fallbackMs (7 s), the browser speaks the text
//                                    instead (speechSynthesis) and the late Gemini audio is skipped.
//   LWAudio.coachText(setId, text)   the server's coach text arrived (audio still pending): starts the 7 s
//                                    clock; if coachAudio hasn't come by then, the browser speaks it.
//                                    Coach lines: only the first sentence (<= 15 words) is spoken.
//   LWAudio.coachAudio(setId, msg)   the server's coach_audio event ({ok, text, fallback_clip}): plays the
//                                    Gemini audio, unless the browser already spoke this set's line.
//   LWAudio.cooldownMs = 3000        min gap between call-out starts
//   LWAudio.fallbackMs = 7000        Gemini audio deadline before the browser voice takes over
// ONE speech queue: clips, Gemini audio and browser speech never overlap (one lock, speechSynthesis
// cancelled before each voice); a set's line is owned by Gemini OR the browser, never both; the same
// line asked for twice within 15 s is spoken once.
//   LWAudio.unlock()                 call from a click handler once (browser autoplay rules)
// Every voice (Gemini or browser): duck music to 20% over 150 ms, play, restore over 400 ms.
// Emits window "lwaudio" CustomEvents: {type:"start"|"end"|"drop"|"fallback"|"skip_late", what}.
(function () {
  "use strict";

  var DUCK_LEVEL = 0.2;
  var DUCK_MS = 150;
  var RESTORE_MS = 400;

  var ctx = null;
  var buffers = {}; // key -> AudioBuffer
  var loading = {}; // key -> Promise
  var music = null;
  var musicVolume = 1; // the user's level, restored after each voice
  var fadeTimer = null;
  var busy = false; // a voice is playing
  var lastStart = 0;
  var coach = {}; // setId -> {text, by: null|"gemini"|"browser", timer}: who owns that set's line
  var enabled = true; // false = this tab must not speak (not the speaker tab, or a stale build)
  var sinkId = ""; // audio output for every voice (③ dashboard: "Coach audio output"); "" = system default

  function audioCtx() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) ctx = new AC();
      if (ctx && sinkId && typeof ctx.setSinkId === "function") ctx.setSinkId(sinkId).catch(function () {});
    }
    return ctx;
  }

  function emit(type, what) {
    try {
      window.dispatchEvent(new CustomEvent("lwaudio", { detail: { type: type, what: what } }));
    } catch (e) {}
  }

  // Ramp music.volume with timers (not Web Audio), so music never goes silent if the
  // AudioContext is suspended.
  function fadeMusic(to, ms) {
    return new Promise(function (resolve) {
      if (!music) return resolve();
      if (fadeTimer) clearInterval(fadeTimer);
      var from = music.volume;
      var t0 = performance.now();
      fadeTimer = setInterval(function () {
        var k = Math.min(1, (performance.now() - t0) / ms);
        try {
          music.volume = Math.max(0, Math.min(1, from + (to - from) * k));
        } catch (e) {}
        if (k >= 1) {
          clearInterval(fadeTimer);
          fadeTimer = null;
          resolve();
        }
      }, 15);
    });
  }

  function decode(arrayBuf) {
    var c = audioCtx();
    if (!c) return Promise.reject(new Error("no Web Audio"));
    return new Promise(function (resolve, reject) {
      // Callback form works on older Safari too.
      c.decodeAudioData(arrayBuf, resolve, reject);
    });
  }

  function loadClip(key) {
    if (buffers[key]) return Promise.resolve(buffers[key]);
    if (!loading[key]) {
      loading[key] = fetch("/voice/clip/" + encodeURIComponent(key) + ".wav")
        .then(function (r) {
          if (!r.ok) throw new Error("clip " + key + " " + r.status);
          return r.arrayBuffer();
        })
        .then(decode)
        .then(function (b) {
          buffers[key] = b;
          return b;
        })
        .catch(function (e) {
          delete loading[key];
          throw e;
        });
    }
    return loading[key];
  }

  function playBuffer(buf) {
    return new Promise(function (resolve) {
      var c = audioCtx();
      var src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      src.onended = function () {
        resolve();
      };
      src.start();
    });
  }

  // Duck, run `play()` (a promise), restore. Caller holds `busy`.
  function withDuck(play, what) {
    if (music) musicVolume = fadeTimer ? musicVolume : music.volume || musicVolume;
    emit("start", what);
    return fadeMusic(musicVolume * DUCK_LEVEL, DUCK_MS)
      .then(play)
      .then(function () {
        return fadeMusic(musicVolume, RESTORE_MS);
      })
      .then(function () {
        emit("end", what);
      });
  }

  function voice(bufs, what) {
    var c = audioCtx();
    var resume = c && c.state === "suspended" ? c.resume() : Promise.resolve();
    return resume.then(function () {
      return withDuck(function () {
        return bufs.reduce(function (p, b) {
          return p.then(function () {
            return playBuffer(b);
          });
        }, Promise.resolve());
      }, what);
    });
  }

  // ---------------------------------------------------------------- browser voice (fallback)
  var pickedVoice = null;
  function browserVoice() {
    if (pickedVoice) return pickedVoice;
    var ss = window.speechSynthesis;
    var vs = (ss && ss.getVoices && ss.getVoices()) || [];
    var en = vs.filter(function (v) {
      return /^en[-_]US/i.test(v.lang || "");
    });
    var pool = en.length ? en : vs.filter(function (v) {
      return /^en/i.test(v.lang || "");
    });
    // Male-ish names first (Windows David/Mark/Guy, macOS Alex/Fred, Google US English is male on Chrome).
    var male = /\b(david|mark|guy|alex|fred|daniel|tom|aaron|christopher|eric|roger|steffan|google us english|male)\b/i;
    pickedVoice =
      pool.filter(function (v) {
        return male.test(v.name || "") && !/female|zira|samantha|aria|jenny|michelle/i.test(v.name || "");
      })[0] ||
      pool[0] ||
      null;
    return pickedVoice;
  }

  // Speak with speechSynthesis, ducked like any voice. Caller holds `busy`.
  function browserSpeak(text, what) {
    var ss = window.speechSynthesis;
    var U = window.SpeechSynthesisUtterance;
    if (!ss || !U) return Promise.resolve(false);
    // speechSynthesis always plays on the system default output and can't follow setSinkId: with a
    // chosen output (e.g. the Bluetooth speaker) it would come out of the wrong device, so show text only.
    if (sinkId) {
      emit("no_route", what);
      return Promise.resolve(false);
    }
    return withDuck(function () {
      return new Promise(function (resolve) {
        var u = new U(text);
        var v = browserVoice();
        if (v) {
          u.voice = v;
          u.lang = v.lang;
        } else u.lang = "en-US";
        u.rate = 1.05;
        var settled = false;
        function done() {
          if (settled) return;
          settled = true;
          clearTimeout(guard);
          resolve(true);
        }
        u.onend = done;
        u.onerror = done;
        // Some browsers never fire onend: release after a generous estimate.
        var guard = setTimeout(done, 2000 + text.split(/\s+/).length * 450);
        try {
          ss.cancel();
        } catch (e) {}
        ss.speak(u);
      });
    }, what || "browser");
  }

  // The spoken part of a coach line: first sentence, <= 15 words (same rule as the server's spokenPart()).
  function spokenPart(text, maxWords) {
    maxWords = maxWords || 15;
    var t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    var m = t.match(/^.*?[.!?](?=\s|$)/);
    var first = (m ? m[0] : t).trim();
    var w = first.split(" ");
    if (w.length <= maxWords) return first;
    var head = w.slice(0, maxWords).join(" ");
    var cut = Math.max(head.lastIndexOf(","), head.lastIndexOf(":"), head.lastIndexOf(";"));
    return (cut > 20 ? head.slice(0, cut) : head).replace(/[,:;\s]+$/, "") + ".";
  }

  // ---------------------------------------------------------------- ONE speech queue
  // Every voice (clips, Gemini audio, browser speech) is a job on this single queue. A job holds the
  // "now speaking" lock from start to end, plays at most ONE voice, and cancels any stray browser
  // speech before it starts. So two voices can never overlap, whatever calls us and in whatever order.
  var chain = Promise.resolve();
  var pending = 0; // jobs queued or running
  var recent = {}; // spoken text -> time, to drop an identical line asked for twice
  var REPEAT_MS = 15000;

  function cancelBrowserSpeech() {
    try {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    } catch (e) {}
  }

  // job(): a promise that plays at most one voice and resolves when it's done (true if it spoke).
  function enqueue(job, what) {
    pending++;
    var run = chain.then(function () {
      if (!enabled) {
        emit("drop", what + ":disabled");
        return false;
      }
      busy = true;
      lastStart = Date.now();
      cancelBrowserSpeech();
      return Promise.resolve()
        .then(job)
        .catch(function (e) {
          console.warn("[LWAudio] " + what + " failed", e);
          return false;
        });
    });
    chain = run.then(
      function () {
        busy = false;
        pending--;
      },
      function () {
        busy = false;
        pending--;
      },
    );
    return run.then(function (v) {
      return v === undefined ? true : !!v;
    });
  }

  function isRepeat(text) {
    var now = Date.now();
    for (var k in recent) if (now - recent[k] > REPEAT_MS) delete recent[k];
    if (recent[text]) return true;
    recent[text] = now;
    return false;
  }

  function fetchSay(text) {
    return fetch("/voice/say", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: text }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error("say " + r.status);
        return r.arrayBuffer();
      })
      .then(decode);
  }

  /**
   * One spoken line: Gemini audio if it's decoded before `deadline` (ms since epoch), else the browser
   * voice. Exactly one of the two, decided once. `owner` (optional) is the per-set ownership record.
   */
  function speakLine(text, audioP, deadline, owner, what) {
    var winner = Promise.race([
      audioP.catch(function () {
        return null;
      }),
      new Promise(function (resolve) {
        setTimeout(function () {
          resolve(null);
        }, Math.max(0, deadline - Date.now()));
      }),
    ]);
    return winner.then(function (buf) {
      if (owner && owner.by === "browser") buf = null; // the browser already owns this line
      if (buf) {
        if (owner) owner.by = "gemini";
        return voice([buf], what).then(function () {
          return true;
        });
      }
      if (owner) owner.by = "browser";
      emit("fallback", what);
      audioP.then(function () {
        emit("skip_late", what);
      }, function () {});
      return browserSpeak(text, "browser:" + what);
    });
  }

  var LWAudio = {
    cooldownMs: 3000,
    fallbackMs: 7000,
    ready: null, // Promise: all clips preloaded

    /** Route every voice (clips, coach audio, say) to an output device; "" = system default. Returns a Promise. */
    setSinkId: function (id) {
      sinkId = id || "";
      var c = ctx;
      if (c && typeof c.setSinkId === "function") return c.setSinkId(sinkId).catch(function (e) { console.warn("[LWAudio] setSinkId", e); });
      return Promise.resolve();
    },
    /** True when this browser can route Web Audio to a chosen device (Chrome 110+). */
    canSetSink: function () {
      var AC = window.AudioContext || window.webkitAudioContext;
      return !!(AC && AC.prototype && typeof AC.prototype.setSinkId === "function");
    },

    setMusic: function (el) {
      music = el || null;
      if (music) musicVolume = music.volume;
    },

    /** Set the music level the player restores to (use instead of el.volume while ducked). */
    setMusicVolume: function (v) {
      musicVolume = Math.max(0, Math.min(1, v));
      if (music && !busy) music.volume = musicVolume;
    },

    unlock: function () {
      var c = audioCtx();
      if (c && c.state === "suspended") return c.resume();
      return Promise.resolve();
    },

    preload: function () {
      LWAudio.ready = fetch("/voice/clips")
        .then(function (r) {
          return r.json();
        })
        .then(function (j) {
          return Promise.all(
            (j.keys || []).map(function (k) {
              return loadClip(k).catch(function () {});
            }),
          );
        })
        .catch(function () {});
      return LWAudio.ready;
    },

    playClip: function (keyOrKeys) {
      var keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
      keys = keys.filter(Boolean);
      if (!keys.length) return Promise.resolve(false);
      var what = keys.join("+");
      // Set-end feedback (first key "set_done") waits its turn; the set's summary queues after it.
      // Other call-outs are dropped while anything is queued or inside the cooldown.
      if (keys[0] !== "set_done" && (pending > 0 || Date.now() - lastStart < LWAudio.cooldownMs)) {
        emit("drop", what);
        return Promise.resolve(false);
      }
      var bufsP = Promise.all(keys.map(loadClip));
      return enqueue(function () {
        return bufsP.then(function (bufs) {
          return voice(bufs, what).then(function () {
            return true;
          });
        });
      }, what);
    },

    say: function (text, opts) {
      text = String(text || "").trim();
      if (!text) return Promise.resolve(false);
      if (isRepeat(text)) {
        emit("drop", "say:repeat");
        return Promise.resolve(false);
      }
      // The clock starts now; the fetch starts now too (it's usually a server cache hit).
      var deadline = Date.now() + ((opts && opts.fallbackMs) || LWAudio.fallbackMs);
      var audioP = fetchSay(text);
      audioP.catch(function () {});
      return enqueue(function () {
        return speakLine(text, audioP, deadline, null, "say");
      }, "say");
    },

    coachText: function (setId, text) {
      text = String(text || "").trim();
      if (!setId || !text) return;
      var c = coach[setId];
      if (c) return; // already handled (duplicate event): never a second clock for the same set
      c = coach[setId] = { text: text, by: null, timer: null, t0: Date.now() };
      // If the Gemini audio hasn't arrived fallbackMs (7 s) after the text, the browser owns the line.
      c.timer = setTimeout(function () {
        if (c.by) return;
        c.by = "browser";
        emit("fallback", "coach:" + setId);
        var spoken = spokenPart(text);
        isRepeat(spoken);
        enqueue(function () {
          return browserSpeak(spoken, "browser:coach");
        }, "coach:" + setId);
      }, LWAudio.fallbackMs);
    },

    coachAudio: function (setId, msg) {
      msg = msg || {};
      var c = coach[setId];
      if (c && c.by) {
        // The browser already took this line (or the audio came twice): drop it.
        emit("skip_late", "coach:" + setId);
        return Promise.resolve(false);
      }
      if (c) clearTimeout(c.timer);
      var text = (msg.spoken || (msg.text ? spokenPart(msg.text) : "") || (c ? spokenPart(c.text) : "")).trim();
      if (!c) c = coach[setId] = { text: msg.text || text, by: null, timer: null, t0: Date.now() };
      c.by = "gemini";
      if (!text) return msg.fallback_clip ? LWAudio.playClip(msg.fallback_clip) : Promise.resolve(false);
      if (isRepeat(text)) {
        emit("drop", "coach:repeat");
        return Promise.resolve(false);
      }
      if (!msg.ok) return enqueue(function () {
        return browserSpeak(text, "browser:coach");
      }, "coach:" + setId);
      // Server says the audio is cached: fetch it now; it still has to beat a short deadline.
      var deadline = Date.now() + 3000;
      var audioP = fetchSay(text);
      audioP.catch(function () {});
      return enqueue(function () {
        return speakLine(text, audioP, deadline, null, "coach:" + setId);
      }, "coach:" + setId);
    },

    /**
     * Play an <audio> element (countdown, calibration lead-in, ...) through the same queue and lock,
     * ducked like any voice. opts.dropIfBusy: skip it if anything is queued (timing-critical lines).
     * Resolves when it has finished (true) or was skipped (false).
     */
    playElement: function (el, opts) {
      var what = (opts && opts.what) || "element";
      if (!el) return Promise.resolve(false);
      if (!enabled || (opts && opts.dropIfBusy && pending > 0)) {
        emit("drop", what);
        return Promise.resolve(false);
      }
      return enqueue(function () {
        return withDuck(function () {
          return new Promise(function (resolve) {
            var settled = false;
            function done() {
              if (settled) return;
              settled = true;
              clearTimeout(guard);
              resolve(true);
            }
            var secs = Number(el.duration);
            var guard = setTimeout(done, (isFinite(secs) && secs > 0 ? secs * 1000 : 8000) + 2000);
            el.onended = done;
            el.onerror = done;
            try {
              el.currentTime = 0;
            } catch (e) {}
            var p = el.play && el.play();
            if (p && p.catch) p.catch(done);
          });
        }, what);
      }, what);
    },

    /** false = this tab must not speak at all (not the speaker tab, or its JS build is stale). */
    setEnabled: function (on) {
      enabled = !!on;
      if (!enabled) cancelBrowserSpeech();
    },

    isSpeaking: function () {
      return busy || pending > 0;
    },

    spokenPart: spokenPart,
  };

  window.LWAudio = LWAudio;
  // Decoding needs an AudioContext; creating one before a gesture is allowed (it starts
  // suspended), and voice() resumes it. Preload so the first call-out is instant.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", LWAudio.preload);
  else LWAudio.preload();
  // Any click/keypress unlocks audio.
  ["pointerdown", "keydown"].forEach(function (ev) {
    window.addEventListener(ev, LWAudio.unlock, { passive: true });
  });
  // Chrome loads voices async.
  try {
    if (window.speechSynthesis && "onvoiceschanged" in window.speechSynthesis)
      window.speechSynthesis.onvoiceschanged = function () {
        pickedVoice = null;
      };
  } catch (e) {}
})();
