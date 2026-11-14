// Server-sent events to the dashboard(s). One JSON object per `data:` line.
// Exactly one non-muted dashboard is the "speaker" (plays voice); the others show text only.
const enc = new TextEncoder();

interface Client { id: string; ctl: ReadableStreamDefaultController<Uint8Array>; mute: boolean; at: number; visible: boolean; hiddenSince: number | null }
/** A speaker tab hidden this long hands the voice to a visible tab. */
const HIDDEN_RELEASE_MS = 30_000;

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

  /**
   * Keep the current speaker unless it's gone, muted, or hidden for 30 s while a visible tab exists.
   * Otherwise prefer the newest visible non-muted tab, then the oldest non-muted one.
   */
  private elect() {
    const cur = this.speakerId ? this.clients.get(this.speakerId) : undefined;
    const live = [...this.clients.values()].filter(c => !c.mute);
    const visible = live.filter(c => c.visible).sort((a, b) => b.at - a.at);
    const stale = !!cur && !cur.visible && cur.hiddenSince !== null && Date.now() - cur.hiddenSince >= HIDDEN_RELEASE_MS && visible.length > 0;
    if (!cur || cur.mute || stale) {
      const next = visible[0] ?? live.sort((a, b) => a.at - b.at)[0];
      this.speakerId = next?.id ?? null;
    }
    for (const c of this.clients.values()) this.sendTo(c, { type: "speaker", you: c.id === this.speakerId, has_speaker: this.speakerId !== null });
  }

  /** A tab reports document.visibilityState. A visible tab takes the voice from a hidden speaker. */
  setVisible(id: string, visible: boolean): boolean {
    const c = this.clients.get(id);
    if (!c) return false;
    c.visible = visible;
    c.hiddenSince = visible ? null : (c.hiddenSince ?? Date.now());
    const cur = this.speakerId ? this.clients.get(this.speakerId) : undefined;
    if (visible && !c.mute && (!cur || !cur.visible)) { this.speakerId = id; this.elect(); return true; }
    if (!visible && this.speakerId === id) {
      const t = setTimeout(() => { if (this.speakerId === id && !this.clients.get(id)?.visible) this.elect(); }, HIDDEN_RELEASE_MS + 100);
      t.unref?.();
    }
    this.elect();
    return true;
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
  connect(signal: AbortSignal, hello: object[], opts: { mute?: boolean; visible?: boolean } = {}): Response {
    const id = `c${++this.seq}`;
    const stream = new ReadableStream<Uint8Array>({
      start: ctl => {
        const visible = opts.visible !== false;
        const client: Client = { id, ctl, mute: !!opts.mute, at: Date.now(), visible, hiddenSince: visible ? null : Date.now() };
        this.clients.set(id, client);
        // A new visible tab takes the voice from a speaker tab that's in the background.
        const cur = this.speakerId ? this.clients.get(this.speakerId) : undefined;
        if (!client.mute && visible && cur && !cur.visible) this.speakerId = id;
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
