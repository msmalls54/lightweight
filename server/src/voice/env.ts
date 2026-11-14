import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Get GEMINI_API_KEY, loading the nearest `.env` walking up from cwd and from this file
 * (so it also works from a git worktree under `.claude/worktrees/`). Never log the value.
 */
export function loadGeminiKey(): string | undefined {
  return loadEnvKey("GEMINI_API_KEY");
}

/** ELEVENLABS_API_KEY (repo-root .env). Never log the value. */
export function loadElevenKey(): string | undefined {
  return loadEnvKey("ELEVENLABS_API_KEY");
}

/** Any key from the environment or the nearest .env walking up (same search as loadGeminiKey). */
export function loadEnvKey(name: string): string | undefined {
  if (process.env[name]) return process.env[name];
  const starts = [process.cwd(), path.dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    let dir = path.resolve(start);
    for (;;) {
      const f = path.join(dir, ".env");
      if (fs.existsSync(f)) {
        try {
          process.loadEnvFile(f);
        } catch {
          /* unreadable .env: keep looking */
        }
        if (process.env[name]) return process.env[name];
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return undefined;
}
