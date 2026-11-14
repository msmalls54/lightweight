// Lightweight voice player (plain browser JS). Loaded by the dashboard with
//   <script src="/voice-player.js"></script>
// API (BUILD.md ④):
//   LWAudio.setMusic(audioEl)     music <audio> element to duck
//   LWAudio.playClip(key | [keys]) instant pre-generated call-out; an array plays back to back
//                                  (e.g. ["rep_6","delt_took_over"]). Dropped inside the cooldown
//                                  or while another voice is playing. Resolves true if it played.
//   LWAudio.say(text)             live TTS via POST /voice/say; waits its turn, never overlaps.
//   LWAudio.cooldownMs = 3000     min gap between call-out starts
//   LWAudio.unlock()              call from a click handler once (browser autoplay rules)
// Every voice: duck music to 20% over 150 ms, play, restore over 400 ms.
// Emits window "lwaudio" CustomEvents: {type:"start"|"end"|"drop", what}.
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
  var busy = false; // a voice is playing (or fetching for say)
  var queue = Promise.resolve(); // serialises say()
  var lastStart = 0;

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

  // Duck, play buffers back to back, restore. Caller holds `busy`.
  function voice(bufs, what) {
    var c = audioCtx();
    var resume = c && c.state === "suspended" ? c.resume() : Promise.resolve();
    if (music) musicVolume = fadeTimer ? musicVolume : music.volume || musicVolume;
    emit("start", what);
    return resume
      .then(function () {
        return fadeMusic(musicVolume * DUCK_LEVEL, DUCK_MS);
      })
      .then(function () {
        return bufs.reduce(function (p, b) {
          return p.then(function () {
            return playBuffer(b);
          });
        }, Promise.resolve());
      })
      .then(function () {
        return fadeMusic(musicVolume, RESTORE_MS);
      })
      .then(function () {
        emit("end", what);
      });
  }

  var LWAudio = {
    cooldownMs: 3000,
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
      var now = Date.now();
      if (busy || now - lastStart < LWAudio.cooldownMs) {
        emit("drop", keys.join("+"));
        return Promise.resolve(false);
      }
      busy = true;
      lastStart = now;
      return Promise.all(keys.map(loadClip))
        .then(function (bufs) {
          return voice(bufs, keys.join("+"));
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

    say: function (text) {
      text = String(text || "").trim();
      if (!text) return Promise.resolve(false);
      // Fetch now (TTS takes ~2-3 s), play when nothing else is talking.
      var audio = fetch("/voice/say", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: text }),
      })
        .then(function (r) {
          if (!r.ok) throw new Error("say " + r.status);
          return r.arrayBuffer();
        })
        .then(decode);
      var run = queue.then(function () {
        return audio.then(function (buf) {
          return new Promise(function (resolve) {
            (function waitTurn() {
              if (busy) return setTimeout(waitTurn, 100);
              busy = true;
              lastStart = Date.now();
              voice([buf], "say").then(
                function () {
                  busy = false;
                  resolve(true);
                },
                function () {
                  busy = false;
                  resolve(false);
                },
              );
            })();
          });
        });
      });
      queue = run.catch(function () {});
      return run.catch(function (e) {
        console.warn("[LWAudio] say failed", e);
        return false;
      });
    },

    isSpeaking: function () {
      return busy;
    },
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
})();
