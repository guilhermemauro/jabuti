// The only module that reads the environment. Secrets stay in this process:
// they are handed to provider clients and never reach the model or the sandbox.
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface Config {
  host: string;
  port: number;
  /** The built UI (pnpm build), served by this server; undefined in development. */
  uiDir: string | undefined;
  dataDir: string;
  /** Agent profiles, brief, memory and (locally) workspaces: data/agents/<name>/. */
  agentsDir: string;
  /** Starting points for new agents: the repository's agents/ folder. */
  templatesDir: string;
  /** Skills (C4): built in (the repository's skills/), and the owner's (data/skills/). */
  skillsDirs: { builtIn: string; owner: string };
  /** Encrypts stored secrets. Unset: a key is generated in dataDir, with a warning. */
  secretKey: { value: string } | { file: string } | undefined;
  sandboxImage: string;
  /** Set in a container: commands go to the shell runner instead of local Docker. */
  runner: { url: string; tokenFile: string } | undefined;
  /** Colored log lines; off when NO_COLOR is set (https://no-color.org). */
  color: boolean;
  /** API key per provider id. A provider without a key is listed as unavailable. */
  providerKeys: Partial<Record<string, string>>;
}

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const keys: Partial<Record<string, string>> = {};
  const anthropic = env["ANTHROPIC_API_KEY"];
  if (anthropic) keys["anthropic"] = anthropic;
  const uiDir = resolve(REPO_ROOT, "packages/ui/dist");
  return {
    // Loopback by default; a container sets 0.0.0.0 to publish the port.
    host: env["JABUTI_HOST"] ?? "127.0.0.1",
    // In development the UI's Vite proxy points at 4317 (packages/ui/vite.config.ts).
    port: Number(env["JABUTI_PORT"] ?? 4317),
    uiDir: existsSync(resolve(uiDir, "index.html")) ? uiDir : undefined,
    // Overridable so tests and smoke runs never touch the real data/.
    dataDir: resolve(env["JABUTI_DATA_DIR"] ?? resolve(REPO_ROOT, "data")),
    agentsDir: resolve(env["JABUTI_DATA_DIR"] ?? resolve(REPO_ROOT, "data"), "agents"),
    templatesDir: resolve(REPO_ROOT, "agents"),
    skillsDirs: {
      builtIn: resolve(REPO_ROOT, "skills"),
      owner: resolve(env["JABUTI_DATA_DIR"] ?? resolve(REPO_ROOT, "data"), "skills"),
    },
    secretKey: env["JABUTI_SECRET_KEY"]
      ? { value: env["JABUTI_SECRET_KEY"] }
      : env["JABUTI_SECRET_KEY_FILE"]
        ? { file: env["JABUTI_SECRET_KEY_FILE"] }
        : undefined,
    sandboxImage: "python:3.13-slim",
    runner: env["JABUTI_RUNNER_URL"]
      ? {
          url: env["JABUTI_RUNNER_URL"],
          tokenFile: env["JABUTI_RUNNER_TOKEN_FILE"] ?? "/run/jabuti-runner/token",
        }
      : undefined,
    color: env["NO_COLOR"] === undefined,
    providerKeys: keys,
  };
}
