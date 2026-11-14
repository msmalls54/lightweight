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
