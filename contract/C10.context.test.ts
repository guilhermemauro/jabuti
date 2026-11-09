import type { LoopEvent } from "@jabuti/protocol";
import { describe, expect, it } from "vitest";
import type { ModelRequest } from "../packages/server/src/providers/types.ts";
import type { ContextTrace, StepTrace } from "../packages/server/src/tracer/index.ts";
import type { Script } from "./fake-model/index.ts";
import { harness, resultCounts } from "./harness.ts";

// C10: a long conversation's context is reduced by appending a mark, never by
// rewriting history. The fake model reports the sizes that trigger each reduction.
const BIG = "x".repeat(100_000);
const isSummary = (request: ModelRequest) => request.tools.length === 0;

function run(script: Script) {
  const contexts: ContextTrace[] = [];
  const steps: StepTrace[] = [];
  const h = harness({
    script,
    tracer: { step: (t) => steps.push(t), context: (t) => contexts.push(t) },
  });
  return { h, contexts, steps };
}

type Sent = { role: string; parts: { type: string; text?: string; content?: string }[] }[];
const sent = (h: ReturnType<typeof run>["h"], i: number) =>
  (h.model.requests[i]?.messages ?? []) as Sent;
const marks = (events: LoopEvent[]) =>
  events.flatMap((e) => (e.type === "message" && e.message.role === "context" ? [e.message] : []));

describe("C10: a long conversation's context is reduced without rewriting history", () => {
  it("clears old tool results first, each saved whole in the workspace, the recent ones kept", async () => {
    const { h, contexts } = run((_, i) =>
      i === 0
        ? { calls: [{ name: "shell", input: { command: "cat big.csv" } }] }
        : i === 1
          ? {
              calls: [{ name: "shell", input: { command: "cat other.csv" } }],
              usage: { inputTokens: 150_000 },
            }
          : { text: "done" },
    );
    h.sandbox.next = () => ({
      exitCode: 0,
      output: `${BIG}\n[Saved mcp/gsc/page.csv in your workspace: 501 lines.]`,
      timedOut: false,
    });
    await h.turn("go");

    const history = h.history();
    const path = `context/${h.conversationId}/call_0_0.txt`;
    const mark = history[5];
    expect(mark).toMatchObject({
      role: "context",
      mode: "clear",
      from: 3,
      cleared: 1,
      manual: false,
      saved: [{ callId: "call_0_0", path }],
    });
    // The whole result is in the agent's workspace, headed by the call that made it.
    expect(h.sandbox.files).toEqual([
      {
        workspace: "assistant",
        path,
        content: `Tool: shell\nInput: {"command":"cat big.csv"}\n\n${BIG}\n[Saved mcp/gsc/page.csv in your workspace: 501 lines.]\n[exit code 0]`,
      },
    ]);
    // History keeps the full result; only the model's view is reduced, naming the file.
    expect(JSON.stringify(history[2])).toContain(BIG);
    const view = sent(h, 2);
    const cleared = view[2]?.parts[0]?.content ?? "";
    expect(cleared).toMatch(/^\[Tool result cleared from the context/);
    expect(cleared).toContain(`It is saved whole in ${path} in your workspace`);
    expect(cleared).not.toContain("xxxx");
    expect(view[4]?.parts[0]?.content).toContain(BIG);
    expect(marks(h.events)).toHaveLength(1);
    expect(contexts).toMatchObject([{ mode: "clear", tokens: 150_010, costUsd: 0 }]);
  });

  it("clears nothing it could not save, and says so", async () => {
    const { h } = run((_, i) =>
      i === 0
        ? { calls: [{ name: "shell", input: { command: "cat big.csv" } }] }
        : i === 1
          ? {
              calls: [{ name: "shell", input: { command: "cat other.csv" } }],
              usage: { inputTokens: 150_000 },
            }
          : { text: "done" },
    );
    h.sandbox.next = () => ({ exitCode: 0, output: BIG, timedOut: false });
    h.sandbox.writeFile = () => Promise.reject(new Error("synthetic disk full"));
    await h.turn("go");
    expect(h.history().some((m) => m.role === "context")).toBe(false);
    expect(sent(h, 2)[2]?.parts[0]?.content).toContain(BIG);
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: "notice",
        problem: expect.objectContaining({
          message: expect.stringContaining("synthetic disk full") as unknown,
        }) as unknown,
      }),
    );
  });

  it("summarizes past the threshold, mid-turn, keeping the tail and every call with its result", async () => {
    const { h, contexts, steps } = run((request, i) => {
      if (isSummary(request)) {
        return {
          text: "## Goal\nSynthetic summary.",
          usage: { inputTokens: 5_000, outputTokens: 500 },
        };
      }
      if (i === 0) return { calls: [{ name: "shell", input: { command: "ls" } }] };
      if (i === 1) return { text: "first answer" };
      if (i === 2) {
        return {
          calls: [{ name: "shell", input: { command: "wc" } }],
          usage: { inputTokens: 250_000 },
        };
      }
      return { text: "second answer" };
    });
    await h.turn("one");
    const before = h.history();
    const finished = await h.turn("two");

    const after = h.history();
    expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
    const mark = after.find((m) => m.role === "context");
    expect(mark).toMatchObject({
      mode: "summary",
      from: 1,
      summary: "## Goal\nSynthetic summary.",
    });

    // The summarizer read the conversation as text, without tools.
    const asked = h.model.requests[3];
    expect(asked?.tools).toEqual([]);
    expect(JSON.stringify(asked?.messages)).toContain("User: one");

    // The next step sees the summary, then the messages from the cut, pairs intact.
    const view = sent(h, 4);
    expect(view[0]?.role).toBe("user");
    expect(view[0]?.parts[0]?.text).toContain("<conversation_summary>");
    expect(view[0]?.parts[0]?.text).toContain("Synthetic summary.");
    expect(JSON.stringify(view)).not.toContain('"text":"one"');
    const calls = view.flatMap((m) => m.parts.filter((p) => p.type === "tool_call"));
    const results = view.flatMap((m) => m.parts.filter((p) => p.type === "tool_result"));
    expect(calls).toHaveLength(2);
    expect(results).toHaveLength(2);
    for (const [, n] of resultCounts(after)) expect(n).toBe(1);

    // Its cost counts toward the turn and is traced; it is not a step.
    expect(finished.costUsd).toBeGreaterThanOrEqual(0.0055);
    expect(contexts[0]).toMatchObject({ mode: "summary", tokens: 250_010, costUsd: 0.0055 });
    expect(steps).toHaveLength(4);
  });

  it("summarizes when the owner asks, with a focus, saving the results it drops", async () => {
    let fail = false;
    const { h } = run((request, i) => {
      if (isSummary(request)) {
        if (fail) throw new Error("synthetic outage");
        return { text: "Synthetic focused summary." };
      }
      if (i === 0) return { calls: [{ name: "shell", input: { command: "cat serp.json" } }] };
      return { text: "ok" };
    });
    const LONG = "y".repeat(150_000);
    h.sandbox.next = () => ({ exitCode: 0, output: LONG, timedOut: false });
    expect(h.runtime.compact(h.conversationId)).toBeUndefined();
    await h.runtime.idle(h.conversationId);
    expect(h.events.at(-1)).toMatchObject({
      type: "notice",
      problem: { message: "Nothing to summarize yet: the conversation is short." },
    });

    await h.turn("one");
    await h.turn("two");
    h.runtime.compact(h.conversationId, "the covers");
    expect(h.runtime.busy(h.conversationId)).toBe(true);
    await h.runtime.idle(h.conversationId);
    const asked = JSON.stringify(h.model.requests.at(-1)?.messages);
    expect(asked).toContain("The user asks the summary to focus on: the covers");
    // The result it drops is saved whole, and the summarizer is told where.
    const path = `context/${h.conversationId}/call_0_0.txt`;
    expect(asked).toContain(`Tool result (saved whole in ${path})`);
    expect(asked).not.toContain(LONG);
    expect(h.sandbox.files.map((f) => f.path)).toEqual([path]);
    expect(h.history().at(-1)).toMatchObject({ saved: [{ callId: "call_0_0", path }] });
    expect(h.history().at(-1)).toMatchObject({
      role: "context",
      mode: "summary",
      manual: true,
      focus: "the covers",
      summary: "Synthetic focused summary.",
    });

    await h.turn("three");
    const view = sent(h, h.model.requests.length - 1);
    expect(view[0]?.parts[0]?.text).toContain("Synthetic focused summary.");
    expect(JSON.stringify(view)).not.toContain('"text":"one"');
    expect(JSON.stringify(view)).toContain('"text":"three"');

    // A failed summary is shown, and the conversation goes on as it was.
    fail = true;
    const count = h.history().length;
    h.runtime.compact(h.conversationId);
    await h.runtime.idle(h.conversationId);
    expect(h.history()).toHaveLength(count);
    expect(h.events.at(-1)).toMatchObject({
      type: "notice",
      problem: { message: "Could not summarize the conversation: synthetic outage" },
    });
  });
});
