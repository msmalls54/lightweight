// Throwaway light show for the UNO R4 WiFi LED matrix (12x8).
// 1) Scrolls "LIGHTWEIGHT BABY"  2) A little arm curls a dumbbell, reps counted
// 3) Conway's Game of Life seeded from the floating analog pins' noise. Repeat.
#include "ArduinoGraphics.h"
#include "Arduino_LED_Matrix.h"

ArduinoLEDMatrix matrix;
const int W = 12, H = 8;
uint8_t frame[H][W];

void show() { matrix.renderBitmap(frame, H, W); }
void clearFrame() { memset(frame, 0, sizeof(frame)); }
void px(int x, int y) { if (x >= 0 && x < W && y >= 0 && y < H) frame[y][x] = 1; }

void line(int x0, int y0, int x1, int y1) {
  int dx = abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  int dy = -abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  int err = dx + dy;
  while (true) {
    px(x0, y0);
    if (x0 == x1 && y0 == y1) break;
    int e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

void scrollText(const char* text, int speed) {
  matrix.beginDraw();
  matrix.stroke(0xFFFFFFFF);
  matrix.textScrollSpeed(speed);
  matrix.textFont(Font_5x7);
  matrix.beginText(0, 1, 0xFFFFFF);
  matrix.println(text);
  matrix.endText(SCROLL_LEFT);
  matrix.endDraw();
}

// Upper arm hangs from the shoulder at the top-left; elbow at (2,6).
// Forearm swings from horizontal (0 deg) up toward the shoulder (75 deg).
void drawArm(float deg, int reps) {
  clearFrame();
  const float ex = 2, ey = 6, len = 6;
  line(2, 0, 2, 6);                                  // upper arm
  float r = deg * PI / 180.0;
  int hx = round(ex + len * cos(r)), hy = round(ey - len * sin(r));
  line(ex, ey, hx, hy);                              // forearm
  float pr = r + PI / 2;                             // dumbbell across the hand
  line(round(hx - 1.5 * cos(pr)), round(hy + 1.5 * sin(pr)),
       round(hx + 1.5 * cos(pr)), round(hy - 1.5 * sin(pr)));
  for (int i = 0; i < reps && i < 5; i++) px(11, 7 - i); // rep tally, right edge
  show();
}

void curlSet(int reps) {
  for (int rep = 0; rep < reps; rep++) {
    bool cheat = (rep == reps - 1);                  // last rep: swing it up fast
    int upDelay = cheat ? 8 : 28;
    for (int a = 0; a <= 75; a += 5) { drawArm(a, rep); delay(upDelay); }
    delay(cheat ? 50 : 250);
    for (int a = 75; a >= 0; a -= 5) { drawArm(a, rep + 1); delay(30); }
    if (cheat) {                                     // busted: flash the board
      for (int i = 0; i < 3; i++) {
        memset(frame, 1, sizeof(frame)); show(); delay(90);
        clearFrame(); show(); delay(90);
      }
      Serial.println("cheat rep detected (just kidding, no sensors yet)");
    }
    delay(200);
  }
}

void lifeRun(int maxGens) {
  // Seed from the noise on the unconnected analog inputs.
  randomSeed(analogRead(A0) ^ (analogRead(A1) << 4) ^ (analogRead(A2) << 8) ^ micros());
  for (int y = 0; y < H; y++)
    for (int x = 0; x < W; x++) frame[y][x] = random(100) < 38;
  uint8_t prev[H][W], prev2[H][W], next[H][W];
  memset(prev, 0, sizeof(prev)); memset(prev2, 0, sizeof(prev2));
  for (int g = 0; g < maxGens; g++) {
    show();
    delay(120);
    for (int y = 0; y < H; y++)
      for (int x = 0; x < W; x++) {
        int n = 0;
        for (int dy = -1; dy <= 1; dy++)
          for (int dx = -1; dx <= 1; dx++)
            if (dx || dy) n += frame[(y + dy + H) % H][(x + dx + W) % W];
        next[y][x] = frame[y][x] ? (n == 2 || n == 3) : (n == 3);
      }
    bool dead = true;
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) if (next[y][x]) dead = false;
    bool stuck = !memcmp(next, frame, sizeof(next)) || !memcmp(next, prev, sizeof(next));
    memcpy(prev2, prev, sizeof(prev)); memcpy(prev, frame, sizeof(frame));
    memcpy(frame, next, sizeof(next));
    if (dead || stuck) {
      Serial.print("life settled after "); Serial.print(g + 1); Serial.println(" generations");
      show(); delay(600);
      return;
    }
  }
  Serial.println("life ran the full time");
}

void setup() {
  Serial.begin(115200);
  matrix.begin();
  delay(300);
  Serial.println("LIGHTSHOW start");
}

void loop() {
  Serial.println("scroll");
  scrollText("    LIGHTWEIGHT BABY!    ", 60);
  Serial.println("curls");
  curlSet(5);
  delay(400);
  Serial.println("scroll");
  scrollText("    LIGHTWEIGHT BABY!    ", 60);
  Serial.println("life");
  lifeRun(80);
  lifeRun(80);
}
