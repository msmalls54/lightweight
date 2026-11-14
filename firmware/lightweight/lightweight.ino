// Lightweight firmware: UNO R4 WiFi + MyoWare 2 Arduino Shield, 4 EMG channels (ENV output).
//
//   A0 = R biceps, A1 = R front delt, A2 = L biceps, A3 = L front delt (BUILD.md channel map).
//
// Design:
//  - Sampling runs in a hardware timer interrupt at 200 Hz (FspTimer), so nothing the network
//    does in loop() can delay or drop a sample. WiFiS3 calls are blocking AT commands over a
//    UART to the ESP32-S3; that's fine here because they only block loop().
//  - The sample ring buffer IS the offline queue: batch index k = samples [40k, 40k+40).
//    loop() sends everything pending, oldest first, up to K_MAX batches coalesced into one POST
//    (same JSON shape, k*40 samples per channel, seq = the first batch's seq, "n_batches": k),
//    and only advances on HTTP 200. A retry resends the identical group (server dedupes on
//    device+seq+t0_ms). If more than QUEUE_MAX batches are pending, the oldest are dropped.
//  - Throughput is bound by the 115,200-baud UART to the ESP32-S3 (~70-80 ms per batch of
//    JSON), so coalescing amortizes the fixed per-POST cost (WiFi RTT, AT round trips, reply).
//  - seq starts at bootCount * 1,000,000 (boot counter in EEPROM), so a reboot never reuses a
//    seq the server already saw (it ignores duplicate seqs).
//  - HTTP/1.1 keep-alive to the laptop; reconnect on any error. Wi-Fi retries forever.
//  - Serial 115200: 10 Hz plotter line (4 values + queue depth) and a "# ..." status every 5 s.
//    On the R4 WiFi, Serial is a UART bridged by the ESP32-S3 (not native USB): writes block
//    ~87 us/byte (only loop(), never the sampler) and availableForWrite() always returns 0.
//
// Wire format (BUILD.md, do not change):
//   POST /ingest    {"device":"lw-uno-1","seq":N,"t0_ms":T,"dt_ms":5,"n_batches":k,"ch":[[..40k..],[..],[..],[..]]}
//   POST /heartbeat {"device":"lw-uno-1","seq":N,"uptime_ms":U,"rssi":R,"queue":Q,"fw":"0.2.0","dropped":D,
//                    "post_rtt_ms":last,"post_rtt_max_ms":max,"coalesce_max":k,"posts":P,"batches":B}
//   Extra fields (n_batches, dropped, post_rtt_*, coalesce_max, posts, batches) are additions;
//   the last five describe the ~2 s since the previous heartbeat. dropped = since boot.

#include <WiFiS3.h>
#include <EEPROM.h>
#include "FspTimer.h"
#include "arduino_secrets.h"
#include "stream_out.h"

#define DEVICE_ID "lw-uno-1"
#define FW_VERSION "0.2.0"

// ---------- config ----------
static const float    SAMPLE_HZ      = 200.0f;
static const uint8_t  DT_MS          = 5;
static const uint8_t  NCH            = 4;
static const uint8_t  BATCH_N        = 40;                    // 200 ms per batch
// RAM: the core reserves 8 KB heap + 1 KB stack out of 32 KB, so the ring is what's left.
// Samples are packed 4 x 14 bit = 7 bytes. 45 slots = 12.6 KB (globals ~22.5 of ~23.2 KB usable).
static const uint8_t  RING_BATCHES   = 45;                    // ring slots (one is always being filled)
static const uint16_t RING_N         = RING_BATCHES * BATCH_N;
static const uint8_t  QUEUE_MAX      = RING_BATCHES - 2;      // 43 batches = 8.6 s offline, 1 slot of margin
static const uint8_t  SAMPLE_BYTES   = 7;
static const uint8_t  K_MAX          = 8;                     // max batches per POST (320 samples)
static const float    EMA_ALPHA      = 0.0952f;               // 1 - exp(-5 ms / 50 ms)
static const uint32_t HEARTBEAT_MS   = 2000;
static const uint32_t RESP_TIMEOUT_MS = 1500;
static const uint16_t CONNECT_TIMEOUT_MS = 2000;
static const uint32_t WIFI_JOIN_TIMEOUT_MS = 8000;
static const uint32_t SERIAL_LINE_MS = 250;   // each line blocks loop() ~4 ms (UART bridge)
static const uint32_t SERIAL_STATUS_MS = 5000;
static const uint8_t  ADC_PINS[NCH]  = {A0, A1, A2, A3};

// ---------- sampling (ISR side) ----------
static FspTimer sampleTimer;
static volatile uint8_t ring[RING_N * SAMPLE_BYTES];   // packed samples
static volatile uint32_t batchT0[RING_BATCHES];
static volatile uint32_t sampleCount = 0;   // total samples taken since start
static volatile uint32_t tickMaxGapUs = 0;  // worst interval between ticks
static volatile uint32_t tickMinGapUs = 0xFFFFFFFF;
static volatile uint32_t isrMaxUs = 0;      // worst ISR duration
static float ema[NCH];
static bool emaInit = false;
static uint32_t lastTickUs = 0;

static void onSampleTick(timer_callback_args_t *) {
  uint32_t t = micros();
  if (lastTickUs) {
    uint32_t gap = t - lastTickUs;
    if (gap > tickMaxGapUs) tickMaxGapUs = gap;
    if (gap < tickMinGapUs) tickMinGapUs = gap;
  }
  lastTickUs = t;

  uint32_t n = sampleCount;
  if (n % BATCH_N == 0) batchT0[(n / BATCH_N) % RING_BATCHES] = millis();
  uint64_t packed = 0;
  for (uint8_t c = 0; c < NCH; c++) {
    float x = (float)analogRead(ADC_PINS[c]);
    if (!emaInit) ema[c] = x; else ema[c] += EMA_ALPHA * (x - ema[c]);
    uint32_t v = (uint32_t)(ema[c] + 0.5f);
    if (v > 0x3FFF) v = 0x3FFF;
    packed |= (uint64_t)v << (14 * c);
  }
  volatile uint8_t *dst = ring + (uint32_t)(n % RING_N) * SAMPLE_BYTES;
  for (uint8_t i = 0; i < SAMPLE_BYTES; i++) dst[i] = (uint8_t)(packed >> (8 * i));
  emaInit = true;
  sampleCount = n + 1;

  uint32_t d = micros() - t;
  if (d > isrMaxUs) isrMaxUs = d;
}

// Unpack sample `slot` (0..RING_N-1) into out[4].
static void readSample(uint16_t slot, uint16_t out[NCH]) {
  const volatile uint8_t *src = ring + (uint32_t)slot * SAMPLE_BYTES;
  uint64_t packed = 0;
  for (uint8_t i = 0; i < SAMPLE_BYTES; i++) packed |= (uint64_t)src[i] << (8 * i);
  for (uint8_t c = 0; c < NCH; c++) out[c] = (uint16_t)((packed >> (14 * c)) & 0x3FFF);
}

static uint32_t samplesNow() {
  noInterrupts(); uint32_t n = sampleCount; interrupts();
  return n;
}

// ---------- queue / network state (loop side) ----------
static uint32_t seqBase = 0;          // added to the batch index to form the wire seq
static uint32_t nextSend = 0;         // batch index (not wire seq) of the oldest unacked batch
static uint32_t droppedBatches = 0;
static uint32_t sentBatches = 0, failedPosts = 0, heartbeatsOk = 0, reconnects = 0, wifiJoins = 0;
static uint32_t rttSumMs = 0, rttCount = 0, rttMaxMs = 0;          // serial status window
static uint32_t lastHeartbeatMs = 0, nextNetAttemptMs = 0, backoffMs = 250;
static uint32_t lastSerialLineMs = 0, lastStatusMs = 0, lastWifiCheckMs = 0;
static uint32_t startMicros = 0;
static bool wifiUp = false;
static int32_t lastRssi = 0;
static int lastErr = 0;          // last non-200 result from httpPost (negative = transport error)
static const uint32_t NO_GROUP = 0xFFFFFFFF;
static uint32_t inflightStart = NO_GROUP;  // first batch of the last unacked /ingest attempt
static uint8_t inflightK = 0;              // ... and how many batches it carried
static uint32_t lastOkMs = 0;              // last completed HTTP exchange (keep-alive idle check)
// Heartbeat window (reset at each heartbeat): what the link did over the last ~2 s.
static uint32_t winRttLast = 0, winRttMax = 0, winPosts = 0, winBatches = 0;
static uint8_t winCoalesceMax = 0;
static uint32_t statPosts = 0, statBatches = 0;  // serial status window
static uint8_t statCoalesceMax = 0;

static WiFiClient client;
static bool sockOpen = false;

// Requests are streamed out in TX_CHUNK pieces (one AT send each): an 8-batch body is ~7 KB,
// far more than the RAM we have left, so we never hold a whole body.
static char tx[1400];
static char resp[64];      // one HTTP response header line (lowercased, truncated)
static uint8_t rchunk[128];

// ---------- helpers ----------
static char *putU(char *p, uint32_t v) {
  char tmp[11]; int i = 0;
  do { tmp[i++] = '0' + (v % 10); v /= 10; } while (v);
  while (i) *p++ = tmp[--i];
  return p;
}
static char *putS(char *p, const char *s) { while (*s) *p++ = *s++; return p; }

static uint32_t completeBatches() { return samplesNow() / BATCH_N; }

// Drop the oldest pending batches if the backlog exceeds the queue (ring) capacity. If that
// cuts into the group of a failed attempt, drop the rest of that group too: the server may
// already hold it under the group's first seq, and a new group must never overlap it.
static void enforceQueueLimit() {
  uint32_t done = completeBatches();
  if (done - nextSend > QUEUE_MAX) {
    uint32_t drop = (done - nextSend) - QUEUE_MAX;
    nextSend += drop;
    droppedBatches += drop;
    if (inflightStart != NO_GROUP && nextSend > inflightStart) {
      uint32_t end = inflightStart + inflightK;
      if (nextSend < end) { droppedBatches += end - nextSend; nextSend = end; }
      inflightStart = NO_GROUP;
    }
  }
}

// /ingest body for batches [b0, b0+k): same shape as one batch, just k*40 samples per channel.
// Samples are contiguous at 5 ms, so t0_ms of the first batch + dt_ms describes them all.
static void emitIngest(Out &o, uint32_t b0, uint8_t k) {
  o.str("{\"device\":\"" DEVICE_ID "\",\"seq\":"); o.u(seqBase + b0);
  o.str(",\"t0_ms\":"); o.u(batchT0[b0 % RING_BATCHES]);
  o.str(",\"dt_ms\":5,\"n_batches\":"); o.u(k);
  o.str(",\"ch\":[");
  uint16_t v[NCH];
  for (uint8_t c = 0; c < NCH; c++) {
    if (c) o.ch(',');
    o.ch('[');
    for (uint8_t j = 0; j < k; j++) {
      uint16_t first = (uint16_t)((b0 + j) % RING_BATCHES) * BATCH_N;
      for (uint8_t i = 0; i < BATCH_N; i++) {
        if (j || i) o.ch(',');
        readSample(first + i, v);   // unpack per value: cheap, saves RAM
        o.u(v[c]);
      }
    }
    o.ch(']');
  }
  o.str("]}");
}

// emit runs twice (dry count, then send), so every value must be fixed before the first pass:
// a = uptime snapshot, hbDone = completed-batch snapshot (set by the caller).
static uint32_t hbDone = 0;
static void emitHeartbeat(Out &o, uint32_t uptime, uint8_t) {
  uint32_t done = hbDone;
  o.str("{\"device\":\"" DEVICE_ID "\",\"seq\":"); o.u(seqBase + (done ? done - 1 : 0));
  o.str(",\"uptime_ms\":"); o.u(uptime);
  o.str(",\"rssi\":"); o.i(lastRssi);
  o.str(",\"queue\":"); o.u(done - nextSend);
  o.str(",\"fw\":\"" FW_VERSION "\",\"dropped\":"); o.u(droppedBatches);
  o.str(",\"post_rtt_ms\":"); o.u(winRttLast);
  o.str(",\"post_rtt_max_ms\":"); o.u(winRttMax);
  o.str(",\"coalesce_max\":"); o.u(winCoalesceMax);
  o.str(",\"posts\":"); o.u(winPosts);
  o.str(",\"batches\":"); o.u(winBatches);
  o.ch('}');
}

static void closeSock() {
  if (sockOpen) client.stop();
  sockOpen = false;
}

static void netFailed(int code) {
  failedPosts++;
  lastErr = code;
  closeSock();
  nextNetAttemptMs = millis() + backoffMs;
  backoffMs = min<uint32_t>(backoffMs * 2, 2000);
}

// POST the body produced by emit(a, k) to path. Returns the HTTP status (200 = ok) or a
// negative error. If guard is set, `a` is a batch index whose ring slot must not be overwritten
// while we stream it; if it was, the request is aborted before its last bytes go out.
static int httpPost(const char *path, EmitFn emit, uint32_t a, uint8_t k, bool guard, uint32_t &rttOut) {
  // Server keep-alive timeout is 5 s; we talk at least every 2 s, but reopen if we've been idle.
  if (sockOpen && millis() - lastOkMs > 4000) closeSock();
  if (!sockOpen) {
    client.setConnectionTimeout(CONNECT_TIMEOUT_MS);
    if (!client.connect(LAPTOP_IP, LAPTOP_PORT)) return -1;
    sockOpen = true;
    reconnects++;
  }

  Out d = {&client, tx, sizeof(tx), true, true, 0, 0};
  emit(d, a, k);

  uint32_t t = millis();
  Out o = {&client, tx, sizeof(tx), false, true, 0, 0};
  o.str("POST "); o.str(path);
  o.str(" HTTP/1.1\r\nHost: " LAPTOP_IP "\r\nContent-Length: "); o.u(d.total);
  o.str("\r\n\r\n");
  emit(o, a, k);
  if (guard && samplesNow() > (a + RING_BATCHES) * (uint32_t)BATCH_N) {
    closeSock();   // the oldest batch was overwritten mid-stream: never complete this request
    return -7;
  }
  o.flush();
  if (!o.ok) return -3;

  // Read the full response so keep-alive stays in sync (it's one ~260 B TCP segment, fetched
  // in one AT receive). Headers are parsed line by line, so any header length works.
  uint32_t tw = millis();
  size_t lineLen = 0;
  bool gotStatus = false, inBody = false, closeAfter = false;
  long contentLen = -1, bodyRead = 0;
  int status = -6;  // garbage status line
  while (millis() - tw < RESP_TIMEOUT_MS) {
    int av = client.available();
    if (av <= 0) continue;
    int r = client.read(rchunk, min(av, (int)sizeof(rchunk)));
    if (r <= 0) continue;
    for (int i = 0; i < r; i++) {
      char c = (char)rchunk[i];
      if (inBody) { bodyRead++; continue; }
      if (c == '\r') continue;
      if (c != '\n') { if (lineLen < sizeof(resp) - 1) resp[lineLen++] = (char)tolower(c); continue; }
      resp[lineLen] = 0;
      if (!gotStatus) {
        gotStatus = true;
        if (strncmp(resp, "http/1.", 7) == 0) status = atoi(resp + 9);
      } else if (lineLen == 0) {
        inBody = true;
        if (contentLen < 0) closeAfter = true;  // can't frame the body: don't reuse the socket
      } else if (strncmp(resp, "content-length:", 15) == 0) {
        contentLen = atol(resp + 15);
      } else if (strncmp(resp, "connection:", 11) == 0 && strstr(resp, "close")) {
        closeAfter = true;
      }
      lineLen = 0;
    }
    if (inBody && (contentLen < 0 || bodyRead >= contentLen)) break;
  }
  if (!inBody) return -4;  // timeout before the headers ended
  if (contentLen >= 0 && bodyRead != contentLen) closeAfter = true;  // out of sync: start fresh
  uint32_t rtt = millis() - t;
  rttOut = rtt;
  rttSumMs += rtt; rttCount++;
  if (rtt > rttMaxMs) rttMaxMs = rtt;
  lastOkMs = millis();
  if (closeAfter) closeSock();
  return status;
}

// ---------- Wi-Fi ----------
static bool ensureWifi() {
  uint32_t now = millis();
  if (wifiUp && now - lastWifiCheckMs < 1000) return true;
  lastWifiCheckMs = now;
  if (WiFi.status() == WL_CONNECTED && WiFi.localIP() != IPAddress(0, 0, 0, 0)) {
    wifiUp = true;
    return true;
  }
  wifiUp = false;
  closeSock();
  Serial.print("# wifi: joining "); Serial.println(SECRET_SSID);
  WiFi.disconnect();
  WiFi.setTimeout(WIFI_JOIN_TIMEOUT_MS);
  if (WiFi.begin(SECRET_SSID, SECRET_PASS) == WL_CONNECTED) {
    uint32_t s = millis();
    while (WiFi.localIP() == IPAddress(0, 0, 0, 0) && millis() - s < 5000) { /* wait for DHCP */ }
  }
  if (WiFi.status() == WL_CONNECTED && WiFi.localIP() != IPAddress(0, 0, 0, 0)) {
    wifiUp = true;
    wifiJoins++;
    lastRssi = WiFi.RSSI();
    Serial.print("# wifi: up ip "); Serial.print(WiFi.localIP());
    Serial.print(" rssi "); Serial.println(lastRssi);
    backoffMs = 250;
    nextNetAttemptMs = 0;
  } else {
    Serial.println("# wifi: join failed, retrying");
  }
  lastWifiCheckMs = millis();
  return wifiUp;
}

// ---------- serial ----------
static void serialOut() {
  uint32_t now = millis();
  if (now - lastSerialLineMs >= SERIAL_LINE_MS) {
    lastSerialLineMs = now;
    uint32_t n = samplesNow();
    if (n) {
      uint16_t v[NCH];
      readSample((n - 1) % RING_N, v);
      char line[96]; char *p = line;
      p = putS(p, "rbi:");   p = putU(p, v[0]);
      p = putS(p, " rdelt:"); p = putU(p, v[1]);
      p = putS(p, " lbi:");  p = putU(p, v[2]);
      p = putS(p, " ldelt:"); p = putU(p, v[3]);
      p = putS(p, " q:");    p = putU(p, n / BATCH_N - nextSend);
      p = putS(p, "\r\n");
      Serial.write((const uint8_t *)line, p - line);
    }
  }
  if (now - lastStatusMs >= SERIAL_STATUS_MS) {
    lastStatusMs = now;
    noInterrupts();
    uint32_t n = sampleCount, gmax = tickMaxGapUs, gmin = tickMinGapUs, imax = isrMaxUs;
    tickMaxGapUs = 0; tickMinGapUs = 0xFFFFFFFF; isrMaxUs = 0;
    interrupts();
    uint32_t expected = (micros() - startMicros) / 5000;
    char line[320];
    snprintf(line, sizeof(line),
             "# wifi=%d rssi=%ld sent=%lu fail=%lu err=%d drop=%lu hb=%lu conn=%lu q=%lu posts=%lu k_avg=%lu.%lu k_max=%u "
             "rtt_avg=%lums rtt_max=%lums samples=%lu expected~%lu tick_us=%lu..%lu isr_max=%luus\r\n",
             wifiUp ? 1 : 0, (long)lastRssi, (unsigned long)sentBatches, (unsigned long)failedPosts,
             lastErr, (unsigned long)droppedBatches, (unsigned long)heartbeatsOk, (unsigned long)reconnects,
             (unsigned long)(n / BATCH_N - nextSend), (unsigned long)statPosts,
             (unsigned long)(statPosts ? statBatches / statPosts : 0),
             (unsigned long)(statPosts ? (statBatches * 10 / statPosts) % 10 : 0), (unsigned)statCoalesceMax,
             (unsigned long)(rttCount ? rttSumMs / rttCount : 0), (unsigned long)rttMaxMs,
             (unsigned long)n, (unsigned long)expected,
             (unsigned long)(gmin == 0xFFFFFFFF ? 0 : gmin), (unsigned long)gmax, (unsigned long)imax);
    Serial.write((const uint8_t *)line, strlen(line));
    rttSumMs = 0; rttCount = 0; rttMaxMs = 0;
    statPosts = 0; statBatches = 0; statCoalesceMax = 0;
  }
}

// ---------- setup / loop ----------
void setup() {
  Serial.begin(115200);
  uint32_t s = millis();
  while (!Serial && millis() - s < 1500) {}  // don't wait forever on battery

  analogReadResolution(14);

  // Boot counter -> seq base, so seqs never repeat across reboots.
  uint32_t boots = 0;
  EEPROM.get(0, boots);
  if (boots == 0xFFFFFFFF) boots = 0;   // erased flash
  boots++;
  EEPROM.put(0, boots);
  seqBase = (boots % 4000) * 1000000UL;
  Serial.print("# lightweight fw " FW_VERSION " boot "); Serial.print(boots);
  Serial.print(" seq_base "); Serial.println(seqBase);

  // 200 Hz sampling timer. Priority 14 (lower than UART 12 and the millis tick 8), so the
  // modem UART is never starved by our ~100 us ISR.
  uint8_t type = 0;
  int8_t ch = FspTimer::get_available_timer(type);
  if (ch < 0) ch = FspTimer::get_available_timer(type, true);
  bool ok = ch >= 0 &&
            sampleTimer.begin(TIMER_MODE_PERIODIC, type, ch, SAMPLE_HZ, 0.0f, onSampleTick) &&
            sampleTimer.setup_overflow_irq(14) &&
            sampleTimer.open() &&
            sampleTimer.start();
  Serial.println(ok ? "# sampler: 200 Hz timer running" : "# sampler: TIMER SETUP FAILED");
  startMicros = micros();
}

void loop() {
  serialOut();
  enforceQueueLimit();
  if (!ensureWifi()) return;

  uint32_t now = millis();
  if ((int32_t)(now - nextNetAttemptMs) < 0) return;

  // Heartbeat every 2 s (interleaved with batches), carrying the link stats of that window.
  if (now - lastHeartbeatMs >= HEARTBEAT_MS) {
    lastHeartbeatMs = now;
    lastRssi = WiFi.RSSI();
    uint32_t rtt = 0;
    hbDone = completeBatches();
    int st = httpPost("/heartbeat", emitHeartbeat, millis(), 0, false, rtt);
    if (st != 200) { netFailed(st); return; }
    heartbeatsOk++;
    backoffMs = 250;
    winRttLast = 0; winRttMax = 0; winPosts = 0; winBatches = 0; winCoalesceMax = 0;
  }

  // Send everything pending (oldest first), up to K_MAX batches per POST. Live this is 1-2
  // batches per POST; after an outage it's K_MAX until the backlog is gone.
  enforceQueueLimit();
  uint32_t done = completeBatches();
  if (nextSend >= done) return;
  uint8_t k;
  if (inflightStart == nextSend) {
    k = inflightK;  // retry: identical grouping, so the server's (seq, t0_ms) dedupe matches it
  } else {
    uint32_t pending = done - nextSend;
    k = (uint8_t)min<uint32_t>(pending, K_MAX);
    // Batches left before the ISR overwrites nextSend's slot. Streaming k batches takes
    // roughly (1 + k/2) batch periods, so keep k small when we're near the ring's edge.
    uint32_t room = nextSend + RING_BATCHES - done;
    uint32_t kRoom = room >= 2 ? 2 * room - 3 : 1;
    if (k > kRoom) k = (uint8_t)kRoom;
    inflightStart = nextSend;
    inflightK = k;
  }
  uint32_t rtt = 0;
  int st = httpPost("/ingest", emitIngest, nextSend, k, true, rtt);
  if (st == 200) {
    nextSend += k;
    sentBatches += k;
    inflightStart = NO_GROUP;
    backoffMs = 250;
    winRttLast = rtt;
    if (rtt > winRttMax) winRttMax = rtt;
    winPosts++; winBatches += k;
    if (k > winCoalesceMax) winCoalesceMax = k;
    statPosts++; statBatches += k;
    if (k > statCoalesceMax) statCoalesceMax = k;
  } else if (st >= 400 && st < 500) {
    // Server read it and refused it (bad request / no route). Resending won't help: skip it.
    Serial.print("# ingest rejected, http "); Serial.println(st);
    nextSend += k;
    droppedBatches += k;
    inflightStart = NO_GROUP;
  } else {
    netFailed(st);
  }
}
