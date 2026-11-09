import type { AssistantPart, UserPart } from "@jabuti/protocol";
import { describe, expect, it } from "vitest";
import type { Script } from "./fake-model/index.ts";
import { agent, harness, resultCounts } from "./harness.ts";

const assistant = agent("assistant", {
  tools: ["shell", "delegate"],
  permissions: { shell: "ask" },
  subagents: ["explorer"],
  budget: { maxSteps: 10, maxCostUsd: 1 },
});
const explorer = agent("explorer", { system: "You explore.", permissions: { shell: "auto" } });

// Parent delegates once, then answers. The explorer runs one command, then answers.
const script: Script = (request) => {
  const isExplorer = request.system === "You explore.";
  const sawResult = request.messages.some((m) => m.parts.some((p) => p.type === "tool_result"));
  if (isExplorer) {
    return sawResult
      ? { text: "found 3 files" }
      : { calls: [{ name: "shell", input: { command: "ls" } }] };
  }
  return sawResult
    ? { text: "The explorer says: found 3 files" }
    : { calls: [{ name: "delegate", input: { agent: "explorer", task: "count files" } }] };
};

describe("C12: delegate runs a subagent with its own profile and a fresh context", () => {
  it("returns the subagent's final answer as one tool result", async () => {
    const h = harness({ script, agents: [assistant, explorer] });
    const end = await h.turn("how many files?");
    expect(end.reason).toBe("done");

    const delegateResult = h
      .history()
      .flatMap<AssistantPart | UserPart>((m) => m.parts)
      .find((p) => p.type === "tool_result");
    expect(delegateResult).toMatchObject({ content: "found 3 files", isError: false });
    for (const [, n] of resultCounts(h.history())) expect(n).toBe(1);
  });

  it("gives the subagent a fresh context and its own tools", async () => {
    // The parent asks for every command, so its subagent does too (see below).
    const h = harness({ script, agents: [assistant, explorer] });
    await h.turn("how many files?");
    const child = h.model.requests.find((r) => r.system === "You explore.");
    expect(child?.messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "count files" }] },
    ]);
    // No nested delegation.
    expect((child?.tools as { name: string }[]).map((t) => t.name)).toEqual(["shell"]);
    expect(h.events.some((e) => e.type === "approval.requested")).toBe(true);
    expect(h.sandbox.commands).toEqual(["ls"]);
  });

  it("gives the subagent the caller's brief, read-only, and nothing else the caller keeps", async () => {
    const withBrief: Script = (request) => {
      const isExplorer = request.system.startsWith("You explore.");
      const sawResult = request.messages.some((m) => m.parts.some((p) => p.type === "tool_result"));
      if (isExplorer) return { text: "done" };
      return sawResult
        ? { text: "ok" }
        : { calls: [{ name: "delegate", input: { agent: "explorer", task: "write it" } }] };
    };
    const h = harness({ script: withBrief, agents: [assistant, explorer] });
    h.state.writeBrief("assistant", "Site: synthetic-shop.example. Tone: plain.");
    h.state.createNote(
      "assistant",
      { summary: "Synthetic private finding.", body: "" },
      { source: "chat" },
    );
    h.state.writeBrief("explorer", "The explorer's own brief.");
    await h.turn("delegate it");
    const child = h.model.requests.find((r) => r.system.startsWith("You explore."));
    expect(child?.system).toContain("Site: synthetic-shop.example. Tone: plain.");
    expect(child?.system).not.toContain("Synthetic private finding");
    expect(child?.system).not.toContain("The explorer's own brief");
    // Read-only: no tool to change it.
    expect((child?.tools as { name: string }[]).map((t) => t.name)).not.toContain("memory");
  });

  it("never lets a subagent delegate, even when its profile has the tool", async () => {
    const nested = agent("explorer", {
      system: "You explore.",
      tools: ["shell", "delegate"],
      subagents: ["assistant"],
    });
    const h = harness({ script, agents: [assistant, nested] });
    await h.turn("how many files?");
    const child = h.model.requests.find((r) => r.system === "You explore.");
    expect((child?.tools as { name: string }[]).map((t) => t.name)).toEqual(["shell"]);
  });

  it("keeps the subagent transcript out of the conversation history", async () => {
    const h = harness({ script, agents: [assistant, explorer] });
    await h.turn("how many files?");
    expect(h.history().every((m) => m.agent === "assistant")).toBe(true);
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: "subagent.finished", agent: "explorer", reason: "done" }),
    );
  });

  it("charges the subagent's steps to the parent's budget", async () => {
    const h = harness({ script, agents: [assistant, explorer] });
    const end = await h.turn("how many files?");
    // parent: delegate + answer; explorer: shell + answer.
    expect(end.steps).toBe(4);
  });

  it("refuses an agent that is not listed as a subagent", async () => {
    const h = harness({
      script: (_, i) =>
        i === 0
          ? { calls: [{ name: "delegate", input: { agent: "assistant", task: "x" } }] }
          : { text: "ok" },
      agents: [assistant, explorer],
    });
    await h.turn("go");
    const result = h
      .history()
      .flatMap<AssistantPart | UserPart>((m) => m.parts)
      .find((p) => p.type === "tool_result");
    expect(result).toMatchObject({ isError: true });
    expect(h.model.requests).toHaveLength(2);
  });
});

describe("C12: a subagent's shell is never looser than its caller's", () => {
  const parent = agent("parent", { tools: ["delegate"], subagents: ["helper"] });
  const helper = agent("helper", { system: "You help.", permissions: { shell: "auto" } });
  const script: Script = (request) => {
    const done = request.messages.some((m) => m.parts.some((p) => p.type === "tool_result"));
    if (done) return { text: "ok" };
    if (request.system === "You help.") {
      return { calls: [{ name: "shell", input: { command: "ls" } }] };
    }
    return { calls: [{ name: "delegate", input: { agent: "helper", task: "look" } }] };
  };

  it("asks when the conversation is set to ask, though the subagent's profile is auto", async () => {
    const h = harness({ script, agents: [parent, helper], approvals: "deny" });
    h.runtime.selectShellMode(h.conversationId, "ask");
    await h.turn("go");
    expect(h.events.some((e) => e.type === "approval.requested")).toBe(true);
    expect(h.sandbox.commands).toEqual([]);
  });

  it("runs nothing when the caller's shell is denied", async () => {
    const denied = { ...parent, permissions: { shell: "deny" as const } };
    const h = harness({ script, agents: [denied, helper] });
    await h.turn("go");
    expect(h.sandbox.commands).toEqual([]);
  });

  it("keeps the subagent's own stricter mode under an auto caller", async () => {
    const strict = { ...helper, permissions: { shell: "ask" as const } };
    const h = harness({ script, agents: [parent, strict], approvals: "deny" });
    await h.turn("go");
    expect(h.events.some((e) => e.type === "approval.requested")).toBe(true);
    expect(h.sandbox.commands).toEqual([]);
  });
});
