// The shell runner (C3): runs agents' commands in its own container, which holds
// no Jabuti secrets. Each agent is a separate Unix user that owns only its
// workspace (/workspaces/<agent>, mode 700), so agents cannot read each other's
// files. The server reaches it over the compose network; the token, readable only
// by the server, keeps agents' own code from calling this API.
//
// Runs as root: it creates users and switches to them. Commands never run as root.
// The root actions are installing Debian packages by name (C17) and publishing with
// the deploy key (C21): no command is taken from a request, only checked names.
import { execFile, execFileSync, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";

const PORT = 4318;
const WORKSPACES = "/workspaces";
const TOKEN_FILE = "/run/jabuti-runner/token";
/** The Jabuti server's user in its image; only it may read the token. */
const SERVER_UID = 1000;
const WORKSPACE_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** Raw output kept in memory; the server truncates further for the model. */
const OUTPUT_CAP = 1024 * 1024;
const MAX_TIMEOUT = 600;
/** Requests other than /write are small. */
const BODY_CAP = 256 * 1024;
/** Same as FILE_CAP and FILE_PATH in the server's sandbox. */
const FILE_CAP = 20 * 1024 * 1024;
const FILE_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;
const WRITE_SCRIPT = 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"';
/** Idle HTTP connections time out after 300 s; a byte now and then keeps them open. */
const KEEPALIVE_MS = 20_000;

/** Debian package names; never starts with "-", so never read as an apt option. */
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{1,62}$/;
/** Installed packages, reinstalled at start: the image may be rebuilt meanwhile. */
const PACKAGES_FILE = "/var/lib/jabuti-runner/packages.txt";
const INSTALL_TIMEOUT_MS = 600_000;

const token = randomBytes(32).toString("base64url");
mkdirSync(dirname(TOKEN_FILE), { recursive: true });
writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
chownSync(TOKEN_FILE, SERVER_UID, SERVER_UID);

interface Account {
  uid: number;
  gid: number;
  home: string;
}
const accounts = new Map<string, Promise<Account>>();

/** The workspace's user, created on first use. Serialized per workspace. */
function account(workspace: string): Promise<Account> {
  let ready = accounts.get(workspace);
  if (!ready) {
    ready = Promise.resolve().then(() => createAccount(workspace));
    ready.catch(() => accounts.delete(workspace));
    accounts.set(workspace, ready);
  }
  return ready;
}

function createAccount(workspace: string): Account {
  const user = `agent-${workspace}`.slice(0, 32);
  const home = join(WORKSPACES, workspace);
  if (!lookup(user)) {
    // --system: uids below 1000, so never the server's uid that owns the token.
    execFileSync("useradd", ["--system", "--no-create-home", "--home-dir", home, user]);
  }
  const found = lookup(user);
  if (!found) throw new Error(`could not create user ${user}`);
  mkdirSync(home, { recursive: true });
  // Everything in it, not just the folder: after a new container the user may have
  // a new uid (see the start below). Links change themselves, never what they point
  // to (-R never follows them; -h says so), so a planted link cannot hand an agent a
  // file outside. Once per
  // workspace per runner start; a large workspace makes that start slower.
  execFileSync("chown", ["-R", "-h", "--", `${String(found.uid)}:${String(found.gid)}`, home]);
  chmodSync(home, 0o700);
  return { ...found, home };
}

/** Workspaces already on the volume, from earlier runs of the runner. */
function existing(): string[] {
  if (!existsSync(WORKSPACES)) return [];
  return readdirSync(WORKSPACES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && WORKSPACE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function lookup(user: string): { uid: number; gid: number } | undefined {
  for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
    const [name, , uid, gid] = line.split(":");
    if (name === user) return { uid: Number(uid), gid: Number(gid) };
  }
  return undefined;
}

interface ExecRequest {
  workspace: string;
  command: string;
  timeoutSeconds: number;
  /** The agent's variables marked for its shell, chosen by the server. */
  env: Record<string, string>;
}

const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

function parse(body: unknown): ExecRequest | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { workspace, command, timeoutSeconds, env = {} } = body as Record<string, unknown>;
  if (typeof workspace !== "string" || !WORKSPACE_NAME.test(workspace)) return undefined;
  if (typeof command !== "string" || command === "") return undefined;
  if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds)) return undefined;
  if (timeoutSeconds < 1 || timeoutSeconds > MAX_TIMEOUT) return undefined;
  if (typeof env !== "object" || env === null) return undefined;
  const entries = Object.entries(env);
  if (!entries.every(([k, v]) => VARIABLE_NAME.test(k) && typeof v === "string")) return undefined;
  return {
    workspace,
    command,
    timeoutSeconds,
    env: Object.fromEntries(entries),
  };
}

async function exec(req: IncomingMessage, res: ServerResponse, request: ExecRequest) {
  const { uid, gid, home } = await account(request.workspace);
  // Headers now, result at the end; spaces in between keep the connection alive
  // (JSON allows leading whitespace).
  res.writeHead(200, { "Content-Type": "application/json" });
  const keepalive = setInterval(() => res.write(" "), KEEPALIVE_MS);

  const child = spawn(
    "timeout",
    ["-s", "KILL", String(request.timeoutSeconds), "sh", "-c", request.command],
    {
      cwd: home,
      uid,
      gid,
      // A clean environment: nothing from the runner reaches the command.
      env: {
        ...request.env,
        // After the agent's variables, so none can replace these.
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: home,
        LANG: "C.UTF-8",
        // pip installs into the agent's home (~/.local), which persists with it.
        PIP_BREAK_SYSTEM_PACKAGES: "1",
      },
      // Own process group, so cancel kills everything the command started.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  let dropped = 0;
  const collect = (chunk: Buffer) => {
    const room = OUTPUT_CAP - output.length;
    if (room > 0) output += chunk.toString("utf8", 0, Math.min(room, chunk.length));
    dropped += Math.max(0, chunk.length - Math.max(room, 0));
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  // The server aborted (the user pressed Stop): kill the whole group.
  const cancel = () => {
    if (child.pid !== undefined && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  };
  res.on("close", cancel);

  const exitCode = await new Promise<number>((done) => {
    child.on("error", (error) => {
      output += `\n${error.message}`;
      done(-1);
    });
    child.on("close", (code, signal) => {
      done(code ?? (signal === "SIGKILL" ? 137 : -1));
    });
  });
  clearInterval(keepalive);
  res.off("close", cancel);
  if (dropped > 0) output += `\n[runner dropped ${String(dropped)} more bytes]`;
  // timeout exits 137 when it kills with KILL, 124 if the command ignored a TERM.
  const timedOut = exitCode === 137 || exitCode === 124;
  res.end(JSON.stringify({ exitCode, output, timedOut }));
}

// --- Files from connectors (C5) ---

interface WriteRequest {
  workspace: string;
  path: string;
  /** Text, or the bytes of a binary file such as a generated image. */
  content: string | Buffer;
}

function parseWrite(body: unknown): WriteRequest | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { workspace, path, content, encoding } = body as Record<string, unknown>;
  if (typeof workspace !== "string" || !WORKSPACE_NAME.test(workspace)) return undefined;
  if (typeof path !== "string" || !FILE_PATH.test(path)) return undefined;
  if (typeof content !== "string") return undefined;
  if (encoding !== undefined && encoding !== "base64") return undefined;
  return {
    workspace,
    path,
    content: encoding === "base64" ? Buffer.from(content, "base64") : content,
  };
}

// --- Files the model looks at (view_images, C21) ---

/** The largest file /read returns. */
const READ_CAP = FILE_CAP;

function parseRead(body: unknown): { workspace: string; path: string } | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { workspace, path } = body as Record<string, unknown>;
  if (typeof workspace !== "string" || !WORKSPACE_NAME.test(workspace)) return undefined;
  if (typeof path !== "string" || !FILE_PATH.test(path)) return undefined;
  return { workspace, path };
}

/** As the agent's user, like write: a planted link reaches only the agent's own files. */
async function read(res: ServerResponse, request: { workspace: string; path: string }) {
  const { uid, gid, home } = await account(request.workspace);
  const child = spawn("cat", ["--", request.path], {
    cwd: home,
    uid,
    gid,
    env: { PATH: "/usr/bin:/bin", HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  let size = 0;
  let error = "";
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > READ_CAP) child.kill("SIGKILL");
    else chunks.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => (error += chunk.toString()));
  const exitCode = await new Promise<number>((done) => {
    child.on("error", (e) => {
      error += e.message;
      done(-1);
    });
    child.on("close", (code) => {
      done(code ?? -1);
    });
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  if (size > READ_CAP) {
    res.end(
      JSON.stringify({ ok: false, error: `${request.path} is over ${String(READ_CAP)} bytes.` }),
    );
  } else if (exitCode !== 0) {
    res.end(JSON.stringify({ ok: false, error: error.trim() || `Cannot read ${request.path}.` }));
  } else {
    res.end(JSON.stringify({ ok: true, data: Buffer.concat(chunks).toString("base64") }));
  }
}

/**
 * As the agent's user, never as root: a link the agent planted at the path then
 * reaches only what the agent itself could write.
 */
async function write(res: ServerResponse, request: WriteRequest) {
  const { uid, gid, home } = await account(request.workspace);
  const child = spawn("sh", ["-c", WRITE_SCRIPT, "write", request.path], {
    cwd: home,
    uid,
    gid,
    env: { PATH: "/usr/bin:/bin", HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  // A closed pipe (the script failed early) shows as its exit code.
  child.stdin.on("error", () => undefined);
  child.stdin.end(request.content);
  const exitCode = await new Promise<number>((done) => {
    child.on("error", (error) => {
      output += error.message;
      done(-1);
    });
    child.on("close", (code) => {
      done(code ?? -1);
    });
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ exitCode, output: output.slice(-2000), timedOut: false }));
}

// --- System packages (C17) ---

/** One apt run at a time: dpkg holds a lock. */
let aptQueue: Promise<unknown> = Promise.resolve();

function apt(packages: string[]): Promise<{ exitCode: number; output: string }> {
  const run = aptQueue.then(() => aptNow(packages));
  aptQueue = run.catch(() => undefined);
  return run;
}

async function aptNow(packages: string[]): Promise<{ exitCode: number; output: string }> {
  const env = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", DEBIAN_FRONTEND: "noninteractive" };
  const step = (args: string[]) =>
    new Promise<{ exitCode: number; output: string }>((done) => {
      execFile(
        "apt-get",
        args,
        { env, timeout: INSTALL_TIMEOUT_MS, maxBuffer: OUTPUT_CAP },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
          done({ exitCode: code, output: `${stdout}${stderr}` });
        },
      );
    });
  const update = await step(["update", "-q"]);
  if (update.exitCode !== 0) return update;
  // "--" ends options: what follows are package names only.
  const install = await step(["install", "-y", "-q", "--no-install-recommends", "--", ...packages]);
  if (install.exitCode === 0) remember(packages);
  return install;
}

function installed(): string[] {
  if (!existsSync(PACKAGES_FILE)) return [];
  return readFileSync(PACKAGES_FILE, "utf8")
    .split("\n")
    .filter((name) => PACKAGE_NAME.test(name));
}

function remember(packages: string[]) {
  mkdirSync(dirname(PACKAGES_FILE), { recursive: true });
  const all = [...new Set([...installed(), ...packages])].sort();
  writeFileSync(PACKAGES_FILE, `${all.join("\n")}\n`, { mode: 0o600 });
}

function parsePackages(body: unknown): string[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { packages } = body as Record<string, unknown>;
  if (!Array.isArray(packages) || packages.length === 0 || packages.length > 20) return undefined;
  if (!packages.every((p): p is string => typeof p === "string" && PACKAGE_NAME.test(p))) {
    return undefined;
  }
  return packages;
}

async function install(res: ServerResponse, packages: string[]) {
  res.writeHead(200, { "Content-Type": "application/json" });
  const keepalive = setInterval(() => res.write(" "), KEEPALIVE_MS);
  const result = await apt(packages).finally(() => {
    clearInterval(keepalive);
  });
  res.end(JSON.stringify({ ...result, timedOut: false }));
}

// --- Publishing with a deploy key only Jabuti holds (C21) ---
//
// The key lives in a root-only folder: no agent can read it, so no agent, nor a
// script it writes, can push. Root never runs git inside an agent's repository
// (its hooks and config are the agent's): the agent's own user packs its branch as
// a bundle on stdout, and root imports that pack into a mirror only root owns.
// Merges happen in a separate root-owned clone. Nothing in a request becomes a
// command: names are checked, and each action is a fixed sequence of git calls.

const KEYS = "/var/lib/jabuti-runner/keys";
const PUBLISH = "/var/lib/jabuti-runner/publish";
/** GitHub's host key, pinned: a push never trusts whatever answers on first use. */
const GITHUB_HOSTS =
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n";
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
/** Git branch names, conservatively: no "..", no leading "-" or "/", no "@{". */
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const GIT_TIMEOUT_MS = 180_000;
/** The largest branch bundle an agent may hand over. */
const BUNDLE_CAP = 512 * 1024 * 1024;
const ACTIONS = ["key", "test", "push", "merge", "delete", "sync"] as const;

interface GitRequest {
  workspace: string;
  action: (typeof ACTIONS)[number];
  repo: string;
  base: string;
  branch: string;
  /** The repository's folder in the workspace, relative. */
  source: string;
  message: string;
}

function parseGit(body: unknown): GitRequest | string {
  if (typeof body !== "object" || body === null) return "Send a JSON object.";
  const b = body as Record<string, unknown>;
  const text = (key: string) => (typeof b[key] === "string" ? b[key] : "");
  const request: GitRequest = {
    workspace: text("workspace"),
    action: text("action") as GitRequest["action"],
    repo: text("repo"),
    base: text("base"),
    branch: text("branch"),
    source: text("source"),
    message: text("message").slice(0, 2000),
  };
  if (!WORKSPACE_NAME.test(request.workspace)) return "Bad workspace.";
  if (!ACTIONS.includes(request.action)) return `action is one of ${ACTIONS.join(", ")}.`;
  if (request.action === "key") return request;
  if (!REPO.test(request.repo)) return "repo is owner/name.";
  if (request.action === "test") return request;
  if (!BRANCH.test(request.base)) return "Bad base branch.";
  if (
    request.action !== "sync" &&
    (!BRANCH.test(request.branch) || request.branch === request.base)
  ) {
    return "branch must be a branch name other than the base.";
  }
  if ((request.action === "push" || request.action === "sync") && !FILE_PATH.test(request.source)) {
    return "source is the repository's folder in the workspace, relative.";
  }
  return request;
}

interface GitResult {
  ok: boolean;
  output: string;
  publicKey?: string;
  fingerprint?: string;
}

/** One git action at a time per workspace: two pushes must not share the mirror. */
const gitQueues = new Map<string, Promise<unknown>>();

function serialized<T>(workspace: string, work: () => Promise<T>): Promise<T> {
  const run = (gitQueues.get(workspace) ?? Promise.resolve()).then(work);
  gitQueues.set(
    workspace,
    run.catch(() => undefined),
  );
  return run;
}

interface Run {
  code: number;
  output: string;
}

/** A program with fixed arguments, as root unless a uid is given. Never a shell. */
function program(
  file: string,
  args: string[],
  options: {
    env: Record<string, string>;
    uid?: number;
    gid?: number;
    cwd?: string;
    stdout?: string;
    stdin?: string;
  },
): Promise<Run> {
  return new Promise((done) => {
    const out = options.stdout ? openSync(options.stdout, "w", 0o600) : undefined;
    const input = options.stdin ? openSync(options.stdin, "r") : undefined;
    const child = spawn(file, args, {
      env: options.env,
      ...(options.uid === undefined ? {} : { uid: options.uid, gid: options.gid }),
      cwd: options.cwd ?? "/",
      stdio: [input ?? "ignore", out ?? "pipe", "pipe"],
    });
    let output = "";
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", (error) => {
      output += error.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (out !== undefined) {
        size = statSync(options.stdout ?? "").size;
        closeSync(out);
      }
      if (input !== undefined) closeSync(input);
      done({ code: size > BUNDLE_CAP ? -2 : (code ?? -1), output: output.slice(-4000) });
    });
  });
}

function keyPaths(workspace: string) {
  const dir = join(KEYS, workspace);
  return { dir, key: join(dir, "id_ed25519"), hosts: join(KEYS, "known_hosts") };
}

/** Root's git: no system or global config, the pinned host, this agent's key. */
function rootEnv(workspace: string): Record<string, string> {
  const { key, hosts } = keyPaths(workspace);
  return {
    PATH: "/usr/bin:/bin",
    HOME: join(PUBLISH, workspace),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: `ssh -i ${key} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${hosts}`,
    GIT_AUTHOR_NAME: "Jabuti",
    GIT_AUTHOR_EMAIL: "jabuti@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Jabuti",
    GIT_COMMITTER_EMAIL: "jabuti@users.noreply.github.com",
  };
}

/** The agent's deploy key, made on first use. The private half never leaves here. */
async function ensureKey(workspace: string): Promise<GitResult> {
  const { dir, key, hosts } = keyPaths(workspace);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(KEYS, 0o700);
  writeFileSync(hosts, GITHUB_HOSTS, { mode: 0o600 });
  if (!existsSync(key)) {
    const made = await program(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", `jabuti-${workspace}`, "-f", key],
      { env: { PATH: "/usr/bin:/bin" } },
    );
    if (made.code !== 0) return { ok: false, output: `Could not make a key: ${made.output}` };
  }
  const publicKey = readFileSync(`${key}.pub`, "utf8").trim();
  const print = await program("ssh-keygen", ["-l", "-f", `${key}.pub`], {
    env: { PATH: "/usr/bin:/bin" },
  });
  const fingerprint = print.output.split(" ")[1] ?? "";
  return { ok: true, output: "", publicKey, fingerprint };
}

/** For tests only: a local path in place of GitHub, as /srv/remotes/{repo}.git. */
const REMOTE_TEMPLATE = process.env["JABUTI_GIT_REMOTE"];
const remote = (repo: string) =>
  REMOTE_TEMPLATE ? REMOTE_TEMPLATE.replace("{repo}", repo) : `git@github.com:${repo}.git`;

async function mirror(workspace: string): Promise<string> {
  const dir = join(PUBLISH, workspace, "mirror.git");
  if (!existsSync(dir)) {
    mkdirSync(join(PUBLISH, workspace), { recursive: true, mode: 0o700 });
    await program("git", ["init", "-q", "--bare", dir], { env: rootEnv(workspace) });
  }
  return dir;
}

async function git(request: GitRequest): Promise<GitResult> {
  const { workspace, repo, base, branch } = request;
  const keyed = await ensureKey(workspace);
  if (!keyed.ok || request.action === "key") return keyed;
  const env = rootEnv(workspace);
  const fail = (step: string, run: Run): GitResult => ({
    ok: false,
    output: `${step} failed:\n${run.output.trim()}`,
  });

  if (request.action === "test") {
    const run = await program("git", ["ls-remote", "--heads", remote(repo)], { env });
    return run.code === 0
      ? { ok: true, output: "Jabuti reaches the repository with its key." }
      : fail("Reading the repository", run);
  }

  if (request.action === "delete") {
    const dir = await mirror(workspace);
    const run = await program("git", ["-C", dir, "push", remote(repo), "--delete", branch], {
      env,
    });
    // Already gone counts as done.
    return run.code === 0 || run.output.includes("remote ref does not exist")
      ? { ok: true, output: `Deleted ${branch} on GitHub.` }
      : fail("Deleting the branch", run);
  }

  const { uid, gid, home } = await account(workspace);
  if (request.action === "push") {
    // The agent's user packs its branch; root only reads the pack.
    const pack = join(PUBLISH, workspace, "in.bundle");
    mkdirSync(join(PUBLISH, workspace), { recursive: true, mode: 0o700 });
    const packed = await program(
      "git",
      ["-C", join(home, request.source), "bundle", "create", "-", `refs/heads/${branch}`],
      {
        env: { PATH: "/usr/bin:/bin", HOME: home, GIT_TERMINAL_PROMPT: "0" },
        uid,
        gid,
        cwd: home,
        stdout: pack,
      },
    );
    if (packed.code === -2) return { ok: false, output: "The branch is over 512 MB packed." };
    if (packed.code !== 0) return fail(`Packing ${branch} in ${request.source}`, packed);
    const dir = await mirror(workspace);
    const fetched = await program(
      "git",
      ["-C", dir, "fetch", "-q", pack, `+refs/heads/${branch}:refs/heads/${branch}`],
      { env },
    );
    if (fetched.code !== 0) return fail("Reading the branch", fetched);
    // Force: the agent may amend a proposal. Never the base: parseGit refuses it.
    const pushed = await program(
      "git",
      [
        "-C",
        dir,
        "push",
        "-q",
        "--force",
        remote(repo),
        `refs/heads/${branch}:refs/heads/${branch}`,
      ],
      { env },
    );
    return pushed.code === 0
      ? { ok: true, output: `Pushed ${branch} to ${repo}.` }
      : fail("Pushing to GitHub", pushed);
  }

  if (request.action === "merge") {
    const work = join(PUBLISH, workspace, "work");
    const g = (...args: string[]) => program("git", ["-C", work, ...args], { env });
    if (!existsSync(join(work, ".git"))) {
      mkdirSync(join(PUBLISH, workspace), { recursive: true, mode: 0o700 });
      const cloned = await program("git", ["clone", "-q", remote(repo), work], { env });
      if (cloned.code !== 0) return fail("Cloning the repository", cloned);
    }
    await g("remote", "set-url", "origin", remote(repo));
    const fetched = await g("fetch", "-q", "--prune", "origin");
    if (fetched.code !== 0) return fail("Fetching from GitHub", fetched);
    await g("checkout", "-q", "-B", base, `origin/${base}`);
    await g("reset", "-q", "--hard", `origin/${base}`);
    await g("clean", "-q", "-fdx");
    const merged = await g("merge", "--squash", `origin/${branch}`);
    if (merged.code !== 0) {
      await g("reset", "-q", "--hard", `origin/${base}`);
      return fail(
        `Merging ${branch} into ${base} (ask the agent to update its branch from ${base})`,
        merged,
      );
    }
    const committed = await g("commit", "-q", "-m", request.message || `Merge ${branch}`);
    if (committed.code !== 0) return fail("Committing the merge", committed);
    const pushed = await g("push", "-q", "origin", `HEAD:refs/heads/${base}`);
    if (pushed.code !== 0) {
      await g("reset", "-q", "--hard", `origin/${base}`);
      return fail(`Pushing to ${base}`, pushed);
    }
    await g("push", "-q", "origin", "--delete", branch);
    return { ok: true, output: `Merged ${branch} into ${base} and pushed it.` };
  }

  // sync: the base branch into the agent's repository, through a bundle it fetches
  // as itself; the repository is cloned from it if missing.
  const dir = await mirror(workspace);
  const fetched = await program(
    "git",
    ["-C", dir, "fetch", "-q", remote(repo), `+refs/heads/${base}:refs/heads/${base}`],
    { env },
  );
  if (fetched.code !== 0) return fail("Fetching from GitHub", fetched);
  const pack = join(PUBLISH, workspace, "out.bundle");
  const packed = await program(
    "git",
    ["-C", dir, "bundle", "create", "-q", pack, `refs/heads/${base}`],
    {
      env,
    },
  );
  if (packed.code !== 0) return fail("Packing the base branch", packed);
  const agentEnv = { PATH: "/usr/bin:/bin", HOME: home, GIT_TERMINAL_PROMPT: "0" };
  const delivered = await program("sh", ["-c", WRITE_SCRIPT, "write", `.jabuti/${base}.bundle`], {
    env: agentEnv,
    uid,
    gid,
    cwd: home,
    stdin: pack,
  });
  if (delivered.code !== 0) return fail("Handing the bundle over", delivered);
  const bundle = join(home, ".jabuti", `${base}.bundle`);
  const target = join(home, request.source);
  const synced = existsSync(join(target, ".git"))
    ? await program(
        "git",
        ["-C", target, "fetch", "-q", bundle, `+refs/heads/${base}:refs/remotes/origin/${base}`],
        { env: agentEnv, uid, gid, cwd: home },
      )
    : await program("git", ["clone", "-q", "--branch", base, bundle, target], {
        env: agentEnv,
        uid,
        gid,
        cwd: home,
      });
  return synced.code === 0
    ? {
        ok: true,
        output: `${base} from ${repo} is in ${request.source} as origin/${base}.`,
      }
    : fail("Updating the agent's repository", synced);
}

function authorized(req: IncomingMessage): boolean {
  const given = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req: IncomingMessage, cap = BODY_CAP): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > cap) return undefined;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function reply(res: ServerResponse, status: number, error: string) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error }));
}

const server = createServer((req, res) => {
  void (async () => {
    if (req.method === "GET" && req.url === "/health") {
      reply(res, 200, "");
      return;
    }
    if (
      req.method !== "POST" ||
      !["/exec", "/install", "/write", "/read", "/git"].includes(req.url ?? "")
    ) {
      reply(res, 404, "Not found.");
      return;
    }
    if (!authorized(req)) {
      reply(res, 401, "Bad runner token.");
      return;
    }
    if (req.url === "/install") {
      const packages = parsePackages(await readJson(req));
      if (!packages) {
        reply(res, 400, "Send { packages: [names] }, 1 to 20 Debian package names.");
        return;
      }
      await install(res, packages);
      return;
    }
    if (req.url === "/git") {
      const request = parseGit(await readJson(req));
      if (typeof request === "string") {
        reply(res, 400, request);
        return;
      }
      const result = await serialized(request.workspace, () => git(request));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }
    if (req.url === "/read") {
      const request = parseRead(await readJson(req));
      if (!request) {
        reply(res, 400, "Send { workspace, path }: a relative path.");
        return;
      }
      await read(res, request);
      return;
    }
    if (req.url === "/write") {
      // JSON escapes can double the size of the content; the cap below is exact.
      const request = parseWrite(await readJson(req, 2 * FILE_CAP + BODY_CAP));
      if (!request || request.content.length > FILE_CAP) {
        reply(res, 400, "Send { workspace, path, content }: a relative path, at most 20 MB.");
        return;
      }
      await write(res, request);
      return;
    }
    const request = parse(await readJson(req));
    if (!request) {
      reply(res, 400, "Send { workspace, command, timeoutSeconds }.");
      return;
    }
    await exec(req, res, request);
  })().catch((error: unknown) => {
    if (!res.headersSent) reply(res, 500, String(error));
    else res.end(JSON.stringify({ exitCode: -1, output: String(error), timedOut: false }));
  });
});
// Users live in /etc/passwd, which a new container (an image rebuild) starts
// without, while /workspaces is a volume that keeps their files. Recreated on first
// use, they got uids in a new order: an agent lost its own files, and got the uid
// that owned another agent's. So every workspace gets its user back here, before
// any request, and its files with it.
for (const workspace of existing()) {
  account(workspace).catch((error: unknown) => {
    process.stderr.write(`! Could not restore the user of ${workspace}: ${String(error)}\n`);
  });
}

// Commands may run for MAX_TIMEOUT seconds; the keepalive covers idle limits.
server.requestTimeout = 0;
server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write(`Jabuti runner on :${String(PORT)}, workspaces in ${WORKSPACES}\n`);
});

// Packages installed earlier, gone if the image was rebuilt: put them back.
const previous = installed();
if (previous.length > 0) {
  process.stdout.write(`Reinstalling ${String(previous.length)} packages: ${previous.join(" ")}\n`);
  void apt(previous).then(({ exitCode, output }) => {
    if (exitCode !== 0) process.stderr.write(`! Reinstall failed:\n${output.slice(-2000)}\n`);
  });
}
