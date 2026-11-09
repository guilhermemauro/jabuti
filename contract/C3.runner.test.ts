import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunnerSandbox } from "../packages/server/src/sandbox/runner.ts";

// C3 when Jabuti runs in a container: against the real runner image, built from
// the Dockerfile. A secret is planted in the runner's own environment to prove
// that commands still never see it.
const ROOT = join(import.meta.dirname, "..");
const SECRET = "c3-runner-secret-value";
const name = `jabuti-c3-runner-${String(process.pid)}`;
const dir = mkdtempSync(join(tmpdir(), "jabuti-c3-runner-"));
const tokenFile = join(dir, "token");
let url = "";
let sandbox: RunnerSandbox;

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const signal = () => new AbortController().signal;
const run = (workspace: string, command: string) =>
  sandbox.exec(workspace, command, { timeoutSeconds: 30, signal: signal(), env: {} });

/** A new runner container on the same workspaces volume, as after an image rebuild. */
async function start() {
  docker(
    ...["run", "-d", "--name", name, "-e", `JABUTI_C3_SECRET=${SECRET}`],
    // GitHub replaced by bare repositories in the container (C19).
    ...["-e", "JABUTI_GIT_REMOTE=/srv/remotes/{repo}.git"],
    ...["-v", `${name}:/workspaces`, "-p", "127.0.0.1::4318", "jabuti-runner:contract"],
  );
  url = `http://${docker("port", name, "4318").split("\n")[0] ?? ""}`;
  for (let i = 0; i < 50; i++) {
    const ok = await fetch(`${url}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  writeFileSync(tokenFile, docker("exec", name, "cat", "/run/jabuti-runner/token"));
  sandbox = new RunnerSandbox(url, tokenFile);
}

beforeAll(async () => {
  docker("build", "--quiet", "--target", "runner", "-t", "jabuti-runner:contract", ROOT);
  await start();
}, 300_000);

afterAll(() => {
  execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  execFileSync("docker", ["volume", "rm", "-f", name], { stdio: "ignore" });
  rmSync(dir, { recursive: true, force: true });
});

describe("C3: in a container, shell commands run in the runner, one user per agent", () => {
  it("sees no variable from the runner's environment, nor its token", async () => {
    const result = await run("site-a", "env; cat /proc/1/environ 2>&1");
    expect(result.exitCode).not.toBe(-1);
    expect(result.output).not.toContain(SECRET);
    expect(result.output).not.toContain(docker("exec", name, "cat", "/run/jabuti-runner/token"));
    expect(result.output).toMatch(/Permission denied/);
  });

  it("passes the agent's shell variables, and none can replace the shell's own", async () => {
    const result = await sandbox.exec("site-a", "env", {
      timeoutSeconds: 30,
      signal: signal(),
      env: { SITE_TOKEN: "c3-agent-variable", PATH: "/hijacked" },
    });
    expect(result.output).toContain("SITE_TOKEN=c3-agent-variable");
    expect(result.output).not.toContain("/hijacked");
    expect(result.output).not.toContain(SECRET);
  });

  it("never runs a command as root", async () => {
    expect((await run("site-a", "id -u")).output.trim()).not.toBe("0");
  });

  it("keeps each agent out of the others' workspaces", async () => {
    await run("site-a", "echo private > notes.txt");
    const read = await run("site-b", "cat ../site-a/notes.txt; touch ../site-a/x");
    expect(read.output).not.toContain("private");
    expect(read.output).toMatch(/Permission denied/);
    // The owner still has its file, across calls.
    expect((await run("site-a", "cat notes.txt")).output).toContain("private");
  });

  it("writes a connector's file as the agent, so a planted link reaches nothing new (C5)", async () => {
    await sandbox.writeFile("site-a", "mcp/gsc/rows.csv", "a,b\n1,2\n", signal());
    const own = await run("site-a", "cat mcp/gsc/rows.csv && echo 3,4 >> mcp/gsc/rows.csv");
    expect(own.output).toBe("a,b\n1,2\n");
    expect((await run("site-b", "cat ../site-a/mcp/gsc/rows.csv")).output).toMatch(
      /Permission denied/,
    );
    // site-b points its mcp folder at site-a's workspace, and at a root-only file.
    await run("site-b", "ln -s /workspaces/site-a mcp && ln -s /etc/shadow shadow");
    await expect(sandbox.writeFile("site-b", "mcp/planted.txt", "x", signal())).rejects.toThrow(
      /Permission denied/,
    );
    await expect(sandbox.writeFile("site-b", "shadow", "x", signal())).rejects.toThrow(
      /Permission denied/,
    );
    expect(docker("exec", name, "ls", "/workspaces/site-a")).not.toContain("planted");
    const post = (path: string) =>
      fetch(`${url}/write`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${docker("exec", name, "cat", "/run/jabuti-runner/token")}`,
        },
        body: JSON.stringify({ workspace: "site-a", path, content: "x" }),
      });
    for (const bad of ["../site-b/x", "/etc/x", "-x"])
      expect((await post(bad)).status, bad).toBe(400);
  });

  it("refuses a caller without the token", async () => {
    const res = await fetch(`${url}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ workspace: "site-a", command: "id", timeoutSeconds: 5 }),
    });
    expect(res.status).toBe(401);
  });

  it("kills a command that outlives its timeout", async () => {
    const result = await sandbox.exec("site-a", "sleep 30", {
      timeoutSeconds: 1,
      signal: signal(),
      env: {},
    });
    expect(result.timedOut).toBe(true);
  });

  it("kills the command when the turn is cancelled", async () => {
    const abort = new AbortController();
    const running = sandbox.exec("site-a", "sleep 300", {
      timeoutSeconds: 600,
      signal: abort.signal,
      env: {},
    });
    await new Promise((r) => setTimeout(r, 500));
    abort.abort();
    await expect(running).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 300));
    // `sleep[ ]300` matches the sleep process, not this grep's own command line.
    const left = await run(
      "site-b",
      "for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline; echo; done 2>/dev/null | grep -c 'sleep[ ]300'",
    );
    expect(left.output.trim()).toBe("0");
  });

  it("gives each agent back its own files, and only those, in a new container", async () => {
    await run("site-a", "echo mine > own.txt && ln -s /etc/shadow link");
    await run("site-b", "echo theirs > own.txt");
    // A workspace that sorts first, so uids cannot simply come back in the same order.
    docker("exec", name, "mkdir", "/workspaces/site-0");
    docker("rm", "-f", name);
    await start();
    // site-b first: the order of first use must not decide who owns what.
    const b = await run("site-b", "echo more >> own.txt && cat own.txt; cat ../site-a/own.txt");
    expect(b.output).toContain("theirs\nmore");
    expect(b.output).not.toContain("mine");
    expect(b.output).toMatch(/Permission denied/);
    expect((await run("site-a", "echo again >> own.txt && cat own.txt")).output).toContain(
      "mine\nagain",
    );
    // The planted link changed hands, not the file it points to.
    expect(docker("exec", name, "stat", "-c", "%u", "/etc/shadow")).toBe("0");
  }, 60_000);
});

describe("C21: in the runner, images are built into a mosaic and read back as the agent", () => {
  // A 1×1 PNG.
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  it("saves a connector's image byte for byte, and reads it back", async () => {
    await sandbox.writeFile("site-a", "mcp/nanobanana/dot.png", PNG, signal());
    expect((await sandbox.readFile("site-a", "mcp/nanobanana/dot.png", signal())).equals(PNG)).toBe(
      true,
    );
    // Another agent's file, or a path outside the workspace, is not read.
    await expect(
      sandbox.readFile("site-b", "../site-a/mcp/nanobanana/dot.png", signal()),
    ).rejects.toThrow();
    await run("site-b", "ln -sf /workspaces/site-a/mcp/nanobanana/dot.png stolen.png");
    await expect(sandbox.readFile("site-b", "stolen.png", signal())).rejects.toThrow(
      /Permission denied/,
    );
  });

  it("lays images out in one numbered JPEG with images.py, naming what failed", async () => {
    await run(
      "site-a",
      "/opt/jabuti/venv/bin/python -c \"from PIL import Image; Image.new('RGB', (1200, 800), (200, 40, 40)).save('big.png')\"",
    );
    const made = await run(
      "site-a",
      "/opt/jabuti/venv/bin/python /opt/jabuti/page/images.py mosaic jabuti-view/t.jpg -- big.png mcp/nanobanana/dot.png missing.png",
    );
    const printed = JSON.parse(made.output.trim().split("\n").at(-1) ?? "") as {
      mosaic: string;
      items: { n: number; ok: boolean; width?: number }[];
    };
    expect(made.exitCode).toBe(0);
    expect(printed.mosaic).toBe("jabuti-view/t.jpg");
    expect(printed.items.map((i) => [i.n, i.ok, i.width])).toEqual([
      [1, true, 1200],
      [2, true, 1],
      [3, false, undefined],
    ]);
    const mosaic = await sandbox.readFile("site-a", printed.mosaic, signal());
    expect(mosaic.subarray(0, 3).toString("hex")).toBe("ffd8ff");
  });
});

describe("C17: in the runner, packages install as root by name only", () => {
  it("refuses requests without the token, or with anything but package names", async () => {
    const post = (body: object, auth = true) =>
      fetch(`${url}/install`, {
        method: "POST",
        headers: auth
          ? { authorization: `Bearer ${docker("exec", name, "cat", "/run/jabuti-runner/token")}` }
          : {},
        body: JSON.stringify(body),
      });
    expect((await post({ packages: ["tree"] }, false)).status).toBe(401);
    for (const bad of [["tree; id"], ["-o=x"], [], ["$(id)"]]) {
      expect((await post({ packages: bad })).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("installs a package every agent can run, and remembers it", async () => {
    const result = await sandbox.install("site-a", ["tree"], signal());
    expect(result.exitCode, result.output).toBe(0);
    expect((await run("site-b", "tree --version")).exitCode).toBe(0);
    expect(docker("exec", name, "cat", "/var/lib/jabuti-runner/packages.txt")).toContain("tree");
    // Commands still never run as root.
    expect((await run("site-a", "id -u")).output.trim()).not.toBe("0");
  }, 300_000);
});

describe("C19: in the runner, Jabuti publishes with a deploy key no agent can read", () => {
  const sh = (command: string) => docker("exec", name, "sh", "-c", command);
  const git = (request: Parameters<RunnerSandbox["git"]>[1]) =>
    sandbox.git("publisher", request, signal());
  const remoteHas = (ref: string) =>
    sh(`git -C /srv/remotes/synthetic/site.git rev-parse --verify -q ${ref} || true`) !== "";
  const site = { repo: "synthetic/site", base: "main" };

  beforeAll(() => {
    // The "GitHub" repository, with one commit on main.
    sh(
      [
        "set -e",
        "mkdir -p /srv/remotes/synthetic /tmp/seed",
        "git init -q --bare -b main /srv/remotes/synthetic/site.git",
        "cd /tmp/seed && git init -q -b main",
        "echo hello > README.md && git add README.md",
        "git -c user.name=s -c user.email=s@x commit -qm seed",
        "git push -q /srv/remotes/synthetic/site.git main",
      ].join(" && "),
    );
  });

  it("makes a key the agent cannot read, and reaches the repository with it", async () => {
    const key = await git({ action: "key" });
    expect(key, key.output).toMatchObject({ ok: true });
    expect(key.publicKey).toMatch(/^ssh-ed25519 \S+ jabuti-publisher$/);
    expect(key.fingerprint).toMatch(/^SHA256:/);
    // Asked again: the same key, not a new one.
    expect((await git({ action: "key" })).publicKey).toBe(key.publicKey);
    const peek = await run("publisher", "cat /var/lib/jabuti-runner/keys/publisher/id_ed25519");
    expect(peek.exitCode).not.toBe(0);
    expect(peek.output).not.toContain("PRIVATE KEY");
    expect((await git({ action: "test", repo: site.repo })).ok).toBe(true);
  });

  it("clones for the agent, pushes its branch, merges it on approval, and never runs its hooks as root", async () => {
    expect((await git({ action: "sync", ...site, source: "repo" })).ok).toBe(true);
    const work = await run(
      "publisher",
      [
        "cd repo",
        "git checkout -q -b seo/a",
        "echo change > a.txt && git add a.txt",
        "git -c user.name=a -c user.email=a@x commit -qm change",
        // Hooks and config that would run code in whoever touches the repository.
        "for h in pre-push post-checkout post-merge pre-commit reference-transaction; do printf '#!/bin/sh\\nid -u >> /tmp/hook-uids\\n' > .git/hooks/$h; chmod +x .git/hooks/$h; done",
        "git config core.fsmonitor 'id -u >> /tmp/hook-uids'",
      ].join(" && "),
    );
    expect(work.exitCode, work.output).toBe(0);

    const pushed = await git({ action: "push", ...site, branch: "seo/a", source: "repo" });
    expect(pushed, pushed.output).toMatchObject({ ok: true });
    expect(remoteHas("refs/heads/seo/a")).toBe(true);
    // Never onto the base itself.
    await expect(git({ action: "push", ...site, branch: "main", source: "repo" })).rejects.toThrow(
      "branch must be a branch name other than the base",
    );

    const merged = await git({
      action: "merge",
      ...site,
      branch: "seo/a",
      message: "e-0001: change",
    });
    expect(merged, merged.output).toMatchObject({ ok: true });
    expect(sh("git -C /srv/remotes/synthetic/site.git show main:a.txt")).toBe("change");
    expect(sh("git -C /srv/remotes/synthetic/site.git log -1 --format=%s main")).toBe(
      "e-0001: change",
    );
    // The merged branch goes.
    expect(remoteHas("refs/heads/seo/a")).toBe(false);

    // The agent gets main back through Jabuti.
    expect((await git({ action: "sync", ...site, source: "repo" })).ok).toBe(true);
    const log = await run("publisher", "git -C repo show origin/main:a.txt");
    expect(log.output.trim()).toBe("change");

    // Its hooks ran only as itself, if at all: never as root.
    const uids = sh("cat /tmp/hook-uids 2>/dev/null || true").split("\n").filter(Boolean);
    expect(uids).not.toContain("0");
  });

  it("deletes a rejected branch, and says so when the merge conflicts", async () => {
    await run(
      "publisher",
      "cd repo && git checkout -q -B seo/b origin/main && echo other > README.md && git -c user.name=a -c user.email=a@x commit -qam b",
    );
    expect((await git({ action: "push", ...site, branch: "seo/b", source: "repo" })).ok).toBe(true);
    // main moves on meanwhile, on the same line.
    sh(
      "cd /tmp/seed && git pull -q /srv/remotes/synthetic/site.git main && echo theirs > README.md && git -c user.name=s -c user.email=s@x commit -qam theirs && git push -q /srv/remotes/synthetic/site.git main",
    );
    const conflict = await git({ action: "merge", ...site, branch: "seo/b", message: "b" });
    expect(conflict.ok).toBe(false);
    expect(conflict.output).toContain("ask the agent to update its branch");
    expect(sh("git -C /srv/remotes/synthetic/site.git show main:README.md")).toBe("theirs");

    expect((await git({ action: "delete", ...site, branch: "seo/b" })).ok).toBe(true);
    expect(remoteHas("refs/heads/seo/b")).toBe(false);
  });
});
