import { describe, expect, it } from "vitest";
import { agent, harness } from "./harness.ts";

const shellForever = () => ({ calls: [{ name: "shell", input: { command: "echo hi" } }] });

describe("C1: the loop ends on a reply without tool calls, or on budget exhaustion", () => {
  it("ends when the model replies without a tool call", async () => {
    const h = harness({
      script: (_, i) => (i === 0 ? shellForever() : { text: "Done." }),
    });
    const end = await h.turn("hello");
    expect(end).toMatchObject({ reason: "done", steps: 2 });
    expect(h.model.requests).toHaveLength(2);
  });

  it("stops cleanly with a message when the step budget runs out", async () => {
    const h = harness({
      script: shellForever,
      agents: [agent("assistant", { budget: { maxSteps: 3, maxCostUsd: 100 } })],
    });
    const end = await h.turn("loop forever");
    expect(end.reason).toBe("budget_steps");
    expect(end.steps).toBe(3);
    expect(end.problem?.nextStep).toContain("Max steps per turn");
    // The conversation is still usable after a budget stop.
    h.model.requests.length = 0;
    expect((await h.turn("again")).reason).toBe("budget_steps");
  });

  it("stops cleanly with a message when the cost budget runs out", async () => {
    const h = harness({
      // 400k input tokens at $1/M = $0.40 per step.
      script: () => ({ ...shellForever(), usage: { inputTokens: 400_000 } }),
      agents: [agent("assistant", { budget: { maxSteps: 100, maxCostUsd: 1 } })],
    });
    const end = await h.turn("spend");
    expect(end.reason).toBe("budget_cost");
    expect(end.steps).toBe(3);
    expect(end.costUsd).toBeCloseTo(1.2 + 3 * 0.00001);
    expect(end.problem?.nextStep).toContain("Max cost per turn");
  });
});
