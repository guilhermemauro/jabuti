// Shell commands run here and nowhere else (C3): one Docker container per agent,
// with only that agent's workspace mounted. Every conversation of the agent, and
// every subagent it delegates to, works in the same files.
import { spawn } from "node:child_process";
import { truncate } from "./output.ts";

export interface ExecResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

export interface Sandbox {
  /** `workspace` is the name of the agent that owns the workspace. */
  exec(workspace: string, command: string, options: ExecOptions): Promise<ExecResult>;
  /**
   * Installs Debian packages as root, by name only (C17). Validated names, never a
   * command. Deployed, every agent gets them; locally, only this agent's container.
   */
  install(workspace: string, packages: string[], signal: AbortSignal): Promise<ExecResult>;
  /**
   * Writes a file into the workspace as the agent's own user, so it can read and change
   * it, and so a link the agent planted reaches nothing the agent could not (C5).
   * `path` is relative to the workspace and matches FILE_PATH. Throws on failure.
   */
  writeFile(
    workspace: string,
    path: string,
    content: string | Buffer,
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * Reads a file of the workspace as the agent's own user, up to READ_CAP bytes:
   * what view_images shows the model (C21). Throws when missing or too large.
   */
  readFile(workspace: string, path: string, signal: AbortSignal): Promise<Buffer>;
  /**
   * Publishing with the agent's deploy key (C19), which only the runner holds: no
   * agent can read it. Never throws for a git failure: it comes back as ok false.
   */
  git(workspace: string, request: GitRequest, signal: AbortSignal): Promise<GitResult>;
}

/** One publishing step; the runner turns it into fixed git calls, never a command. */
export interface GitRequest {
  action: "key" | "test" | "push" | "merge" | "delete" | "sync";
  /** GitHub owner/name. */
  repo?: string;
  base?: string;
  branch?: string;
  /** The clone's folder in the workspace. */
  source?: string;
  /** The squashed commit's message, for merge. */
  message?: string;
}

export interface GitResult {
  ok: boolean;
  output: string;
  publicKey?: string;
  fingerprint?: string;
}

/**
 * Relative paths of plain names: each part starts with a letter, digit or "_", so no
 * "..", no leading "/" or "-", and no spaces.
 */
export const FILE_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
/** The media type of a workspace image by its extension; undefined for anything else. */
export function imageType(path: string): string | undefined {
  return IMAGE_TYPES[/\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? ""];
}
/** The largest file a connector or the owner may hand an agent, and readFile return. */
export const FILE_CAP = 20 * 1024 * 1024;
const READ_CAP = FILE_CAP;

/** The script that writes stdin to "$1", creating its folder. Run as the agent. */
const WRITE_SCRIPT = 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"';
/** Refuses a file over the cap ($2 bytes), else prints it as base64. */
const READ_SCRIPT =
  '[ -f "$1" ] || { echo "No file $1" >&2; exit 1; }; ' +
  '[ "$(wc -c < "$1")" -le "$2" ] || { echo "$1 is over $2 bytes" >&2; exit 1; }; base64 "$1"';

/** Debian package names; never starts with "-", so never read as an apt option. */
export const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{1,62}$/;

export interface ExecOptions {
  timeoutSeconds: number;
  signal: AbortSignal;
  /** The agent's variables marked for its shell (C16); nothing else is passed. */
  env: Record<string, string>;
}

// The docker CLI itself needs these to find the daemon. Nothing else from the
// server's environment is passed, so secrets cannot reach the CLI or the container.
const CLI_ENV_KEYS = ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"];

export class DockerSandbox implements Sandbox {
  private readonly image: string;
  private readonly hostDir: (workspace: string) => string;
  private readonly ready = new Map<string, Promise<string>>();

  /** `hostDir` returns, and creates, the host directory to mount for a workspace. */
  constructor(image: string, hostDir: (workspace: string) => string) {
    this.image = image;
    this.hostDir = hostDir;
  }

  async exec(workspace: string, command: string, options: ExecOptions): Promise<ExecResult> {
    const container = await this.ensure(workspace);
    // `-e NAME` without a value: docker reads it from the CLI's environment, so
    // values never show in the host's process list.
    const names = Object.keys(options.env).flatMap((name) => ["-e", name]);
    // `timeout` runs inside the container so the process dies there too; killing
    // the docker CLI alone would leave it running. Accepted edge case: on cancel we
    // kill the CLI, and the command keeps running in the container until its timeout.
    const result = await docker(
      [
        "exec",
        ...names,
        container,
        "timeout",
        "-s",
        "KILL",
        String(options.timeoutSeconds),
        "sh",
        "-c",
        command,
      ],
      options.signal,
      options.env,
    );
    const timedOut = result.exitCode === 137 || result.exitCode === 124;
    return { ...result, output: truncate(result.output), timedOut };
  }

  async install(workspace: string, packages: string[], signal: AbortSignal) {
    if (!packages.every((p) => PACKAGE_NAME.test(p))) throw new Error("Invalid package name.");
    const container = await this.ensure(workspace);
    // Names arrive as arguments ("$@"), never as part of the script.
    const script =
      "export DEBIAN_FRONTEND=noninteractive; apt-get update -q && " +
      'apt-get install -y -q --no-install-recommends -- "$@"';
    const result = await docker(
      ["exec", "-u", "root", container, "sh", "-c", script, "install", ...packages],
      signal,
      {},
    );
    return { ...result, output: truncate(result.output), timedOut: false };
  }

  /** Only the runner holds deploy keys: one container per agent has nowhere safe for one. */
  git(): Promise<GitResult> {
    return Promise.resolve({
      ok: false,
      output:
        "Publishing with a deploy key needs the shell runner: run Jabuti with docker compose.",
    });
  }

  async writeFile(workspace: string, path: string, content: string | Buffer, signal: AbortSignal) {
    if (!FILE_PATH.test(path)) throw new Error(`Invalid file path: ${path}`);
    const container = await this.ensure(workspace);
    const result = await docker(
      ["exec", "-i", container, "sh", "-c", WRITE_SCRIPT, "write", path],
      signal,
      {},
      content,
    );
    if (result.exitCode !== 0) throw new Error(result.output.trim() || "the write failed");
  }

  async readFile(workspace: string, path: string, signal: AbortSignal): Promise<Buffer> {
    if (!FILE_PATH.test(path)) throw new Error(`Invalid file path: ${path}`);
    const container = await this.ensure(workspace);
    // base64 on the way out: the CLI's output is read as text.
    const result = await docker(
      ["exec", container, "sh", "-c", READ_SCRIPT, "read", path, String(READ_CAP)],
      signal,
    );
    if (result.exitCode !== 0) throw new Error(result.output.trim() || "the read failed");
    return Buffer.from(result.output.replace(/\s+/g, ""), "base64");
  }

  /** Removes the containers this process started. Workspaces stay on disk. */
  async dispose() {
    const names = await Promise.allSettled(this.ready.values());
    this.ready.clear();
    for (const name of names) {
      if (name.status === "fulfilled") await docker(["rm", "-f", name.value]);
    }
  }

  private ensure(workspace: string): Promise<string> {
    let ready = this.ready.get(workspace);
    if (!ready) {
      ready = this.start(workspace);
      ready.catch(() => this.ready.delete(workspace));
      this.ready.set(workspace, ready);
    }
    return ready;
  }

  private async start(workspace: string): Promise<string> {
    // Agent names are validated as [a-z0-9-] by the registry, so valid container names.
    const name = `jabuti-agent-${workspace}`;
    const dir = this.hostDir(workspace);
    // Reuse the container across server restarts; start it if it was stopped.
    const inspect = await docker(["inspect", "-f", "{{.State.Running}}", name]);
    if (inspect.exitCode === 0) {
      if (inspect.output.trim() !== "true") await mustDocker(["start", name]);
      return name;
    }
    await mustDocker([
      "run",
      "--detach",
      "--name",
      name,
      "--label",
      "jabuti=sandbox",
      "--volume",
      `${dir}:/workspace`,
      "--workdir",
      "/workspace",
      "--memory",
      "1g",
      "--cpus",
      "1",
      this.image,
      "sleep",
      "infinity",
    ]);
    return name;
  }
}

async function mustDocker(args: string[]) {
  const result = await docker(args);
  if (result.missing) {
    throw new Error(
      "Docker is not installed here. Run Jabuti with Docker available, or in a container " +
        "next to the shell runner (docker compose up).",
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(`docker ${args[0] ?? ""} failed: ${result.output.trim()}`);
  }
}

function docker(
  args: string[],
  signal?: AbortSignal,
  variables: Record<string, string> = {},
  input?: string | Buffer,
): Promise<Omit<ExecResult, "timedOut"> & { missing?: boolean }> {
  const env = {
    ...variables,
    // Last, so a variable can never redirect the CLI (also refused when saved).
    ...Object.fromEntries(
      CLI_ENV_KEYS.flatMap((k) => {
        const v = process.env[k];
        return v === undefined ? [] : [[k, v]];
      }),
    ),
  };
  return new Promise((resolve) => {
    const child = spawn("docker", args, { env, signal });
    if (input !== undefined) {
      // A closed pipe (the command failed early) shows as its exit code, not as this.
      child.stdin.on("error", () => undefined);
      child.stdin.end(input);
    }
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", (error: NodeJS.ErrnoException) => {
      resolve({
        exitCode: -1,
        output: `${output}\n${error.message}`,
        missing: error.code === "ENOENT",
      });
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, output });
    });
  });
}
