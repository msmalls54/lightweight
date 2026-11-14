# Firmware: UNO R4 WiFi streamer

`lightweight/lightweight.ino` samples the 4 MyoWare ENV channels at 200 Hz and POSTs them to the laptop server in the BUILD.md format.

| Jack | `ch[i]` | Muscle |
|---|---|---|
| A0 | 0 | R biceps |
| A1 | 1 | R front delt |
| A2 | 2 | L biceps |
| A3 | 3 | L front delt |

## How it works
- **Sampling** runs in a hardware timer interrupt (FspTimer, 200 Hz, IRQ priority 14). WiFiS3 calls block `loop()` (they're AT commands over a UART to the ESP32-S3), but they can't delay a sample. ISR ≈ 100 µs. 14-bit `analogRead`, then an EMA with a ~50 ms time constant (alpha 0.095).
- **Batches:** 40 samples = 200 ms. `POST /ingest {"device":"lw-uno-1","seq","t0_ms","dt_ms":5,"ch":[[40],[40],[40],[40]]}`. `t0_ms` = `millis()` of the first sample.
- **Offline queue:** the sample ring is the queue. `loop()` always sends the oldest unacked batch and only moves on after HTTP 200, so a resend keeps its `seq` and order is preserved. Holds **43 batches = 8.6 s** (RAM limit: the core reserves 8 KB heap + 1 KB stack; samples are packed 7 bytes each to fit). Beyond that the oldest are dropped and counted. A 4xx reply skips that batch (resending won't help); timeouts and 5xx retry with backoff 250 ms → 2 s.
- **seq across reboots:** `seq = bootCount × 1,000,000 + batchIndex`, with the boot counter in EEPROM, so a reboot never reuses a seq the server already saw (the server ignores duplicates). A reboot looks like a big forward seq jump plus `uptime_ms`/`t0_ms` going back to ~0.
- **Heartbeat** every 2 s: `POST /heartbeat {"device","seq","uptime_ms","rssi","queue","fw":"0.1.0","dropped"}`. `seq` = newest captured batch. `dropped` (extra field) = batches dropped since boot.
- **HTTP/1.1 keep-alive** to `LAPTOP_IP:3000`; header + body go out in one AT send. Any error closes the socket and reconnects. Wi-Fi rejoins forever (8 s per attempt).
- **No LED matrix** (the shield covers it).
- **Serial 115200:** a plotter line every 100 ms (`rbi:… rdelt:… lbi:… ldelt:… q:…`) and every 5 s a status line:
  `# wifi=1 rssi=-25 sent=… fail=… drop=… hb=… conn=… q=… rtt_avg=…ms rtt_max=…ms samples=… expected~… tick_us=4990..5010 isr_max=…us`
  `samples` ≈ `expected` and `tick_us` ≈ 5000 prove sampling never stalls; `conn` counts TCP (re)connects (should stay ~1 with keep-alive).

## Configure
```bash
cp firmware/lightweight/arduino_secrets.example.h firmware/lightweight/arduino_secrets.h
```
Fill in `SECRET_SSID`, `SECRET_PASS`, `LAPTOP_IP` (iPhone hotspot: `172.20.10.2`), `LAPTOP_PORT 3000`. The file is gitignored; never commit it or print the password. Venue values: copy `bench/hotspot_test/arduino_secrets.h`. The UNO is 2.4 GHz only.

## Compile
```bash
arduino-cli compile --fqbn arduino:renesas_uno:unor4wifi firmware/lightweight
```
Expect ~69 KB flash, ~22.5 KB globals. Above ~23.2 KB the link fails (heap reservation), so watch it if you grow the ring.

## Upload (pads OFF the skin: never USB-to-laptop with electrodes on)
```bash
arduino-cli upload -p COM8 --fqbn arduino:renesas_uno:unor4wifi firmware/lightweight
```

## Test without the real server
Laptop on the "iPhone (99)" hotspot, then:
```bash
node firmware/tools/ingest_logger.mjs --minutes 5
```
Every 5 s it prints batches/s, samples per batch, seq gaps, resends, the last heartbeat, and per-channel min/mean/max. After 5 minutes it prints a JSON verdict and `PASS` (≈5.0 batches/s, no missing seqs, `t0_ms` steps of exactly 200 ms) or `FAIL`. It uses port 3000, so stop the real server first (or pass `--port`). Serial monitor for the board side:
```bash
arduino-cli monitor -p COM8 -c baudrate=115200
```

## On battery (on-body)
Unplug from the laptop, plug the UNO into the power bank. It joins the hotspot and streams within ~5–10 s. The dashboard's heartbeat (RSSI, queue, dropped) is your only status then.

## Measured (Nov 14, YC, iPhone hotspot, against the real server on :3000)
352.8 s run after upload (sensor cables unplugged, so values were noise): **1,764 batches, 5.000 batches/s, every one 4×40, 0 seq gaps, 0 resends, 0 dropped, 0 `t0_ms` discontinuities** (all steps exactly 200 ms). Board side: `samples` = `expected` ±1 the whole run, tick interval 4,940–5,060 µs, ISR max 172 µs, 1 TCP connection for the whole run (keep-alive), POST round-trip avg ~131 ms / max 273 ms, RSSI -40 to -52.

Headroom: each ~1.2 KB POST takes ~130 ms, mostly the 115,200-baud UART to the ESP32-S3, so the link runs ~70% busy. After an outage it catches up at only ~2.5 batches/s net: a full 8.6 s backlog takes ~17 s to drain. Live data lags by that much until then.

## Troubleshooting
- No Serial output at all: on the R4 WiFi, `Serial` is a UART bridged by the ESP32-S3. A terminal needs DTR on. `arduino-cli monitor` prints nothing when its stdout isn't a TTY; use a real terminal or the IDE's Serial Monitor.
- `# wifi: join failed` forever: hotspot off/asleep, or not 2.4 GHz ("Maximize Compatibility" on the iPhone). Keep the hotspot screen open while joining.
- `fail` climbing, `q` growing: server not on `LAPTOP_IP:3000`, laptop IP changed (check `ipconfig`), or firewall.
- A channel flat at ~8,150: that Link Shield is on RAW, not ENV.
