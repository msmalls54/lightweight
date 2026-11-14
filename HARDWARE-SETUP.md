# Hardware setup checklist (do this before the event)

Do the parts in order. Tick each box. If something looks wrong, stop and tell Claude what you see.

> **Safety rule:** pads on skin = UNO on the **power bank only**. Never have pads on while the UNO's cable goes into the laptop.

### Note for Claude (Chat) helping with this
- Project: **Lightweight**, a wearables hackathon build (4 MyoWare 2 EMG sensors → Arduino UNO R4 WiFi → laptop). Mike is setting up hardware the night before. All test code he needs is in the **Appendix** at the bottom of this file. It already compiles.
- You **can't run commands on the laptop**. Every command is written out below; Mike pastes it into PowerShell and pastes the output back to you.
- Already installed and verified on the laptop: `arduino-cli` 1.5.1 with core `arduino:renesas_uno` 1.6.0, `ArduinoGraphics`, Node 24. The UNO showed up as **COM8**. Its Wi-Fi firmware (0.6.0) is the latest. Node is already allowed through the Windows firewall.
- Files live in `C:\Users\Small\lightweight` (git repo). Test sketches are in `bench\`.
- Don't write project code (the real firmware and server get written at the event). Only help with these hardware checks.

### How to open the terminal (used in several parts)
1. Press the **Windows key**, type `PowerShell`, press **Enter**.
2. Paste this and press **Enter**:
   ```
   cd C:\Users\Small\lightweight
   ```
3. Every command below is pasted into that window, one at a time, each followed by **Enter**.

---

## Part 0: Put everything on the table

- [ ] UNO R4 WiFi (the board with the LED grid)
- [ ] MyoWare **Arduino Shield** (flat board with 6 headphone-style jacks)
- [ ] 1 MyoWare **sensor** + 1 **Link Shield** (just one of each for now)
- [ ] 1 headphone-style **TRS cable**
- [ ] 3 snap **electrode pads**, alcohol wipe, razor
- [ ] USB-C cable, **power bank** (charged)
- [ ] Masking tape + pen (for labels)
- [ ] Bluetooth speaker (charged), your phone

---

## Part 1: Assemble (nothing powered)

1. [ ] **Unplug** the UNO's USB cable from the laptop.
2. [ ] Look at the bottom of the Arduino Shield: it has rows of metal pins. Look at the UNO: it has black header strips with holes.
3. [ ] Line the shield up so its pins sit over the UNO's holes. **All pins must go in a hole; none hanging off the edge.** The USB port end of the UNO should stay uncovered.
4. [ ] Press down gently and evenly on both ends until it's seated flat. Don't bend pins.
5. [ ] Take the Link Shield and snap it onto the **top** of the MyoWare sensor (it clicks onto the snap buttons).
6. [ ] On the Link Shield, find the two tiny switches:
   - [ ] Output switch → **ENV**
   - [ ] Power switch → **ON**
7. [ ] Plug one end of the TRS cable into the Link Shield's jack.
8. [ ] Plug the other end into the Arduino Shield jack labeled **A0**. Push until it clicks fully in.
9. [ ] Make tape labels for all 4 cables now, so you don't mix them up later:
   - `A0 R-BICEP`
   - `A1 R-DELT`
   - `A2 L-BICEP`
   - `A3 L-DELT`
   Stick the label on **both ends** of each cable.

---

## Part 2: Load the sensor test (no pads yet)

1. [ ] Make sure **no pads are on your body**.
2. [ ] Plug the UNO into the laptop with the USB-C cable.
3. [ ] Open the terminal (see "How to open the terminal" above). Find the board's port:
   ```
   arduino-cli board list
   ```
   You should see a line with **Arduino UNO R4 WiFi** and a port like **COM8**. If your port is different, use your port instead of `COM8` in every command below.
4. [ ] Upload the sensor test:
   ```
   arduino-cli compile --upload -p COM8 --fqbn arduino:renesas_uno:unor4wifi bench\sensor_bars
   ```
   Wait until it says **Done in ... seconds** (about 30 seconds the first time).
5. [ ] Look at the LED grid: you should see a **blinking dot in the top-right corner**. That means the test is running. Bars may flicker; that's fine with no pads.
6. [ ] **Unplug the USB cable from the laptop.**

---

## Part 3: Sensor on your arm + power bank test

1. [ ] Plug the UNO's USB cable into the **power bank** instead. The blinking corner dot should come back.
   - If the power bank turns itself off within a minute, write that down; you'll need a different power bank or its "low current" mode.
2. [ ] Pick your **right biceps**. If it's hairy, shave a patch about the size of a credit card.
3. [ ] Wipe it with the alcohol pad. **Wait 30 seconds** until it's fully dry.
4. [ ] Snap 3 electrode pads onto the 3 snap buttons on the **bottom** of the MyoWare sensor.
5. [ ] Peel the backing off all 3 pads.
6. [ ] Lay the sensor on your biceps **the long way** (pointing from shoulder to elbow), with the middle of the sensor on the fattest part of the muscle. The pad on the small side tab lands wherever it lands; that's fine.
7. [ ] Press each pad down firmly for 5 seconds.
8. [ ] Let your arm hang **relaxed**. Look at the **leftmost bar** (A0).
   - Expected: low (0–2 dots).
9. [ ] **Flex hard** (curl your fist up and squeeze).
   - Expected: the leftmost bar **jumps up** (5–8 dots), then drops when you relax.
10. [ ] Do 5 slow fake curls. The bar should rise and fall with each one.

**If it's wrong:**
| What you see | Do this |
|---|---|
| Bar stays at 0 even when flexing | Check Link Shield switches (ENV, ON). Check the cable is pushed fully into **A0** on both ends. Press the pads down again. |
| Bar is full even when relaxed | Gain too high. Find the tiny screw on the MyoWare sensor. Turn it a little (a quarter turn) with a small screwdriver, check again. If it gets worse, turn the other way. |
| Bar jumps randomly | A pad is loose or skin wasn't dry. Re-wipe and use fresh pads. |

11. [ ] Leave it running on the power bank for **10 minutes** (you can take the sensor off your arm). Check the corner dot is still blinking after 10 minutes. That proves the power bank won't shut off on stage.
12. [ ] Peel the pads off and throw them away (single-use).

---

## Part 4: Phone hotspot + Wi-Fi test

The UNO only works on **2.4 GHz** Wi-Fi. Phone hotspots default to 5 GHz on some phones, so do this exactly.

1. [ ] On your phone, turn on the hotspot:
   - **iPhone:** Settings → Personal Hotspot → turn on **Allow Others to Join** → turn on **Maximize Compatibility** (this forces 2.4 GHz).
   - **Android:** Settings → Connections/Network → Hotspot → Hotspot settings → Band → **2.4 GHz**.
2. [ ] Write down the hotspot name and password.
3. [ ] On the laptop: in the folder `bench/hotspot_test/`, copy `arduino_secrets.example.h` and rename the copy to `arduino_secrets.h`.
4. [ ] Open `arduino_secrets.h` in Notepad. Replace `your-hotspot-name` and `your-hotspot-password` with yours. Keep the quote marks. Save. (This file is never committed to git.)
5. [ ] On the laptop: click the **Wi-Fi icon** (bottom-right of the taskbar) → pick your phone's hotspot → Connect.
6. [ ] Plug the UNO into the laptop with USB (no pads on).
7. [ ] Open the terminal. Start the little laptop server:
   ```
   node bench\ping_server.mjs
   ```
   It prints lines like `laptop ip 172.20.10.3 (Wi-Fi)`. Write down the IP on the **Wi-Fi** line (on an iPhone hotspot it usually starts with `172.20.10.`). **Leave this window open.**
8. [ ] Open `bench\hotspot_test\arduino_secrets.h` in Notepad again. Put that IP between the quotes on the `LAPTOP_IP` line, e.g. `#define LAPTOP_IP "172.20.10.3"`. Save.
9. [ ] Open a **second** terminal window (same steps as "How to open the terminal"). Upload the hotspot test:
   ```
   arduino-cli compile --upload -p COM8 --fqbn arduino:renesas_uno:unor4wifi bench\hotspot_test
   ```
10. [ ] Watch what the UNO says (in the same second window):
    ```
    arduino-cli monitor -p COM8 -c baudrate=115200
    ```
    Good output looks like `WIFI OK ip 172.20.10.4 ...` then `LAPTOP OK 40 ms`. The **first** window should print `ping from ...` every 2 seconds. Press **Ctrl+C** to stop watching. Copy the output into Claude if anything looks off.
11. [ ] Watch the LED grid:
   - `WIFI OK ...` or `LAPTOP OK` scrolling = **pass**.
   - `NO WIFI` = the hotspot is probably on 5 GHz, or the name/password has a typo. Redo steps 1 and 4.
   - `LAPTOP FAIL` = the UNO is on the hotspot but can't reach the laptop. Tell Claude; it's usually the laptop being on a different network.
12. [ ] Stop the laptop server: click the first window and press **Ctrl+C**.
13. [ ] Switch the laptop back to your normal Wi-Fi when done (if you want).

---

## Part 5: Pair the Bluetooth speaker

1. [ ] Turn the speaker on.
2. [ ] Put it in pairing mode: **hold the power button** (or the Bluetooth button) until the light flashes or it says "pairing". Check the speaker's manual if it doesn't.
3. [ ] On the laptop: press **Windows key**, type `Bluetooth`, open **Bluetooth & devices**.
4. [ ] Click **Add device** → **Bluetooth** → click the speaker's name when it shows up.
5. [ ] Wait for "Your device is ready to go". Click **Done**.
6. [ ] Click the **speaker icon** on the taskbar (bottom-right) → click the **>** arrow next to the volume slider → choose the Skullcandy speaker.
7. [ ] Open the terminal and play a test sound:
   ```
   (New-Object Media.SoundPlayer 'C:\Windows\Media\Windows Notify System Generic.wav').PlaySync()
   ```
8. [ ] You should hear the chime from the **speaker**, not the laptop. If it comes from the laptop, redo step 6.

---

## Part 6: Belt layout (no laptop)

1. [ ] Put the running belt on.
2. [ ] Put the UNO (with shield) + power bank in/on the **front** of the belt. **LED grid facing out**, so people can see the bars.
3. [ ] Run a cable from the belt, **under your shirt**, up to your upper arm. Velcro it at the upper arm. Coil spare cable at the belt.
4. [ ] Do 10 curls. Nothing should pull, unplug or flop around. Adjust and repeat.
5. [ ] Take a photo of the setup for reference tomorrow.

---

## Part 7: Accounts and keys (laptop only)

1. [ ] **API keys:** in the `lightweight` folder, create a file named `.env` (Notepad → Save As → File name `.env`, "Save as type: All files"). Put in:
   ```
   ELEVENLABS_API_KEY=your-key-here
   GEMINI_API_KEY=your-key-here
   ```
   Save. This file is never committed to git.
2. [ ] **ngrok (optional, cloudflared works without it):** open a new terminal and run `ngrok config add-authtoken <your-token>` with the token from dashboard.ngrok.com.
3. [ ] **Music:** copy the songs you want to play into a folder on the laptop (e.g. `C:\Users\Small\Music\lightweight`). MP3s are fine.

---

## Done? Put the light show back on (optional)

UNO plugged into the laptop, **no pads on**, then in the terminal:
```
arduino-cli compile --upload -p COM8 --fqbn arduino:renesas_uno:unor4wifi bench\lightshow
```

---

## Appendix: test code (already in `C:\Users\Small\lightweight\bench\`, already compiles)

Throwaway hardware test tools, not project code:
- `bench\sensor_bars\`: each sensor as a bar on the LED grid (Parts 2–3).
- `bench\hotspot_test\` + `bench\ping_server.mjs`: Wi-Fi and laptop reachability (Part 4).
- `bench\diag\`: Wi-Fi firmware, network scan, timing. Send any character over serial to run it.
- `bench\lightshow\`: scrolls LIGHTWEIGHT BABY, curl animation, Game of Life.

### `bench\sensor_bars\sensor_bars.ino`
```cpp
// Bench tool (not project code): shows each MyoWare channel as a bar on the LED matrix.
// Bars left to right: A0 R-biceps, A1 R-delt, A2 L-biceps, A3 L-delt.
// Works with no laptop (power bank only). Also prints raw values on Serial @115200.
// A bar pinned at full height while relaxed = gain too high or bad pad.
#include <Arduino_LED_Matrix.h>

ArduinoLEDMatrix matrix;
uint8_t frame[8][12];
const int FULL_SCALE = 12000;  // raw 14-bit reading that fills a bar (16383 = 5 V)

void setup() {
  Serial.begin(115200);
  analogReadResolution(14);
  matrix.begin();
}

void loop() {
  int v[4];
  for (int c = 0; c < 4; c++) v[c] = analogRead(A0 + c);
  memset(frame, 0, sizeof(frame));
  for (int c = 0; c < 4; c++) {
    int h = constrain(map(v[c], 0, FULL_SCALE, 0, 8), 0, 8);
    for (int y = 0; y < h; y++) { frame[7 - y][c * 3] = 1; frame[7 - y][c * 3 + 1] = 1; }
  }
  frame[0][11] = (millis() / 500) % 2;  // blinking corner dot = sketch is alive
  matrix.renderBitmap(frame, 8, 12);
  Serial.print(v[0]); Serial.print('\t'); Serial.print(v[1]); Serial.print('\t');
  Serial.print(v[2]); Serial.print('\t'); Serial.println(v[3]);
  delay(50);
}
```

### `bench\hotspot_test\arduino_secrets.example.h` (copy to `arduino_secrets.h`, gitignored)
```cpp
#define SECRET_SSID "your-hotspot-name"
#define SECRET_PASS "your-hotspot-password"
#define LAPTOP_IP ""      // laptop's IP on the hotspot; "" skips the laptop check
#define LAPTOP_PORT 3000
```

### `bench\hotspot_test\hotspot_test.ino`
```cpp
// Bench tool (not project code): can the UNO join the hotspot and reach the laptop?
// LED matrix: scrolls "WIFI OK <ip>" on success, "NO WIFI" on failure.
// If LAPTOP_IP is set, sends GET /ping to the laptop every 2 s and scrolls "LAPTOP OK".
#include "ArduinoGraphics.h"
#include "Arduino_LED_Matrix.h"
#include <WiFiS3.h>
#include "arduino_secrets.h"

ArduinoLEDMatrix matrix;
bool laptopOk = false;

void scroll(const String& text) {
  matrix.beginDraw();
  matrix.stroke(0xFFFFFFFF);
  matrix.textScrollSpeed(50);
  matrix.textFont(Font_5x7);
  matrix.beginText(0, 1, 0xFFFFFF);
  matrix.println("   " + text + "   ");
  matrix.endText(SCROLL_LEFT);
  matrix.endDraw();
}

void connectWifi() {
  Serial.print("joining "); Serial.println(SECRET_SSID);
  for (int attempt = 1; attempt <= 5 && WiFi.status() != WL_CONNECTED; attempt++) {
    WiFi.begin(SECRET_SSID, SECRET_PASS);
    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 8000) delay(200);
    Serial.print("attempt "); Serial.print(attempt); Serial.print(" status "); Serial.println(WiFi.status());
  }
}

void setup() {
  Serial.begin(115200);
  matrix.begin();
  delay(500);
  connectWifi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("NO WIFI");
    scroll("NO WIFI");
    connectWifi();
    return;
  }
  while (WiFi.localIP() == IPAddress(0, 0, 0, 0)) delay(100);  // wait for DHCP
  String ip = WiFi.localIP().toString();
  Serial.print("WIFI OK ip "); Serial.print(ip);
  Serial.print(" gateway "); Serial.print(WiFi.gatewayIP().toString());
  Serial.print(" rssi "); Serial.println(WiFi.RSSI());

  if (strlen(LAPTOP_IP) > 0) {
    WiFiClient client;
    unsigned long t = millis();
    laptopOk = false;
    if (client.connect(LAPTOP_IP, LAPTOP_PORT)) {
      client.print(String("GET /ping?ip=") + ip + "&rssi=" + WiFi.RSSI() + " HTTP/1.1\r\nHost: " +
                   LAPTOP_IP + "\r\nConnection: close\r\n\r\n");
      unsigned long start = millis();
      while (client.connected() && millis() - start < 2000) {
        if (client.available()) {
          String line = client.readStringUntil('\n');
          if (line.startsWith("HTTP/1.1 200")) laptopOk = true;
        }
      }
      client.stop();
    }
    Serial.print(laptopOk ? "LAPTOP OK " : "LAPTOP FAIL ");
    Serial.print(millis() - t); Serial.println(" ms");
    scroll(laptopOk ? "LAPTOP OK" : "LAPTOP FAIL");
  } else {
    scroll("WIFI OK " + ip);
  }
  delay(2000);
}
```

### `bench\ping_server.mjs`
```js
// Run: node bench\ping_server.mjs
import http from "node:http";
import os from "node:os";

const PORT = 3000;
for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
  for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) console.log(`laptop ip ${a.address}  (${name})`);
}
http.createServer((req, res) => {
  console.log(`${new Date().toLocaleTimeString()} ping from ${req.socket.remoteAddress} ${req.url}`);
  res.writeHead(200, { "Content-Type": "text/plain" }).end("pong\n");
}).listen(PORT, "0.0.0.0", () => console.log(`listening on :${PORT}, waiting for the UNO...`));
```
