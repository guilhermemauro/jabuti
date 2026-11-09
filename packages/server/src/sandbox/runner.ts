// The sandbox when Jabuti runs in a container: commands go to the shell runner
// (packages/runner) over the compose network. The runner writes its token to a
// file only this server can read; it is read on each call because the runner may
// restart and write a new one.
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ExecOptions, ExecResult, GitRequest, GitResult, Sandbox } from "./docker.ts";
import { truncate } from "./output.ts";

const Result = z.object({ exitCode: z.number(), output: z.string(), timedOut: z.boolean() });
const Read = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
const Git = z.object({
  ok: z.boolean(),
  output: z.string(),
  publicKey: z.string().optional(),
  fingerprint: z.string().optional(),
});

export class RunnerSandbox implements Sandbox {
  private readonly url: string;
  private readonly tokenFile: string;

  constructor(url: string, tokenFile: string) {
    this.url = url;
    this.tokenFile = tokenFile;
  }

  async exec(workspace: string, command: string, options: ExecOptions): Promise<ExecResult> {
    return this.call(
      "/exec",
      { workspace, command, timeoutSeconds: options.timeoutSeconds, env: options.env },
      options.signal,
    );
  }

  /** Stop does not interrupt apt in the runner: a half-run dpkg is worse than a finished one. */
  async install(_workspace: string, packages: string[], signal: AbortSignal) {
    return this.call("/install", { packages }, signal);
  }

  async writeFile(workspace: string, path: string, content: string | Buffer, signal: AbortSignal) {
    const payload =
      typeof content === "string"
        ? { workspace, path, content }
        : { workspace, path, content: content.toString("base64"), encoding: "base64" };
    const result = await this.call("/write", payload, signal);
    if (result.exitCode !== 0) throw new Error(result.output.trim() || "the write failed");
  }

  async readFile(workspace: string, path: string, signal: AbortSignal): Promise<Buffer> {
    const result = Read.parse(await this.post("/read", { workspace, path }, signal));
    if (!result.ok) throw new Error(result.error);
    return Buffer.from(result.data, "base64");
  }

  async git(workspace: string, request: GitRequest, signal: AbortSignal): Promise<GitResult> {
    return Git.parse(await this.post("/git", { workspace, ...request }, signal));
  }

  private async call(path: string, payload: object, signal: AbortSignal): Promise<ExecResult> {
    // The runner is another process: validate what crosses the boundary.
    const result = Result.parse(await this.post(path, payload, signal));
    return { ...result, output: truncate(result.output) };
  }

  private async post(path: string, payload: object, signal: AbortSignal): Promise<unknown> {
    const token = (await readFile(this.tokenFile, "utf8").catch(() => "")).trim();
    if (!token) {
      throw new Error(
        `The shell runner has not started yet (no token at ${this.tokenFile}). ` +
          "Check it with docker compose ps.",
      );
    }
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
        // Aborting the request is how the runner learns to kill the command.
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(`Cannot reach the shell runner at ${this.url}. Check docker compose ps.`, {
        cause: error,
      });
    }
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const detail =
        (body as { error?: string } | undefined)?.error ?? `HTTP ${String(res.status)}`;
      throw new Error(`The shell runner refused the command: ${detail}`);
    }
    return body;
  }
}
