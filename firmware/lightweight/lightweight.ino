// Lightweight firmware: UNO R4 WiFi + MyoWare 2 Arduino Shield, 4 EMG channels (ENV output).
//
//   A0 = R biceps, A1 = R front delt, A2 = L biceps, A3 = L front delt (BUILD.md channel map).
//
// Design:
//  - Sampling runs in a hardware timer interrupt at 200 Hz (FspTimer), so nothing the network
//    does in loop() can delay or drop a sample. WiFiS3 calls are blocking AT commands over a
//    UART to the ESP32-S3; that's fine here because they only block loop().
//  - The sample ring buffer IS the offline queue: batch `seq` k = samples [40k, 40k+40).
//    loop() sends the oldest unacked batch, one POST per batch, and only advances on HTTP 200.
//    A resend keeps its seq. If more than QUEUE_MAX batches are pending, the oldest are dropped.
//  - seq starts at bootCount * 1,000,000 (boot counter in EEPROM), so a reboot never reuses a
//    seq the server already saw (it ignores duplicate seqs).
//  - HTTP/1.1 keep-alive to the laptop; reconnect on any error. Wi-Fi retries forever.
//  - Serial 115200: 10 Hz plotter line (4 values + queue depth) and a "# ..." status every 5 s.
//    On the R4 WiFi, Serial is a UART bridged by the ESP32-S3 (not native USB): writes block
//    ~87 us/byte (only loop(), never the sampler) and availableForWrite() always returns 0.
//
// Wire format (BUILD.md, do not change):
//   POST /ingest    {"device":"lw-uno-1","seq":N,"t0_ms":T,"dt_ms":5,"ch":[[..40..],[..],[..],[..]]}
//   POST /heartbeat {"device":"lw-uno-1","seq":N,"uptime_ms":U,"rssi":R,"queue":Q,"fw":"0.1.0","dropped":D}
//   ("dropped" is an extra field: total batches dropped from the offline queue since boot.)

#include <WiFiS3.h>
#include <EEPROM.h>
#include "FspTimer.h"
#include "arduino_secrets.h"

#define DEVICE_ID "lw-uno-1"
#define FW_VERSION "0.1.0"

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
static const float    EMA_ALPHA      = 0.0952f;               // 1 - exp(-5 ms / 50 ms)
static const uint32_t HEARTBEAT_MS   = 2000;
static const uint32_t RESP_TIMEOUT_MS = 1500;
static const uint16_t CONNECT_TIMEOUT_MS = 2000;
static const uint32_t WIFI_JOIN_TIMEOUT_MS = 8000;
static const uint32_t SERIAL_LINE_MS = 100;
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
static uint32_t rttSumMs = 0, rttCount = 0, rttMaxMs = 0;
static uint32_t lastHeartbeatMs = 0, nextNetAttemptMs = 0, backoffMs = 250;
static uint32_t lastSerialLineMs = 0, lastStatusMs = 0, lastWifiCheckMs = 0;
static uint32_t startMicros = 0;
static bool wifiUp = false;
static int32_t lastRssi = 0;
static int lastErr = 0;          // last non-200 result from httpPost (negative = transport error)

static WiFiClient client;
static bool sockOpen = false;

// One TX buffer: the JSON body is built at tx + HDR_RESERVE, then the HTTP header is written
// right in front of it, so header + body go out in a single AT send.
static const uint16_t HDR_RESERVE = 192;
static char tx[HDR_RESERVE + 1100];
static char *const body = tx + HDR_RESERVE;
static const uint16_t BODY_MAX = sizeof(tx) - HDR_RESERVE;
static char resp[64];      // one HTTP response header line (lowercased, truncated)
static uint8_t rchunk[128];

// ---------- helpers ----------
static char *putU(char *p, uint32_t v) {
  char tmp[11]; int i = 0;
  do { tmp[i++] = '0' + (v % 10); v /= 10; } while (v);
  while (i) *p++ = tmp[--i];
  return p;
}
static char *putI(char *p, int32_t v) {
  if (v < 0) { *p++ = '-'; v = -v; }
  return putU(p, (uint32_t)v);
}
static char *putS(char *p, const char *s) { while (*s) *p++ = *s++; return p; }

static uint32_t completeBatches() { return samplesNow() / BATCH_N; }

// Drop the oldest pending batches if the backlog exceeds the queue (ring) capacity.
static void enforceQueueLimit() {
  uint32_t done = completeBatches();
  if (done - nextSend > QUEUE_MAX) {
    uint32_t drop = (done - nextSend) - QUEUE_MAX;
    nextSend += drop;
    droppedBatches += drop;
  }
}

// Build the /ingest JSON for batch index b into body[]. Returns length, or 0 if the slot was
// overwritten while copying (can't happen with QUEUE_MAX margin, but checked anyway).
static size_t buildBatch(uint32_t b) {
  uint8_t s = b % RING_BATCHES;
  char *p = body;
  p = putS(p, "{\"device\":\"" DEVICE_ID "\",\"seq\":");
  p = putU(p, seqBase + b);
  p = putS(p, ",\"t0_ms\":");
  p = putU(p, batchT0[s]);
  p = putS(p, ",\"dt_ms\":");
  p = putU(p, DT_MS);
  p = putS(p, ",\"ch\":[");
  uint16_t first = (uint16_t)s * BATCH_N;
  uint16_t v[NCH];
  for (uint8_t c = 0; c < NCH; c++) {
    if (c) *p++ = ',';
    *p++ = '[';
    for (uint8_t i = 0; i < BATCH_N; i++) {
      if (i) *p++ = ',';
      readSample(first + i, v);   // unpack per value: cheap, saves a 320 B buffer
      p = putU(p, v[c]);
    }
    *p++ = ']';
  }
  p = putS(p, "]}");
  // Overwrite check: the ISR must not have started writing batch b + RING_BATCHES.
  if (samplesNow() > (b + RING_BATCHES) * (uint32_t)BATCH_N) return 0;
  return p - body;
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

// POST body[0..len) to path. Returns the HTTP status (200 = ok) or a negative error code.
static int httpPost(const char *path, size_t len) {
  if (sockOpen && !client.connected()) closeSock();
  if (!sockOpen) {
    client.setConnectionTimeout(CONNECT_TIMEOUT_MS);
    if (!client.connect(LAPTOP_IP, LAPTOP_PORT)) return -1;
    sockOpen = true;
    reconnects++;
  }

  // Header goes right in front of the body: header + body in a single write = one AT send.
  char hdr[HDR_RESERVE];
  char *p = hdr;
  p = putS(p, "POST ");
  p = putS(p, path);
  p = putS(p, " HTTP/1.1\r\nHost: " LAPTOP_IP "\r\nContent-Type: application/json\r\nConnection: keep-alive\r\nContent-Length: ");
  p = putU(p, len);
  p = putS(p, "\r\n\r\n");
  size_t hlen = p - hdr;
  if (hlen > HDR_RESERVE || len > BODY_MAX) return -2;
  char *start = body - hlen;
  memcpy(start, hdr, hlen);
  uint32_t t = millis();
  if (client.write((const uint8_t *)start, hlen + len) != hlen + len) return -3;

  // Read the full response so keep-alive stays in sync. Headers are parsed line by line, so
  // any header length works (the real server sends ~230 bytes of headers incl. CORS).
  size_t lineLen = 0;
  bool gotStatus = false, inBody = false, closeAfter = false;
  long contentLen = -1, bodyRead = 0;
  int status = -6;  // garbage status line
  while (millis() - t < RESP_TIMEOUT_MS) {
    int a = client.available();
    if (a <= 0) continue;
    int r = client.read(rchunk, min(a, (int)sizeof(rchunk)));
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
  rttSumMs += rtt; rttCount++;
  if (rtt > rttMaxMs) rttMaxMs = rtt;
  if (closeAfter) closeSock();
  return status;
}

static size_t buildHeartbeat() {
  char *p = body;
  uint32_t done = completeBatches();
  p = putS(p, "{\"device\":\"" DEVICE_ID "\",\"seq\":");
  p = putU(p, seqBase + (done ? done - 1 : 0));
  p = putS(p, ",\"uptime_ms\":");
  p = putU(p, millis());
  p = putS(p, ",\"rssi\":");
  p = putI(p, lastRssi);
  p = putS(p, ",\"queue\":");
  p = putU(p, done - nextSend);
  p = putS(p, ",\"fw\":\"" FW_VERSION "\",\"dropped\":");
  p = putU(p, droppedBatches);
  p = putS(p, "}");
  return p - body;
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
    char line[256];
    snprintf(line, sizeof(line),
             "# wifi=%d rssi=%ld sent=%lu fail=%lu err=%d drop=%lu hb=%lu conn=%lu q=%lu "
             "rtt_avg=%lums rtt_max=%lums samples=%lu expected~%lu tick_us=%lu..%lu isr_max=%luus\r\n",
             wifiUp ? 1 : 0, (long)lastRssi, (unsigned long)sentBatches, (unsigned long)failedPosts,
             lastErr, (unsigned long)droppedBatches, (unsigned long)heartbeatsOk, (unsigned long)reconnects,
             (unsigned long)(n / BATCH_N - nextSend),
             (unsigned long)(rttCount ? rttSumMs / rttCount : 0), (unsigned long)rttMaxMs,
             (unsigned long)n, (unsigned long)expected,
             (unsigned long)(gmin == 0xFFFFFFFF ? 0 : gmin), (unsigned long)gmax, (unsigned long)imax);
    Serial.write((const uint8_t *)line, strlen(line));
    rttSumMs = 0; rttCount = 0; rttMaxMs = 0;
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
  serialOut();

  uint32_t now = millis();
  if ((int32_t)(now - nextNetAttemptMs) < 0) return;

  // Heartbeat every 2 s (interleaved with batches).
  if (now - lastHeartbeatMs >= HEARTBEAT_MS) {
    lastHeartbeatMs = now;
    lastRssi = WiFi.RSSI();
    size_t len = buildHeartbeat();
    int st = httpPost("/heartbeat", len);
    if (st == 200) { heartbeatsOk++; backoffMs = 250; }
    else { netFailed(st); return; }
  }

  // Oldest unacked batch.
  enforceQueueLimit();
  if (nextSend < completeBatches()) {
    size_t len = buildBatch(nextSend);
    if (len == 0) { nextSend++; droppedBatches++; return; }
    int st = httpPost("/ingest", len);
    if (st == 200) {
      nextSend++;
      sentBatches++;
      backoffMs = 250;
    } else if (st >= 400 && st < 500) {
      // Server read it and refused it (bad request / no route). Resending won't help: skip it.
      Serial.print("# ingest rejected, http "); Serial.println(st);
      nextSend++;
      droppedBatches++;
    } else {
      netFailed(st);
    }
  }
}
