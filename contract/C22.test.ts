// C22: a template update replaces an agent's file only where the owner never changed it;
// a file they changed is offered as a diff, applied or kept on their answer.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRegistry } from "../packages/server/src/agents/registry.ts";

const JSON_V1 = {
  description: "Synthetic site agent.",
  model: "fake/model",
  budget: { maxSteps: 10, maxCostUsd: 1 },
  tools: ["shell"],
  permissions: { shell: "ask" },
};

function setup() {
  const root = mkdtempSync(join(tmpdir(), "jabuti-c22-"));
  const templates = join(root, "templates");
  const data = join(root, "data");
  const template = (system: string, json: object = JSON_V1) => {
    mkdirSync(join(templates, "site"), { recursive: true });
    writeFileSync(join(templates, "site", "system.md"), system);
    writeFileSync(join(templates, "site", "agent.json"), JSON.stringify(json));
  };
  const onDisk = (name: string, file: string) => readFileSync(join(data, name, file), "utf8");
  const ownerEdits = (name: string, file: string, content: string) => {
    writeFileSync(join(data, name, file), content);
  };
  return { data, templates, template, onDisk, ownerEdits };
}

describe("C22 template updates", () => {
  it("updates untouched files, offers edited ones, and applies or keeps on the owner's answer", () => {
    const t = setup();
    t.template("Version 1.");
    AgentRegistry.load(t.data, t.templates); // first start: copied

    // Upgrade, owner never touched the agent: the new version is written, and said.
    t.template("Version 2.");
    let registry = AgentRegistry.load(t.data, t.templates);
    expect(t.onDisk("site", "system.md")).toBe("Version 2.");
    expect(registry.get("site")?.system).toBe("Version 2.");
    expect(registry.templateUpdates()).toEqual([
      expect.objectContaining({ agent: "site", file: "system.md", status: "applied" }),
    ]);

    // The owner edits the prompt and the model; the template changes both again.
    t.ownerEdits("site", "system.md", "Version 2, with my site's rules.");
    t.ownerEdits("site", "agent.json", JSON.stringify({ ...JSON_V1, model: "fake/mine" }));
    t.template("Version 3.", { ...JSON_V1, tools: ["shell", "web_read"] });
    registry = AgentRegistry.load(t.data, t.templates);
    expect(t.onDisk("site", "system.md")).toBe("Version 2, with my site's rules.");
    expect(registry.get("site")?.model).toBe("fake/mine");
    const offered = registry.templateUpdates();
    expect(offered.map((u) => [u.file, u.status])).toEqual([
      ["system.md", "available"],
      ["agent.json", "available"],
    ]);
    expect(offered[0]?.diff).toContain("- Version 2, with my site's rules.");
    expect(offered[0]?.diff).toContain("+ Version 3.");

    // Apply one, keep the other: neither is offered again, and nothing else changes.
    expect(registry.decideTemplate("site", "system.md", true)).toBeUndefined();
    expect(registry.decideTemplate("site", "agent.json", false)).toBeUndefined();
    expect(t.onDisk("site", "system.md")).toBe("Version 3.");
    expect(registry.get("site")?.model).toBe("fake/mine");
    expect(registry.get("site")?.tools).toEqual(["shell"]);
    expect(registry.templateUpdates()).toEqual([]);
    expect(AgentRegistry.load(t.data, t.templates).templateUpdates()).toEqual([]);

    // Kept settings still differ from the template: an update after that one is offered.
    t.template("Version 3.", { ...JSON_V1, tools: ["shell", "web_read", "memory"] });
    registry = AgentRegistry.load(t.data, t.templates);
    expect(registry.get("site")?.model).toBe("fake/mine");
    expect(registry.templateUpdates()).toEqual([
      expect.objectContaining({ file: "agent.json", status: "available" }),
    ]);
  });

  it("follows the template an agent was created from, under another name", () => {
    const t = setup();
    t.template("Version 1.");
    const registry = AgentRegistry.load(t.data, t.templates);
    const site = registry.get("site");
    if (!site) throw new Error("template not copied");
    expect(registry.save({ ...site, name: "my-blog", model: "fake/mine" }, true)).toBeUndefined();

    t.template("Version 2.");
    const after = AgentRegistry.load(t.data, t.templates);
    expect(after.get("my-blog")?.system).toBe("Version 2.");
    expect(after.get("my-blog")?.model).toBe("fake/mine");
    // A blank agent follows nothing.
    expect(
      after.save({ ...site, name: "blank", system: "Mine.", description: "Mine." }, true),
    ).toBeUndefined();
    t.template("Version 3.");
    expect(AgentRegistry.load(t.data, t.templates).get("blank")?.system).toBe("Mine.");
  });

  it("never overwrites an agent copied before origins were recorded", () => {
    const t = setup();
    t.template("Version 1.");
    AgentRegistry.load(t.data, t.templates);
    rmSync(join(t.data, "site", ".template.json"), { force: true }); // as an older Jabuti left it
    t.template("Version 2.");
    const registry = AgentRegistry.load(t.data, t.templates);
    expect(t.onDisk("site", "system.md")).toBe("Version 1.");
    expect(registry.templateUpdates()).toEqual([
      expect.objectContaining({ file: "system.md", status: "available" }),
    ]);
  });
});
