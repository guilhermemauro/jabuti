import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AgentState } from "../packages/server/src/agents/state.ts";
import { DockerSandbox } from "../packages/server/src/sandbox/docker.ts";

// Runs against the real Docker daemon: this is the obligation itself.
const dir = mkdtempSync(join(tmpdir(), "jabuti-c3-"));
const state = new AgentState(dir);
const sandbox = new DockerSandbox("python:3.13-slim", (agent) => state.workspace(agent));
const id = `c3-${String(process.pid)}`;
const run = (command: string) =>
  sandbox.exec(id, command, { timeoutSeconds: 30, signal: new AbortController().signal, env: {} });

afterAll(async () => {
  await sandbox.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe("C3: shell commands run in a container with only the workspace mounted", () => {
  it("sees no host environment variable", { timeout: 120_000 }, async () => {
    process.env["JABUTI_C3_SECRET"] = "c3-secret-value";
    const result = await run("env");
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).not.toContain("c3-secret-value");
    expect(result.output).not.toContain("ANTHROPIC_API_KEY");
    expect(result.output).not.toContain(process.env["HOME"] ?? "/Users/");
  });

  it("passes the agent's shell variables, and only those", { timeout: 60_000 }, async () => {
    const result = await sandbox.exec(id, "env", {
      timeoutSeconds: 30,
      signal: new AbortController().signal,
      env: { SITE_TOKEN: "c3-agent-variable" },
    });
    expect(result.output).toContain("SITE_TOKEN=c3-agent-variable");
    expect(result.output).not.toContain("c3-secret-value");
  });

  it(
    "shares the agent's workspace with the host, and nothing else",
    { timeout: 60_000 },
    async () => {
      const write = await run("echo hello > note.txt && pwd");
      expect(write.output.trim()).toContain("/workspace");
      expect(readFileSync(join(dir, id, "workspace", "note.txt"), "utf8")).toBe("hello\n");

      const mounts = await run("cat /proc/mounts");
      const hostPaths = mounts.output.split("\n").filter((l) => l.includes(" /workspace "));
      expect(hostPaths).toHaveLength(1);
      expect((await run(`ls ${tmpdir()} 2>&1; ls /Users 2>&1`)).output).toMatch(/No such file/);
      expect(existsSync(join(dir, id, "workspace"))).toBe(true);
      // The brief and notes sit next to the workspace, out of the shell's reach (C14).
      state.writeBrief(id, "synthetic brief");
      state.createNote(id, { summary: "Synthetic note.", body: "" }, { source: "chat" });
      const listed = (await run("ls -aR /workspace .. 2>&1")).output;
      expect(listed).not.toContain("brief.md");
      expect(listed).not.toContain("memories");
      expect(listed).not.toContain("index.md");
    },
  );

  it(
    "writes a connector's file where the shell reads it, and nowhere else (C5)",
    { timeout: 60_000 },
    async () => {
      const content = 'query,clicks\n"a, ""b""",3\n';
      await sandbox.writeFile(id, "mcp/gsc/report.csv", content, new AbortController().signal);
      expect((await run("cat mcp/gsc/report.csv")).output).toBe(content);
      for (const bad of ["../escape.txt", "/etc/x", "mcp/../../x", "-rf", "a b"]) {
        await expect(
          sandbox.writeFile(id, bad, "x", new AbortController().signal),
          bad,
        ).rejects.toThrow(/Invalid file path/);
      }
    },
  );

  it("kills a command that outlives its timeout", { timeout: 60_000 }, async () => {
    const result = await sandbox.exec(id, "sleep 30", {
      timeoutSeconds: 1,
      signal: new AbortController().signal,
      env: {},
    });
    expect(result.timedOut).toBe(true);
  });
});
