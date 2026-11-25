import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agent, harness } from "./harness.ts";

// C3: the workspace is where commands start, and ~. Its absolute path differs: /workspace
// in the local container, /workspaces/<agent> in the runner. A prompt or tool that names
// one sends the model to a folder the other sandbox does not have ("can't cd to
// /workspace", deployed).
const FIXED_PATH = /\/workspaces?\b/;
const AGENTS = join(import.meta.dirname, "..", "agents");

describe("C3: what the model reads names the workspace only as ~ or relative paths", () => {
  it("in every built-in tool", async () => {
    const helper = agent("helper");
    const all = agent("all", {
      tools: [
        "shell",
        "packages",
        "web_read",
        "page_structure",
        "site_crawl",
        "view_images",
        "delegate",
        "memory",
        "plan",
      ],
      subagents: ["helper"],
    });
    const h = harness({ script: () => ({ text: "ok" }), agents: [all, helper] });
    await h.turn("hi");
    const request = h.model.requests[0];
    const tools = (request?.tools as { name: string }[]).map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["shell", "delegate", "view_images"]));
    expect(JSON.stringify(request?.tools)).not.toMatch(FIXED_PATH);
  });

  it("in every agent template", () => {
    for (const name of readdirSync(AGENTS)) {
      for (const file of ["system.md", "agent.json"]) {
        const text = readFileSync(join(AGENTS, name, file), "utf8");
        expect(text, `agents/${name}/${file}`).not.toMatch(FIXED_PATH);
      }
    }
  });
});
