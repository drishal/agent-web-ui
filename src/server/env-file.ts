// Optional settings file: `<app root>/.env`, or AWUI_ENV_FILE (empty disables
// it). Variables already set in the environment win, as with dotenv.
import { chmodSync, readFileSync, statSync } from "node:fs";
import { parseEnv } from "node:util";

export interface LoadedEnvFile {
  file: string;
  /** Keys taken from the file; ones already set in the environment are skipped. */
  applied: string[];
  /** The file holds a password and was readable by others; it is now 0600. */
  tightened: boolean;
}

/** Merges `file` into `env`. Returns null when the file does not exist. */
export function loadEnvFile(file: string, env: NodeJS.ProcessEnv = process.env): LoadedEnvFile | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = parseEnv(text) as Record<string, string>;
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    applied.push(key);
  }
  let tightened = false;
  if (parsed.AUTH_PASSWORD && (statSync(file).mode & 0o077) !== 0) {
    chmodSync(file, 0o600);
    tightened = true;
  }
  return { file, applied, tightened };
}
