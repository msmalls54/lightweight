// Throwaway diagnostics: Wi-Fi module info + scan, ADC and LED matrix timing, 200 Hz loop jitter.
#include <WiFiS3.h>
#include <Arduino_LED_Matrix.h>
ArduinoLEDMatrix matrix;
uint8_t frame[8][12];

void report() {
  Serial.println("=== DIAG BEGIN");
  Serial.print("wifi_fw "); Serial.println(WiFi.firmwareVersion());
  Serial.print("wifi_fw_latest "); Serial.println(WIFI_FIRMWARE_LATEST_VERSION);
  byte mac[6]; WiFi.macAddress(mac);
  Serial.print("mac ");
  for (int i = 5; i >= 0; i--) { if (mac[i] < 16) Serial.print('0'); Serial.print(mac[i], HEX); if (i) Serial.print(':'); }
  Serial.println();

  int n = WiFi.scanNetworks();
  Serial.print("networks "); Serial.println(n);
  for (int i = 0; i < n; i++) {
    Serial.print("net\t"); Serial.print(WiFi.RSSI(i)); Serial.print("\tch");
    Serial.print(WiFi.channel(i)); Serial.print("\tenc"); Serial.print(WiFi.encryptionType(i));
    Serial.print('\t'); Serial.println(WiFi.SSID(i));
  }

  analogReadResolution(14);
  unsigned long t = micros();
  volatile int s = 0;
  for (int k = 0; k < 1000; k++) for (int c = 0; c < 4; c++) s += analogRead(A0 + c);
  Serial.print("adc_4ch_us "); Serial.println((micros() - t) / 1000.0);

  matrix.begin();
  t = micros();
  for (int k = 0; k < 100; k++) { frame[k % 8][k % 12] ^= 1; matrix.renderBitmap(frame, 8, 12); }
  Serial.print("matrix_render_us "); Serial.println((micros() - t) / 100.0);

  // 200 Hz fixed-timer loop: sample 4ch, render matrix every 10th tick, measure lateness.
  const unsigned long period = 5000;
  unsigned long next = micros() + period, worst = 0, sumLate = 0, missed = 0;
  for (int tick = 0; tick < 1000; tick++) {
    while ((long)(micros() - next) < 0) {}
    unsigned long late = micros() - next;
    if (late > worst) worst = late;
    sumLate += late;
    if (late > period) missed++;
    for (int c = 0; c < 4; c++) s += analogRead(A0 + c);
    if (tick % 10 == 0) matrix.renderBitmap(frame, 8, 12);
    next += period;
  }
  Serial.print("loop200_avg_late_us "); Serial.println(sumLate / 1000.0);
  Serial.print("loop200_worst_late_us "); Serial.println(worst);
  Serial.print("loop200_missed "); Serial.println(missed);
  Serial.println("=== DIAG END");
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  // Wait for the host to send any byte, then run once.
  if (Serial.available()) { while (Serial.available()) Serial.read(); report(); }
  digitalWrite(LED_BUILTIN, (millis() / 500) % 2);
}
