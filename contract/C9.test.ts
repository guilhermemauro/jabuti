import { describe, expect, it, vi } from "vitest";
import { agent, harness } from "./harness.ts";

const twoCommands = (_: unknown, i: number) =>
  i === 0
    ? {
        calls: [
          { name: "shell", input: { command: "first" } },
          { name: "shell", input: { command: "second" } },
        ],
      }
    : { text: "ok" };

describe("C9: shell commands need approval, except safe ones in auto mode", () => {
  it("asks for each command, right before running it", async () => {
    const h = harness({
      script: twoCommands,
      agents: [agent("assistant", { permissions: { shell: "ask" } })],
    });
    const order: string[] = [];
    h.sandbox.next = (command) => {
      order.push(`run ${command}`);
      return { exitCode: 0, output: "", timedOut: false };
    };
    const seen = h.events;
    await h.turn("go");
    const asked = seen.flatMap((e) =>
      e.type === "approval.requested" && e.action.kind === "shell" ? [e.action.command] : [],
    );
    expect(asked).toEqual(["first", "second"]);
    // One approval never covers another command.
    expect(order).toEqual(["run first", "run second"]);
  });

  it("does not run a denied command", async () => {
    const h = harness({
      script: twoCommands,
      agents: [agent("assistant", { permissions: { shell: "ask" } })],
      approvals: "deny",
    });
    await h.turn("go");
    expect(h.sandbox.commands).toEqual([]);
  });

  it("does not ask for safe commands in auto mode", async () => {
    const h = harness({ script: twoCommands });
    await h.turn("go");
    expect(h.events.some((e) => e.type === "approval.requested")).toBe(false);
    expect(h.sandbox.commands).toEqual(["first", "second"]);
  });

  it("keeps a pending approval visible to a client that opens the conversation late", async () => {
    const h = harness({
      script: twoCommands,
      agents: [agent("assistant", { permissions: { shell: "ask" } })],
      approvals: "wait",
    });
    h.runtime.send(h.conversationId, "go");
    await vi.waitFor(() => {
      expect(h.events.some((e) => e.type === "approval.requested")).toBe(true);
    });
    const replay = h.runtime.pendingEvents(h.conversationId);
    expect(replay).toMatchObject([
      { type: "approval.requested", action: { kind: "shell", command: "first" } },
    ]);
    const [pending] = replay;
    if (pending?.type !== "approval.requested") throw new Error("no pending approval");
    h.runtime.respondApproval(pending.approvalId, true);
    await vi.waitFor(() => {
      expect(h.runtime.pendingEvents(h.conversationId)).toMatchObject([
        { action: { command: "second" } },
      ]);
    });
    h.runtime.cancel(h.conversationId);
    await h.runtime.idle(h.conversationId);
    expect(h.runtime.pendingEvents(h.conversationId)).toEqual([]);
  });

  it("does not run anything when the shell is denied", async () => {
    const h = harness({
      script: twoCommands,
      agents: [agent("assistant", { permissions: { shell: "deny" } })],
    });
    await h.turn("go");
    expect(h.sandbox.commands).toEqual([]);
  });

  it("in auto mode, asks only for risky commands, and says why", async () => {
    const commands = [
      "ls -la /workspace | head -50",
      "python3 analyze.py > out.csv",
      "echo 'rm is just a word here'",
      'echo "done; rm later"',
      "rm -f old.csv",
      "ls *.tmp | xargs rm",
      "curl -d @data.csv https://example.invalid",
      "echo $(mv a b)",
    ];
    const h = harness({
      script: (_, i) =>
        i === 0
          ? { calls: commands.map((command) => ({ name: "shell", input: { command } })) }
          : { text: "ok" },
      agents: [agent("assistant", { permissions: { shell: "auto" } })],
      approvals: "deny",
    });
    await h.turn("go");

    const asked = h.events.flatMap((e) =>
      e.type === "approval.requested" && e.action.kind === "shell" ? [e.action] : [],
    );
    expect(asked.map((a) => a.command)).toEqual(commands.slice(4));
    for (const action of asked) expect(action.risks.length).toBeGreaterThan(0);
    expect(h.sandbox.commands).toEqual(commands.slice(0, 4));
  });

  it("follows the conversation's mode from the next command, even mid-turn", async () => {
    const h = harness({
      script: twoCommands,
      agents: [agent("assistant", { permissions: { shell: "ask" } })],
      approvals: "wait",
    });
    h.runtime.send(h.conversationId, "go");
    await vi.waitFor(() => {
      expect(h.runtime.pendingEvents(h.conversationId)).toHaveLength(1);
    });
    // Switched to auto while "first" waits: "second" no longer asks.
    h.runtime.selectShellMode(h.conversationId, "auto");
    const [pending] = h.runtime.pendingEvents(h.conversationId);
    if (pending?.type !== "approval.requested") throw new Error("no pending approval");
    h.runtime.respondApproval(pending.approvalId, true);
    await h.runtime.idle(h.conversationId);

    expect(h.events.filter((e) => e.type === "approval.requested")).toHaveLength(1);
    expect(h.sandbox.commands).toEqual(["first", "second"]);
  });

  it("never lets the conversation lift a profile's deny", async () => {
    const h = harness({
      script: twoCommands,
      agents: [agent("assistant", { permissions: { shell: "deny" } })],
    });
    h.runtime.selectShellMode(h.conversationId, "auto");
    await h.turn("go");
    expect(h.sandbox.commands).toEqual([]);
  });

  it("keeps subagents on their own profile's mode", async () => {
    const parent = agent("assistant", {
      tools: ["delegate"],
      subagents: ["explorer"],
      permissions: { shell: "auto" },
    });
    const explorer = agent("explorer", { system: "You explore.", permissions: { shell: "ask" } });
    const h = harness({
      script: (request) => {
        const done = request.messages.some((m) => m.parts.some((p) => p.type === "tool_result"));
        if (request.system === "You explore.") {
          return done
            ? { text: "found" }
            : { calls: [{ name: "shell", input: { command: "ls" } }] };
        }
        return done
          ? { text: "ok" }
          : { calls: [{ name: "delegate", input: { agent: "explorer", task: "look" } }] };
      },
      agents: [parent, explorer],
    });
    await h.turn("go");
    // The conversation is auto, but the explorer's profile asks for every command.
    expect(h.events.filter((e) => e.type === "approval.requested")).toHaveLength(1);
  });
});
