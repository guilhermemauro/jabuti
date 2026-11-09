import { describe, expect, it } from "vitest";
import { ModelError } from "../packages/server/src/providers/types.ts";
import { agent, harness } from "./harness.ts";

describe("C11: every failure reaches the UI with a next step", () => {
  it("a model error ends the turn with a problem", async () => {
    const h = harness({
      script: () => {
        throw new ModelError("auth", "Anthropic rejected the API key.", "Check ANTHROPIC_API_KEY.");
      },
    });
    const end = await h.turn("hi");
    expect(end).toMatchObject({
      reason: "error",
      problem: { message: "Anthropic rejected the API key.", nextStep: "Check ANTHROPIC_API_KEY." },
    });
  });

  it("an unexpected bug still ends the turn with a problem", async () => {
    const h = harness({
      script: () => {
        throw new TypeError("undefined is not a function");
      },
    });
    const end = await h.turn("hi");
    expect(end.reason).toBe("error");
    expect(end.problem?.nextStep).toBeTruthy();
  });

  it("budget stops and refusals carry a next step", async () => {
    const h = harness({
      script: () => ({ text: "no", stop: "refusal" }),
      agents: [agent("assistant")],
    });
    expect((await h.turn("hi")).problem?.nextStep).toBeTruthy();
  });

  it("a denied command is shown as a failed tool result", async () => {
    const h = harness({
      script: (_, i) =>
        i === 0 ? { calls: [{ name: "shell", input: { command: "x" } }] } : { text: "ok" },
      agents: [agent("assistant", { permissions: { shell: "ask" } })],
      approvals: "deny",
    });
    await h.turn("go");
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: "tool.finished", isError: true }),
    );
  });

  it("requests the runtime refuses come back as problems", () => {
    const h = harness({ script: () => ({ text: "ok" }) });
    expect(h.runtime.create("nope")).toHaveProperty("nextStep");
    expect(h.runtime.send("missing", "hi")?.nextStep).toBeTruthy();
    expect(h.runtime.respondApproval("missing", true)?.nextStep).toBeTruthy();
  });
});
