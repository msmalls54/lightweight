// Server-sent events to the dashboard(s). One JSON object per `data:` line.
const enc = new TextEncoder();

export class Hub {
  private clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private ping = setInterval(() => this.write(": ping\n\n"), 15_000);

  constructor() { this.ping.unref?.(); }

  get size() { return this.clients.size; }

  send(event: object) { if (this.clients.size) this.write(`data: ${JSON.stringify(event)}\n\n`); }

  private write(text: string) {
    const bytes = enc.encode(text);
    for (const c of this.clients) {
      try { c.enqueue(bytes); } catch { this.clients.delete(c); }
    }
  }

  /** A Response that stays open; `hello` events go to this client only. */
  connect(signal: AbortSignal, hello: object[]): Response {
    let ctl: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start: c => {
        ctl = c;
        this.clients.add(c);
        c.enqueue(enc.encode("retry: 1000\n\n"));
        for (const e of hello) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      },
      cancel: () => { this.clients.delete(ctl); },
    });
    signal.addEventListener("abort", () => { this.clients.delete(ctl); try { ctl.close(); } catch { /* already closed */ } });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
    });
  }
}
