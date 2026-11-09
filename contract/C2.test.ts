import { describe, expect, it } from "vitest";
import { agent, harness, resultCounts } from "./harness.ts";

function expectEveryCallAnsweredOnce(h: ReturnType<typeof harness>) {
  const counts = resultCounts(h.history());
  expect(counts.size).toBeGreaterThan(0);
  for (const [, n] of counts) expect(n).toBe(1);
}

const once = (reply: object) => (_: unknown, i: number) => (i === 0 ? reply : { text: "ok" });

describe("C2: every tool call receives exactly one tool result", () => {
  it("on success, for parallel calls", async () => {
    const h = harness({
      script: once({
        calls: [
          { name: "shell", input: { command: "a" } },
          { name: "shell", input: { command: "b" } },
        ],
      }),
    });
    await h.turn("go");
    expectEveryCallAnsweredOnce(h);
    // Both results travel in one user message.
    const resultMessages = h.history().filter((m) => m.parts.some((p) => p.type === "tool_result"));
    expect(resultMessages).toHaveLength(1);
  });

  it("on a tool error, an unknown tool and invalid input", async () => {
    const h = harness({
      script: once({
        calls: [
          { name: "shell", input: { command: "boom" } },
          { name: "no_such_tool", input: {} },
          { name: "shell", input: { cmd: "wrong field" } },
        ],
      }),
    });
    h.sandbox.next = () => {
      throw new Error("container died");
    };
    await h.turn("go");
    expectEveryCallAnsweredOnce(h);
    const results = h.history().flatMap((m) => m.parts.filter((p) => p.type === "tool_result"));
    expect(results.every((r) => r.isError)).toBe(true);
  });

  it("on timeout", async () => {
    const h = harness({
      script: once({ calls: [{ name: "shell", input: { command: "sleep 999" } }] }),
    });
    h.sandbox.next = () => ({ exitCode: 137, output: "", timedOut: true });
    await h.turn("go");
    expectEveryCallAnsweredOnce(h);
  });

  it("on user denial", async () => {
    const h = harness({
      script: once({ calls: [{ name: "shell", input: { command: "rm -rf /" } }] }),
      agents: [agent("assistant", { permissions: { shell: "ask" } })],
      approvals: "deny",
    });
    await h.turn("go");
    expectEveryCallAnsweredOnce(h);
    expect(h.sandbox.commands).toEqual([]);
  });

  it("on cancel while waiting for approval", async () => {
    const h = harness({
      script: once({
        calls: [
          { name: "shell", input: { command: "a" } },
          { name: "shell", input: { command: "b" } },
        ],
      }),
      agents: [agent("assistant", { permissions: { shell: "ask" } })],
      approvals: "wait",
    });
    h.runtime.send(h.conversationId, "go");
    await new Promise((r) => setTimeout(r, 10));
    h.runtime.cancel(h.conversationId);
    await h.runtime.idle(h.conversationId);
    expect(h.events.at(-1)).toMatchObject({ type: "turn.finished", reason: "cancelled" });
    expectEveryCallAnsweredOnce(h);
  });

  it("on a response cut off at max_tokens, without running the call", async () => {
    const h = harness({
      script: () => ({
        calls: [{ name: "shell", input: { command: "half" } }],
        stop: "max_tokens",
      }),
    });
    const end = await h.turn("go");
    expect(end.reason).toBe("max_tokens");
    expect(h.sandbox.commands).toEqual([]);
    expectEveryCallAnsweredOnce(h);
  });

  it("after the server died between a call and its result", async () => {
    const h = harness({ script: () => ({ text: "recovered" }) });
    h.store.append(h.conversationId, {
      role: "user",
      parts: [{ type: "text", text: "x" }],
      agent: "assistant",
    });
    h.store.append(h.conversationId, {
      role: "assistant",
      parts: [{ type: "tool_call", id: "orphan", name: "shell", input: { command: "x" } }],
      agent: "assistant",
      model: "fake/scripted",
    });
    expect((await h.turn("still there?")).reason).toBe("done");
    expectEveryCallAnsweredOnce(h);
  });
});
