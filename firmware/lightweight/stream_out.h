// Output sink for HTTP requests. dry = only count bytes (to compute Content-Length);
// otherwise buffer into buf and stream it to the client in cap-sized writes (one AT send each).
// Lives in a header because Arduino's auto-prototypes would otherwise precede the struct.
#pragma once
#include <WiFiS3.h>

struct Out {
  WiFiClient *cl;
  char *buf;
  size_t cap;
  bool dry;
  bool ok;
  size_t total;
  size_t len;

  void flush() {
    if (!dry && ok && len && cl->write((const uint8_t *)buf, len) != len) ok = false;
    len = 0;
  }
  void put(const char *s, size_t n) {
    total += n;
    if (dry) return;
    while (n) {
      size_t m = n < cap - len ? n : cap - len;
      memcpy(buf + len, s, m);
      len += m; s += m; n -= m;
      if (len == cap) flush();
    }
  }
  void str(const char *s) { put(s, strlen(s)); }
  void ch(char c) { put(&c, 1); }
  void u(uint32_t v) {
    char tmp[10]; int i = 0;
    do { tmp[i++] = '0' + (v % 10); v /= 10; } while (v);
    char out[10]; int j = 0;
    while (i) out[j++] = tmp[--i];
    put(out, j);
  }
  void i(int32_t v) { if (v < 0) { ch('-'); v = -v; } u((uint32_t)v); }
};

// Body generator: emit(out, a, k). Same function runs twice (dry count, then real send).
typedef void (*EmitFn)(Out &, uint32_t, uint8_t);
