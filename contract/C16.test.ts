import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../packages/server/src/agents/registry.ts";
import { AgentState } from "../packages/server/src/agents/state.ts";
import { openDatabase } from "../packages/server/src/db/index.ts";
import { CATALOG } from "../packages/server/src/providers/catalog.ts";
import { Providers } from "../packages/server/src/providers/index.ts";
import { Settings } from "../packages/server/src/settings/index.ts";
import { Skills } from "../packages/server/src/skills/index.ts";
import { handleSettings, snapshot } from "../packages/server/src/ws/settings.ts";
import type { Script } from "./fake-model/index.ts";
import { FAKE_MODEL } from "./fake-model/index.ts";
import { agent, harness } from "./harness.ts";

const tempState = () => new AgentState(mkdtempSync(join(tmpdir(), "jabuti-c16-state-")));

// Synthetic values only.
const A_TOKEN = "synthetic-a-token-value";

function settingsWith(envKeys: Partial<Record<string, string>> = {}) {
  const db = openDatabase(":memory:");
  const settings = new Settings(db, randomBytes(32), envKeys);
  settings.saveVariable({ name: "A_TOKEN", value: A_TOKEN, scope: ["site-a"], shell: true });
  settings.saveVariable({ name: "B_TOKEN", value: "synthetic-b", scope: ["site-b"], shell: true });
  settings.saveVariable({ name: "SHARED", value: "synthetic-shared", scope: "all", shell: true });
  settings.saveVariable({
    name: "SERVER_ONLY",
    value: "synthetic-server",
    scope: "all",
    shell: false,
  });
  return { db, settings };
}

const oneCommand: Script = (_, i) =>
  i === 0 ? { calls: [{ name: "shell", input: { command: "env" } }] } : { text: "ok" };

describe("C16: a variable reaches only the agents in its scope", () => {
  it("passes to a shell only in scope and only when marked for the shell", async () => {
    const { settings } = settingsWith();
    const a = harness({ script: oneCommand, agents: [agent("site-a")], settings });
    await a.turn("go");
    const b = harness({ script: oneCommand, agents: [agent("site-b")], settings });
    await b.turn("go");

    expect(a.sandbox.envs).toEqual([{ A_TOKEN, SHARED: "synthetic-shared" }]);
    expect(b.sandbox.envs).toEqual([{ B_TOKEN: "synthetic-b", SHARED: "synthetic-shared" }]);
  });

  it("gives each agent its own value of one name, over the one for all agents", async () => {
    const { settings } = settingsWith();
    // Two sites, two Search Console accounts; a third agent falls back to the shared one.
    settings.saveVariable({
      name: "GSC",
      value: "synthetic-gsc-a",
      scope: ["site-a"],
      shell: true,
    });
    settings.saveVariable({
      name: "GSC",
      value: "synthetic-gsc-b",
      scope: ["site-b"],
      shell: true,
    });
    settings.saveVariable({ name: "GSC", value: "synthetic-gsc-all", scope: "all", shell: false });

    expect(settings.value("site-a", "GSC")).toBe("synthetic-gsc-a");
    expect(settings.value("site-b", "GSC")).toBe("synthetic-gsc-b");
    expect(settings.value("site-c", "GSC")).toBe("synthetic-gsc-all");
    expect(settings.variablesFor("site-a").filter((v) => v.name === "GSC")).toHaveLength(1);

    const a = harness({ script: oneCommand, agents: [agent("site-a")], settings });
    await a.turn("go");
    expect(a.sandbox.envs[0]).toMatchObject({ GSC: "synthetic-gsc-a" });
    // The value for all agents is not for the shell: site-c's commands get none.
    expect(settings.shellEnv("site-c")).not.toHaveProperty("GSC");

    // An agent is in at most one value of a name; one value per name is for all.
    expect(
      settings.saveVariable({ name: "GSC", value: "x", scope: ["site-c", "site-a"], shell: false }),
    ).toMatchObject({ message: "site-a already has its own value of GSC." });
    expect(
      settings.saveVariable({ name: "GSC", value: "x", scope: "all", shell: false }),
    ).toMatchObject({ message: "GSC already has a value for all agents." });

    // Sharing a value is editing it: its id, more agents, the value kept.
    const ofA = settings
      .variables()
      .find((v) => v.name === "GSC" && v.scope !== "all" && v.scope.includes("site-a"));
    if (!ofA) throw new Error("missing");
    expect(
      settings.saveVariable({
        id: ofA.id,
        name: "GSC",
        value: undefined,
        scope: ["site-a", "site-c"],
        shell: true,
      }),
    ).toBeUndefined();
    expect(settings.value("site-c", "GSC")).toBe("synthetic-gsc-a");
    expect(
      settings.saveVariable({
        id: ofA.id,
        name: "OTHER",
        value: undefined,
        scope: ["site-a"],
        shell: true,
      }),
    ).toMatchObject({ message: "A value cannot be moved from GSC to OTHER." });

    // Deleting one value leaves the others.
    expect(settings.deleteVariable(ofA.id)).toBe("GSC");
    expect(settings.value("site-a", "GSC")).toBe("synthetic-gsc-all");
    expect(settings.value("site-b", "GSC")).toBe("synthetic-gsc-b");
  });

  it("keeps the variables saved before a name could hold several values", () => {
    const dir = mkdtempSync(join(tmpdir(), "jabuti-c16-db-"));
    const key = randomBytes(32);
    // A value as the old table stored it: same cipher, the name as associated data.
    const freshDb = openDatabase(":memory:");
    new Settings(freshDb, key, {}).saveVariable({
      name: "OLD",
      value: "synthetic-old",
      scope: ["site-a"],
      shell: true,
    });
    const { value } = freshDb.prepare("SELECT value FROM variables").get() as { value: string };

    const old = new DatabaseSync(join(dir, "jabuti.db"));
    old.exec(`CREATE TABLE variables (name TEXT PRIMARY KEY, value TEXT NOT NULL,
      scope TEXT NOT NULL, shell INTEGER NOT NULL, updated_at TEXT NOT NULL);
      PRAGMA user_version = 8`);
    old
      .prepare("INSERT INTO variables VALUES ('OLD', ?, '[\"site-a\"]', 1, '2026-01-01T00:00:00Z')")
      .run(value);
    old.close();

    const settings = new Settings(openDatabase(join(dir, "jabuti.db")), key, {});
    expect(settings.value("site-a", "OLD")).toBe("synthetic-old");
    expect(settings.shellEnv("site-a")).toEqual({ OLD: "synthetic-old" });
    expect(settings.variables()[0]?.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("gives a subagent its own scope, not its parent's", async () => {
    const { settings } = settingsWith();
    const parent = agent("site-a", { tools: ["shell", "delegate"], subagents: ["analyst"] });
    const analyst = agent("analyst", { system: "You analyze." });
    const script: Script = (request) => {
      const done = request.messages.some((m) => m.parts.some((p) => p.type === "tool_result"));
      if (request.system === "You analyze.") {
        return done ? { text: "ok" } : { calls: [{ name: "shell", input: { command: "env" } }] };
      }
      return done
        ? { text: "ok" }
        : { calls: [{ name: "delegate", input: { agent: "analyst", task: "look" } }] };
    };
    const h = harness({ script, agents: [parent, analyst], settings });
    await h.turn("go");
    // In the parent's workspace, with the analyst's own variables.
    expect(h.sandbox.workspaces).toEqual(["site-a"]);
    expect(h.sandbox.envs).toEqual([{ SHARED: "synthetic-shared" }]);
  });

  it("stores values encrypted and never sends them to the UI", () => {
    const { db, settings } = settingsWith();
    const rows = db.prepare("SELECT value FROM variables").all() as { value: string }[];
    expect(JSON.stringify(rows)).not.toContain(A_TOKEN);

    const agents = new AgentRegistry([agent("site-a")]);
    const providers = Providers.withClients([FAKE_MODEL], []);
    const screen = snapshot({
      agents,
      providers,
      settings,
      connectors: [],
      skills: new Skills(),
      warnings: [],
      state: tempState(),
    });
    expect(JSON.stringify(screen)).not.toContain(A_TOKEN);
    expect(screen.variables.map((v) => v.name)).toContain("A_TOKEN");
  });

  it("names the variables each agent still lacks, with where to get them", () => {
    const { settings } = settingsWith();
    const agents = new AgentRegistry([
      agent("site-a", { mcp: ["speed"] }),
      agent("site-b", { mcp: ["speed"] }),
      agent("site-c"),
    ]);
    const state = tempState();
    const connectors = [
      {
        name: "speed",
        description: "Synthetic.",
        variables: ["B_TOKEN", "SPEED_KEY"],
        help: { SPEED_KEY: "Synthetic help." },
      },
    ];
    const deps = {
      agents,
      providers: Providers.withClients([FAKE_MODEL], []),
      settings,
      connectors,
      skills: new Skills(),
      warnings: [],
      state,
    };
    const known = () => snapshot(deps).knownVariables;
    expect(known()).toEqual([
      // site-b has its own B_TOKEN; site-a does not.
      { name: "B_TOKEN", usedBy: "the speed connector", help: "", missingFor: ["site-a"] },
      {
        name: "SPEED_KEY",
        usedBy: "the speed connector",
        help: "Synthetic help.",
        missingFor: ["site-a", "site-b"],
      },
    ]);
    settings.saveVariable({
      name: "SPEED_KEY",
      value: "synthetic",
      scope: ["site-a"],
      shell: false,
    });
    expect(known().find((k) => k.name === "SPEED_KEY")?.missingFor).toEqual(["site-b"]);
  });

  it("flags values the key can no longer decrypt, and never passes them", () => {
    const { db } = settingsWith();
    const other = new Settings(db, randomBytes(32), {});
    expect(other.variables().every((v) => v.problem !== undefined)).toBe(true);
    expect(other.shellEnv("site-a")).toEqual({});
  });

  it("refuses to pass a reserved name to the shell", () => {
    const { settings } = settingsWith();
    const problem = settings.saveVariable({ name: "PATH", value: "/x", scope: "all", shell: true });
    expect(problem?.nextStep).toBeTruthy();
    expect(settings.shellEnv("site-a")).not.toHaveProperty("PATH");
  });
});

describe("C16: settings apply without a restart", () => {
  it("makes a provider's models available once its key is saved", () => {
    const { settings } = settingsWith();
    const providers = Providers.fromKeys(CATALOG, (p) => settings.providerKey(p));
    expect(providers.list().every((m) => !m.available)).toBe(true);
    settings.saveProviderKey("anthropic", "synthetic-key");
    expect(providers.list().every((m) => m.available)).toBe(true);
    expect(settings.providerKeys(["anthropic"])).toEqual([
      { provider: "anthropic", source: "settings" },
    ]);
  });

  it("uses a replaced key from the next call on", () => {
    const { settings } = settingsWith();
    const providers = Providers.fromKeys(CATALOG, (p) => settings.providerKey(p));
    const model = CATALOG[0]?.id ?? "";
    settings.saveProviderKey("anthropic", "synthetic-key-1");
    const first = providers.resolve(model);
    settings.saveProviderKey("anthropic", "synthetic-key-2");
    const second = providers.resolve(model);
    if (!first.ok || !second.ok) throw new Error("expected both to resolve");
    expect(second.provider).not.toBe(first.provider);
  });

  it("lets a key from the environment win, read-only", () => {
    const { settings } = settingsWith({ anthropic: "synthetic-env-key" });
    expect(settings.saveProviderKey("anthropic", "other")?.nextStep).toBeTruthy();
    expect(settings.providerKey("anthropic")).toBe("synthetic-env-key");
  });

  it("creates, edits and deletes agent profiles on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "jabuti-c16-"));
    const templates = join(import.meta.dirname, "../agents");
    const agents = AgentRegistry.load(dir, templates);
    // First start: the repository's templates become the agents.
    expect(agents.list().map((a) => a.name)).toContain("assistant");

    const { settings } = settingsWith();
    const deps = {
      agents,
      providers: Providers.withClients(CATALOG, []),
      settings,
      connectors: [],
      skills: new Skills(),
      warnings: [],
      state: tempState(),
    };
    const profile = { ...agent("my-blog"), model: CATALOG[0]?.id ?? "" };
    expect(handleSettings({ type: "agent.save", profile, create: true }, deps).problem).toBe(
      undefined,
    );
    expect(agents.get("my-blog")?.description).toBe("my-blog agent");
    expect(readFileSync(join(dir, "my-blog", "system.md"), "utf8")).toBe("You are my-blog.");

    // An unknown model is refused before anything is written.
    const bad = { ...profile, model: "nope/model" };
    expect(
      handleSettings({ type: "agent.save", profile: bad, create: false }, deps).problem,
    ).toBeTruthy();

    // Edited by hand, then reloaded.
    const json = JSON.parse(readFileSync(join(dir, "my-blog", "agent.json"), "utf8")) as object;
    writeFileSync(
      join(dir, "my-blog", "agent.json"),
      JSON.stringify({ ...json, description: "edited" }),
    );
    handleSettings({ type: "agents.reload" }, deps);
    expect(agents.get("my-blog")?.description).toBe("edited");

    // Deleting keeps the brief.
    new AgentState(dir).writeBrief("my-blog", "synthetic brief");
    expect(handleSettings({ type: "agent.delete", name: "my-blog" }, deps).problem).toBe(undefined);
    expect(agents.get("my-blog")).toBe(undefined);
    expect(existsSync(join(dir, "my-blog", "brief.md"))).toBe(true);
  });
});

describe("C16: an agent changes agents only with the owner's approval", () => {
  const manager = agent("manager", { tools: ["agents"] });
  const blog = { ...agent("my-blog"), system: "You run my-blog." };

  function onDisk() {
    const dir = mkdtempSync(join(tmpdir(), "jabuti-c16-tool-"));
    const registry = AgentRegistry.load(dir, join(dir, "no-templates"));
    registry.save(manager, true);
    return { dir, registry };
  }

  const calls =
    (...inputs: object[]): Script =>
    (_, i) => {
      const input = inputs[i];
      return input ? { calls: [{ name: "agents", input }] } : { text: "ok" };
    };

  it("creates an agent after the owner approves a diff that names its variables", async () => {
    const { dir, registry } = onDisk();
    const { settings } = settingsWith();
    settings.saveVariable({
      name: "BLOG_TOKEN",
      value: "synthetic",
      scope: ["my-blog"],
      shell: true,
    });
    const h = harness({
      script: calls({ action: "create", profile: blog }),
      registry,
      settings,
    });
    await h.turn("create a blog agent");

    const requested = h.events.find((e) => e.type === "approval.requested");
    if (requested?.type !== "approval.requested" || requested.action.kind !== "file") {
      throw new Error("expected a file approval");
    }
    expect(requested.action.diff).toContain("+ You run my-blog.");
    expect(requested.action.notes).toEqual(
      expect.arrayContaining([expect.stringContaining("BLOG_TOKEN in its shell")]),
    );
    expect(readFileSync(join(dir, "my-blog", "system.md"), "utf8")).toBe("You run my-blog.");
    expect(registry.get("my-blog")).toBeDefined();
    expect(h.catalogChanges()).toBe(1);
  });

  it("writes nothing when the owner denies", async () => {
    const { dir, registry } = onDisk();
    const h = harness({
      script: calls({ action: "create", profile: blog }),
      registry,
      approvals: "deny",
    });
    await h.turn("create a blog agent");
    expect(existsSync(join(dir, "my-blog"))).toBe(false);
    expect(h.catalogChanges()).toBe(0);
  });

  it("never grants itself, nor edits an agent that has it", async () => {
    const { registry } = onDisk();
    const h = harness({
      script: calls(
        { action: "create", profile: { ...blog, tools: ["shell", "agents"] } },
        // Even when the edit also drops the tool, so the new profile alone looks harmless.
        {
          action: "update",
          profile: { ...manager, tools: ["shell"], budget: { maxSteps: 99, maxCostUsd: 99 } },
        },
      ),
      registry,
    });
    await h.turn("go");
    expect(h.events.some((e) => e.type === "approval.requested")).toBe(false);
    const results = h.events.filter((e) => e.type === "tool.finished");
    expect(results.map((r) => r.isError)).toEqual([true, true]);
    expect(registry.get("my-blog")).toBe(undefined);
    expect(registry.get("manager")?.budget.maxSteps).toBe(10);
  });

  it("is not available to a subagent", async () => {
    const parent = agent("parent", { tools: ["delegate"], subagents: ["helper"] });
    const helper = agent("helper", { tools: ["agents"], system: "You help." });
    const script: Script = (request) => {
      const done = request.messages.some((m) => m.parts.some((p) => p.type === "tool_result"));
      if (request.system === "You help." || done) return { text: "ok" };
      return { calls: [{ name: "delegate", input: { agent: "helper", task: "x" } }] };
    };
    const h = harness({ script, agents: [parent, helper] });
    await h.turn("go");
    const helperRequest = h.model.requests.find((r) => r.system === "You help.");
    expect((helperRequest?.tools as { name: string }[]).map((t) => t.name)).not.toContain("agents");
  });
});

describe("C16/C12: run hands a task to an agent in its own workspace", () => {
  const manager = agent("manager", { tools: ["agents", "shell"] });
  const site = agent("site-a", { system: "You run site-a." });

  function onDisk(...extra: ReturnType<typeof agent>[]) {
    const dir = mkdtempSync(join(tmpdir(), "jabuti-c16-run-"));
    const registry = AgentRegistry.load(dir, join(dir, "no-templates"));
    // The manager first: the harness opens the conversation with the first agent.
    for (const profile of [manager, site, ...extra]) registry.save(profile, true);
    return registry;
  }

  /** The manager runs site-a once; site-a runs one command. */
  const script: Script = (request) => {
    const done = request.messages.some((m) => m.parts.some((p) => p.type === "tool_result"));
    if (done) return { text: "ok" };
    if (request.system === "You run site-a.") {
      return { calls: [{ name: "shell", input: { command: "git clone x" } }] };
    }
    return {
      calls: [{ name: "agents", input: { action: "run", agent: "site-a", task: "clone" } }],
    };
  };

  it("works in that agent's workspace, with its variables, after the user approves", async () => {
    const { settings } = settingsWith();
    const registry = onDisk();
    const h = harness({ script, registry, settings });
    await h.turn("set up site-a");

    const requested = h.events.find((e) => e.type === "approval.requested");
    expect(requested?.type === "approval.requested" && requested.action).toMatchObject({
      kind: "run",
      agent: "site-a",
      task: "clone",
    });
    expect(h.sandbox.workspaces).toEqual(["site-a"]);
    expect(h.sandbox.envs).toEqual([{ A_TOKEN, SHARED: "synthetic-shared" }]);
    const child = h.model.requests.find((r) => r.system === "You run site-a.");
    expect((child?.tools as { name: string }[]).map((t) => t.name)).not.toContain("agents");
  });

  it("runs nothing when the user denies", async () => {
    const h = harness({ script, registry: onDisk(), approvals: "deny" });
    await h.turn("set up site-a");
    expect(h.sandbox.commands).toEqual([]);
  });

  it("never runs an agent that manages agents", async () => {
    const other = agent("other-manager", { tools: ["agents"] });
    const h = harness({
      script: (_, i) =>
        i === 0
          ? {
              calls: [
                {
                  name: "agents",
                  input: { action: "run", agent: "other-manager", task: "x" },
                },
              ],
            }
          : { text: "ok" },
      registry: onDisk(other),
    });
    await h.turn("go");
    expect(h.events.some((e) => e.type === "approval.requested")).toBe(false);
  });

  it("writes a new agent's brief with its profile, shown in the same diff", async () => {
    const registry = onDisk();
    const state = new AgentState(mkdtempSync(join(tmpdir(), "jabuti-c16-brief-")));
    const blog = {
      ...agent("my-blog", { tools: ["shell", "memory"] }),
      system: "You run my-blog.",
    };
    const h = harness({
      script: (_, i) =>
        i === 0
          ? {
              calls: [
                {
                  name: "agents",
                  input: { action: "create", profile: blog, brief: "Site: synthetic.example" },
                },
              ],
            }
          : { text: "ok" },
      registry,
      state,
    });
    await h.turn("create it");
    const requested = h.events.find((e) => e.type === "approval.requested");
    expect(requested?.type === "approval.requested" && requested.action.kind === "file").toBe(true);
    if (requested?.type === "approval.requested" && requested.action.kind === "file") {
      expect(requested.action.diff).toContain("+ Site: synthetic.example");
    }
    expect(state.readBrief("my-blog")).toBe("Site: synthetic.example");
  });

  it("refuses a brief without the memory tool, or on update", async () => {
    const registry = onDisk();
    const state = new AgentState(mkdtempSync(join(tmpdir(), "jabuti-c16-brief-")));
    const noMemory = { ...agent("my-blog"), system: "x" };
    const h = harness({
      script: (_, i) => {
        const inputs = [
          { action: "create", profile: noMemory, brief: "b" },
          { action: "update", profile: site, brief: "b" },
        ];
        const input = inputs[i];
        return input ? { calls: [{ name: "agents", input }] } : { text: "ok" };
      },
      registry,
      state,
    });
    await h.turn("go");
    expect(h.events.some((e) => e.type === "approval.requested")).toBe(false);
    expect(state.readBrief("my-blog")).toBe("");
    expect(state.readBrief("site-a")).toBe("");
  });
});
