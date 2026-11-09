import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../packages/server/src/agents/registry.ts";
import { saveAgent } from "../packages/server/src/agents/save.ts";
import { AgentState } from "../packages/server/src/agents/state.ts";
import { openDatabase } from "../packages/server/src/db/index.ts";
import { Providers } from "../packages/server/src/providers/index.ts";
import { Settings } from "../packages/server/src/settings/index.ts";
import { Skills } from "../packages/server/src/skills/index.ts";
import { handleSettings, snapshot } from "../packages/server/src/ws/settings.ts";
import { FAKE_MODEL } from "./fake-model/index.ts";
import type { Script } from "./fake-model/index.ts";
import { agent, harness } from "./harness.ts";

// C4: the system prompt lists only the name and description of each enabled skill; a
// skill's body enters the context only when the skill is loaded.
const BODY = "Step 1: synthetic-method-body.";
const skills = () =>
  new Skills([
    { name: "data-study", description: "Publish a study.", source: "built-in", body: BODY },
    { name: "other", description: "Not this agent's.", source: "built-in", body: "other-body" },
  ]);
const studious = agent("studious", { skills: ["data-study"] });

const loads =
  (name: string): Script =>
  (_, i) =>
    i === 0 ? { calls: [{ name: "skill", input: { name } }] } : { text: "ok" };

const names = (tools: unknown) => (tools as { name: string }[]).map((t) => t.name);

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "jabuti-skills-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe("C4: skills are listed by name and description, loaded on demand", () => {
  it("lists only the agent's skills, never a body, until one is loaded", async () => {
    const h = harness({ script: loads("data-study"), agents: [studious], skills: skills() });
    await h.turn("write a study");
    const [first, second] = h.model.requests;
    expect(first?.system).toContain("- data-study: Publish a study.");
    expect(first?.system).not.toContain("other");
    expect(JSON.stringify(first)).not.toContain(BODY);
    expect(names(first?.tools)).toContain("skill");
    // Loaded: the body is in the tool result, and the prefix did not change (C7).
    expect(JSON.stringify(second?.messages)).toContain(BODY);
    expect(second?.system).toBe(first?.system);
    expect(JSON.stringify(second?.tools)).toBe(JSON.stringify(first?.tools));
  });

  it("loads no skill the agent's profile does not name", async () => {
    const h = harness({ script: loads("other"), agents: [studious], skills: skills() });
    await h.turn("go");
    const result = h.events.find((e) => e.type === "tool.finished");
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(h.model.requests)).not.toContain("other-body");
  });

  it("adds nothing for an agent without skills", async () => {
    const plain = agent("plain");
    const h = harness({ script: () => ({ text: "ok" }), agents: [plain], skills: skills() });
    await h.turn("hi");
    expect(h.model.requests[0]?.system).toBe(plain.system);
    expect(names(h.model.requests[0]?.tools)).not.toContain("skill");
  });

  it("reads skills from disk: the owner's replaces a built-in, a broken one is reported", async () => {
    const builtIn = folder({
      "data-study/SKILL.md": "---\ndescription: Built-in study.\n---\nBuilt-in body.",
      "broken/SKILL.md": "No front matter.",
    });
    const owner = folder({
      "data-study/SKILL.md": '---\nname: x\ndescription: "Owner study."\n---\n\nOwner body.\n',
    });
    const fromDisk = new Skills([], { builtIn, owner });
    expect(fromDisk.list()).toEqual([
      { name: "data-study", description: "Owner study.", source: "owner" },
    ]);
    expect(fromDisk.load().problems).toEqual([
      expect.objectContaining({ message: expect.stringContaining("broken") as unknown }),
    ]);

    // A listed skill that is gone: shown, and the agent works without it.
    const gone = agent("gone", { skills: ["data-study", "missing"] });
    const h = harness({ script: loads("data-study"), agents: [gone], skills: fromDisk });
    await h.turn("go");
    expect(h.model.requests[0]?.system).toContain("- data-study: Owner study.");
    expect(JSON.stringify(h.model.requests[1]?.messages)).toContain("Owner body.");
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: "notice",
        problem: expect.objectContaining({
          message: expect.stringContaining('"missing"') as unknown,
        }) as unknown,
      }),
    );
  });

  it("refuses to save a profile naming a skill that does not exist", () => {
    const deps = {
      agents: new AgentRegistry([studious]),
      providers: Providers.withClients([FAKE_MODEL], []),
      connectors: [],
      skills: skills().list(),
    };
    expect(saveAgent(deps, { ...studious, skills: ["nope"] }, false)).toMatchObject({
      message: 'Unknown skill "nope".',
    });
  });
});

describe("C4: skills are written by the owner, or by the agents tool on approval", () => {
  const dirs = () => ({
    builtIn: folder({ "data-study/SKILL.md": "---\ndescription: Built-in.\n---\nBuilt-in body." }),
    owner: mkdtempSync(join(tmpdir(), "jabuti-owner-skills-")),
  });
  const deps = (skills: Skills, agents: AgentRegistry) => ({
    agents,
    providers: Providers.withClients([FAKE_MODEL], []),
    settings: new Settings(openDatabase(":memory:"), randomBytes(32), {}),
    connectors: [],
    skills,
    warnings: [],
    state: new AgentState(mkdtempSync(join(tmpdir(), "jabuti-state-"))),
  });

  it("lets the owner create, edit, adapt a built-in and delete, from Settings", () => {
    const skills = new Skills([], dirs());
    const user = agent("user", { skills: ["mine"] });
    const d = deps(skills, new AgentRegistry([user]));
    const save = (name: string, body: string, create: boolean) =>
      handleSettings(
        { type: "skill.save", skill: { name, description: `${name} method.`, body }, create },
        d,
      );
    expect(save("mine", "First.", true).problem).toBeUndefined();
    expect(save("mine", "Again.", true).problem?.message).toContain("already exists");
    expect(save("mine", "Second.", false).problem).toBeUndefined();
    expect(skills.get("mine")).toMatchObject({ body: "Second.", source: "owner" });
    // The owner's version of a built-in, and back.
    expect(save("data-study", "Adapted.", true).problem).toBeUndefined();
    expect(snapshot(d).skills.find((s) => s.name === "data-study")).toMatchObject({
      body: "Adapted.",
      replacesBuiltIn: true,
    });
    expect(handleSettings({ type: "skill.delete", name: "data-study" }, d).problem).toBeUndefined();
    expect(skills.get("data-study")).toMatchObject({ body: "Built-in body.", source: "built-in" });
    expect(handleSettings({ type: "skill.delete", name: "data-study" }, d).problem).toBeDefined();
    // Not while an agent uses it.
    expect(handleSettings({ type: "skill.delete", name: "mine" }, d).problem?.message).toContain(
      "user",
    );
    expect(skills.get("mine")).toBeDefined();
  });

  it("saves an agent's skill only after the owner approves its diff", async () => {
    const manager = agent("manager", { tools: ["agents"] });
    const writer =
      (name: string): Script =>
      (_, i) =>
        i === 0
          ? {
              calls: [
                {
                  name: "agents",
                  input: {
                    action: "save_skill",
                    skill: { name, description: "Synthetic method.", body: "Do the steps." },
                  },
                },
              ],
            }
          : { text: "ok" };
    for (const approvals of ["deny", "approve"] as const) {
      const skills = new Skills([], dirs());
      const h = harness({ script: writer("new-method"), agents: [manager], skills, approvals });
      await h.turn("save it");
      expect(h.events).toContainEqual(
        expect.objectContaining({
          type: "approval.requested",
          action: expect.objectContaining({
            kind: "file",
            file: "skill new-method (new)",
            diff: expect.stringContaining("+ Do the steps.") as unknown,
          }) as unknown,
        }),
      );
      expect(skills.get("new-method")?.body ?? null).toBe(
        approvals === "approve" ? "Do the steps." : null,
      );
    }

    // Never a skill an agent that manages agents uses: the owner alone shapes it.
    const skills = new Skills([], dirs());
    const self = agent("self", { tools: ["agents"], skills: ["data-study"] });
    const h = harness({ script: writer("data-study"), agents: [self], skills });
    await h.turn("change it");
    expect(h.events.some((e) => e.type === "approval.requested")).toBe(false);
    expect(skills.get("data-study")?.source).toBe("built-in");
  });
});
