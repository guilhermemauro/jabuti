import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ToolName } from "@jabuti/protocol";
import { describe, expect, it } from "vitest";
import type { Script } from "./fake-model/index.ts";
import { agent, harness } from "./harness.ts";

// SDK package → the only directory allowed to import it.
const PROVIDER_SDKS: Record<string, string> = {
  "@anthropic-ai/sdk": "providers/anthropic/",
};

const SRC = join(import.meta.dirname, "../packages/server/src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("C13: a provider SDK is imported only by its own adapter", () => {
  it("keeps the loop provider-neutral", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const path = relative(SRC, file);
      const source = readFileSync(file, "utf8");
      for (const [sdk, home] of Object.entries(PROVIDER_SDKS)) {
        if (source.includes(`from "${sdk}`) && !path.startsWith(home)) {
          violations.push(`${path} imports ${sdk}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("C13: a conversation may run another model than its agent's", () => {
  it("uses the chosen model from the next turn, and records it on each turn", async () => {
    const h = harness({ script: () => ({ text: "ok" }) });
    await h.turn("one");
    expect(h.runtime.selectModel(h.conversationId, "fake/other")).toBeUndefined();
    await h.turn("two");
    expect(h.runtime.selectModel(h.conversationId, null)).toBeUndefined();
    await h.turn("three");

    expect(h.model.requests.map((r) => r.model)).toEqual(["scripted", "other", "scripted"]);
    const recorded = h.history().flatMap((m) => (m.role === "assistant" ? [m.model] : []));
    expect(recorded).toEqual(["fake/scripted", "fake/other", "fake/scripted"]);
  });

  it("keeps subagents on their own profile's model", async () => {
    const parent = agent("assistant", { tools: ["delegate"], subagents: ["explorer"] });
    const explorer = agent("explorer", { system: "You explore." });
    const script: Script = (request) => {
      const done = request.messages.some((m) => m.parts.some((p) => p.type === "tool_result"));
      if (request.system === "You explore.") return { text: "found" };
      return done
        ? { text: "ok" }
        : { calls: [{ name: "delegate", input: { agent: "explorer", task: "look" } }] };
    };
    const h = harness({ script, agents: [parent, explorer] });
    h.runtime.selectModel(h.conversationId, "fake/other");
    await h.turn("go");
    const child = h.model.requests.find((r) => r.system === "You explore.");
    expect(child?.model).toBe("scripted");
    expect(h.model.requests[0]?.model).toBe("other");
  });

  it("refuses an unknown model and keeps the current one", async () => {
    const h = harness({ script: () => ({ text: "ok" }) });
    expect(h.runtime.selectModel(h.conversationId, "nope/model")?.nextStep).toBeTruthy();
    await h.turn("hi");
    expect(h.model.requests[0]?.model).toBe("scripted");
  });
});

describe("C13: tool definitions are accepted by every provider", () => {
  it("gives each tool a plain object schema, with no union at the top level", async () => {
    const all = agent("all", {
      tools: [...ToolName.options],
      subagents: ["helper"],
    });
    const h = harness({ script: () => ({ text: "ok" }), agents: [all, agent("helper")] });
    await h.turn("hi");
    const tools = h.model.requests[0]?.tools as { name: string; inputSchema: object }[];
    expect(tools.map((t) => t.name).sort()).toEqual([...ToolName.options].sort());
    for (const tool of tools) {
      expect(tool.inputSchema, tool.name).toMatchObject({ type: "object" });
      for (const key of ["anyOf", "oneOf", "allOf"]) {
        expect(tool.inputSchema, `${tool.name}.${key}`).not.toHaveProperty(key);
      }
    }
  });
});
