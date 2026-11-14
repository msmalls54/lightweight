// Bench tool (not project code): can the UNO join the hotspot and reach the laptop?
// Needs arduino_secrets.h next to this file (copy arduino_secrets.example.h).
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
  // Wait for DHCP to hand out an address.
  while (WiFi.localIP() == IPAddress(0, 0, 0, 0)) delay(100);
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
