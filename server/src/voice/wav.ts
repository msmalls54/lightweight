import { TTS_SAMPLE_RATE } from "./models.js";

/** Wrap raw little-endian PCM in a 44-byte RIFF/WAVE header. */
export function pcmToWav(pcm: Buffer, sampleRate = TTS_SAMPLE_RATE, channels = 1, bitsPerSample = 16): Buffer {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export function isWav(buf: Buffer): boolean {
  return buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WAVE";
}

/** TTS may return a full WAV or headerless PCM (`audio/l16; rate=24000`). Always hand back a WAV. */
export function ensureWav(buf: Buffer, mimeType?: string): Buffer {
  if (isWav(buf)) return buf;
  const rate = Number(/rate=(\d+)/i.exec(mimeType ?? "")?.[1]) || TTS_SAMPLE_RATE;
  const channels = Number(/channels=(\d+)/i.exec(mimeType ?? "")?.[1]) || 1;
  return pcmToWav(buf, rate, channels, 16);
}

/**
 * Cut the leading/trailing near-silence Gemini TTS pads every line with (~300 ms each side),
 * keeping a little padding so consonants aren't clipped. Mono/stereo 16-bit PCM WAV only;
 * anything else is returned unchanged.
 */
export function trimSilence(wav: Buffer, opts: { threshold?: number; leadMs?: number; tailMs?: number } = {}): Buffer {
  if (!isWav(wav) || wav.length <= 44 || wav.readUInt16LE(34) !== 16 || wav.toString("ascii", 36, 40) !== "data")
    return wav;
  const th = opts.threshold ?? 500;
  const rate = wav.readUInt32LE(24);
  const channels = wav.readUInt16LE(22);
  const frame = 2 * channels;
  const frames = Math.floor((wav.length - 44) / frame);
  const loud = (i: number) => {
    for (let c = 0; c < channels; c++) if (Math.abs(wav.readInt16LE(44 + i * frame + c * 2)) >= th) return true;
    return false;
  };
  let s = 0;
  while (s < frames && !loud(s)) s++;
  if (s >= frames) return wav; // all silence: leave it
  let e = frames - 1;
  while (e > s && !loud(e)) e--;
  s = Math.max(0, s - Math.round(((opts.leadMs ?? 30) * rate) / 1000));
  e = Math.min(frames - 1, e + Math.round(((opts.tailMs ?? 100) * rate) / 1000));
  return pcmToWav(wav.subarray(44 + s * frame, 44 + (e + 1) * frame), rate, channels, 16);
}

/** Duration of a 16-bit PCM WAV in ms (header-based). */
export function wavDurationMs(wav: Buffer): number {
  if (!isWav(wav) || wav.length < 44) return 0;
  const byteRate = wav.readUInt32LE(28);
  return byteRate ? Math.round(((wav.length - 44) / byteRate) * 1000) : 0;
}
