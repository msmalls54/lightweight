// Server-sent events to the dashboard(s). One JSON object per `data:` line.
// Exactly one non-muted dashboard is the "speaker" (plays voice); the others show text only.
const enc = new TextEncoder();

interface Client { id: string; ctl: ReadableStreamDefaultController<Uint8Array>; mute: boolean; at: number }

export class Hub {
  private clients = new Map<string, Client>();
  private speakerId: string | null = null;
  private seq = 0;
  private ping = setInterval(() => this.write(": ping\n\n"), 15_000);

  constructor() { this.ping.unref?.(); }

  get size() { return this.clients.size; }
  get speaker() { return this.speakerId; }

  send(event: object) { if (this.clients.size) this.write(`data: ${JSON.stringify(event)}\n\n`); }

  private write(text: string) {
    const bytes = enc.encode(text);
    for (const c of this.clients.values()) {
      try { c.ctl.enqueue(bytes); } catch { this.remove(c.id); }
    }
  }
  private sendTo(c: Client, event: object) {
    try { c.ctl.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch { this.remove(c.id); }
  }

  private remove(id: string) {
    if (!this.clients.delete(id)) return;
    if (this.speakerId === id) this.elect();
  }

  /** Keep the current speaker if still connected, else the oldest non-muted dashboard. */
  private elect() {
    const cur = this.speakerId ? this.clients.get(this.speakerId) : undefined;
    if (!cur || cur.mute) {
      const next = [...this.clients.values()].filter(c => !c.mute).sort((a, b) => a.at - b.at)[0];
      this.speakerId = next?.id ?? null;
    }
    for (const c of this.clients.values()) this.sendTo(c, { type: "speaker", you: c.id === this.speakerId, has_speaker: this.speakerId !== null });
  }

  /** A dashboard asks to be the speaker (click on the speaker pill). */
  claim(id: string): boolean {
    const c = this.clients.get(id);
    if (!c || c.mute) return false;
    this.speakerId = id;
    this.elect();
    return true;
  }

  /** A Response that stays open; `hello` events go to this client only. */
  connect(signal: AbortSignal, hello: object[], opts: { mute?: boolean } = {}): Response {
    const id = `c${++this.seq}`;
    const stream = new ReadableStream<Uint8Array>({
      start: ctl => {
        const client: Client = { id, ctl, mute: !!opts.mute, at: Date.now() };
        this.clients.set(id, client);
        ctl.enqueue(enc.encode("retry: 1000\n\n"));
        this.sendTo(client, { type: "hello", client_id: id, mute: client.mute });
        for (const e of hello) this.sendTo(client, e);
        this.elect();
      },
      cancel: () => { this.remove(id); },
    });
    signal.addEventListener("abort", () => {
      const c = this.clients.get(id);
      this.remove(id);
      try { c?.ctl.close(); } catch { /* already closed */ }
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
    });
  }
}
