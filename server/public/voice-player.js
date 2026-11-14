// Lightweight voice player (plain browser JS). Loaded by the dashboard with
//   <script src="/voice-player.js"></script>
// API (BUILD.md ④ + additions):
//   LWAudio.setMusic(audioEl)        music <audio> element to duck
//   LWAudio.playClip(key | [keys])   instant pre-generated call-out; an array plays back to back
//                                    (e.g. ["rep_6","delt_took_over"]). Dropped inside the cooldown or
//                                    while another voice plays, EXCEPT set-end sequences (first key
//                                    "set_done"), which wait their turn. Resolves true if it played.
//   LWAudio.say(text)                live TTS via POST /voice/say; waits its turn, never overlaps. If the
//                                    audio isn't back within fallbackMs (5 s), the browser speaks the text
//                                    instead (speechSynthesis) and the late Gemini audio is skipped.
//   LWAudio.coachText(setId, text)   the server's coach text arrived (audio still pending): starts the 5 s
//                                    clock; if coachAudio hasn't come by then, the browser speaks it.
//                                    Coach lines: only the first sentence (<= 15 words) is spoken.
//   LWAudio.coachAudio(setId, msg)   the server's coach_audio event ({ok, text, fallback_clip}): plays the
//                                    Gemini audio, unless the browser already spoke this set's line.
//   LWAudio.cooldownMs = 3000        min gap between call-out starts
//   LWAudio.fallbackMs = 5000        Gemini audio deadline before the browser voice takes over
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
  var queue = Promise.resolve(); // serialises say()
  var lastStart = 0;
  var coach = {}; // setId -> {text, timer, done}

  function audioCtx() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) ctx = new AC();
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

  // Run fn once nothing else is talking; fn must return a promise. Holds `busy` while it runs.
  function whenFree(fn) {
    return new Promise(function (resolve) {
      (function waitTurn() {
        if (busy) return setTimeout(waitTurn, 100);
        busy = true;
        lastStart = Date.now();
        Promise.resolve()
          .then(fn)
          .then(
            function (v) {
              busy = false;
              resolve(v === undefined ? true : v);
            },
            function () {
              busy = false;
              resolve(false);
            },
          );
      })();
    });
  }

  var LWAudio = {
    cooldownMs: 3000,
    fallbackMs: 5000,
    ready: null, // Promise: all clips preloaded

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
      // Set-end feedback must not be lost to the cooldown: wait for the current voice instead.
      if (keys[0] === "set_done") {
        return Promise.all(keys.map(loadClip)).then(
          function (bufs) {
            return whenFree(function () {
              return voice(bufs, what);
            });
          },
          function () {
            return false;
          },
        );
      }
      var now = Date.now();
      if (busy || now - lastStart < LWAudio.cooldownMs) {
        emit("drop", what);
        return Promise.resolve(false);
      }
      busy = true;
      lastStart = now;
      return Promise.all(keys.map(loadClip))
        .then(function (bufs) {
          return voice(bufs, what);
        })
        .then(
          function () {
            busy = false;
            return true;
          },
          function (e) {
            busy = false;
            console.warn("[LWAudio] clip failed", e);
            return false;
          },
        );
    },

    say: function (text, opts) {
      text = String(text || "").trim();
      if (!text) return Promise.resolve(false);
      var fallbackMs = (opts && opts.fallbackMs) || LWAudio.fallbackMs;
      // Fetch now; if it isn't decoded within fallbackMs, the browser voice speaks instead and the
      // late Gemini audio is dropped (never both).
      var state = { late: false, buf: null };
      var audio = fetch("/voice/say", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: text }),
      })
        .then(function (r) {
          if (!r.ok) throw new Error("say " + r.status);
          return r.arrayBuffer();
        })
        .then(decode)
        .then(function (buf) {
          if (state.late) emit("skip_late", "say");
          state.buf = buf;
          return buf;
        });
      var deadline = new Promise(function (resolve) {
        setTimeout(function () {
          resolve(null);
        }, fallbackMs);
      });
      var winner = Promise.race([audio, deadline]).catch(function () {
        return null; // TTS failed: same as late
      });
      var run = queue.then(function () {
        return winner.then(function (buf) {
          if (buf) return whenFree(function () {
            return voice([buf], "say");
          });
          state.late = true;
          emit("fallback", "say");
          return whenFree(function () {
            return browserSpeak(text, "browser:say");
          });
        });
      });
      queue = run.catch(function () {});
      return run.catch(function (e) {
        console.warn("[LWAudio] say failed", e);
        return false;
      });
    },

    coachText: function (setId, text) {
      text = String(text || "").trim();
      if (!setId || !text) return;
      var c = coach[setId];
      if (c && c.done) return;
      if (c && c.timer) clearTimeout(c.timer);
      c = coach[setId] = { text: text, timer: null, done: false };
      c.timer = setTimeout(function () {
        if (c.done) return;
        c.done = true; // the browser owns this line now: the Gemini audio will be skipped
        emit("fallback", "coach:" + setId);
        whenFree(function () {
          return browserSpeak(spokenPart(text), "browser:coach");
        });
      }, LWAudio.fallbackMs);
    },

    coachAudio: function (setId, msg) {
      msg = msg || {};
      var c = coach[setId];
      if (c && c.done) {
        emit("skip_late", "coach:" + setId);
        return Promise.resolve(false);
      }
      if (c) {
        clearTimeout(c.timer);
        c.done = true;
      }
      // Only the first sentence is spoken (the server pre-generates exactly that: msg.spoken).
      if (msg.ok && (msg.spoken || msg.text)) return LWAudio.say(msg.spoken || spokenPart(msg.text));
      if (c && c.text) return whenFree(function () {
        return browserSpeak(spokenPart(c.text), "browser:coach");
      });
      return msg.fallback_clip ? LWAudio.playClip(msg.fallback_clip) : Promise.resolve(false);
    },

    isSpeaking: function () {
      return busy;
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
