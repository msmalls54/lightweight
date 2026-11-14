import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// `npm run dev` runs from server/. Fall back to this file's location if started elsewhere.
const fromCwd = resolve(process.cwd());
const fromFile = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SERVER_DIR = existsSync(resolve(fromCwd, "public", "index.html")) ? fromCwd : fromFile;
export const REPO_ROOT = resolve(SERVER_DIR, "..");
export const PUBLIC_DIR = resolve(SERVER_DIR, "public");
export const DB_PATH = process.env.LW_DB_PATH ?? resolve(REPO_ROOT, "data", "lightweight.sqlite");
export const VOICE_CACHE_DIR = resolve(SERVER_DIR, ".cache", "voice");
