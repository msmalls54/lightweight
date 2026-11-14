import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Get GEMINI_API_KEY, loading the nearest `.env` walking up from cwd and from this file
 * (so it also works from a git worktree under `.claude/worktrees/`). Never log the value.
 */
export function loadGeminiKey(): string | undefined {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
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
        if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
      }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return undefined;
}
