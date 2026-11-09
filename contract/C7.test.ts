import { describe, expect, it } from "vitest";
import { agent, harness } from "./harness.ts";

describe("C7: the request prefix is byte-identical across steps", () => {
  it("keeps system prompt and tool definitions identical within and across turns", async () => {
    const h = harness({
      script: (_, i) =>
        i % 3 === 2 ? { text: "done" } : { calls: [{ name: "shell", input: { command: "x" } }] },
      agents: [
        agent("assistant", { tools: ["shell", "delegate"], subagents: ["helper"] }),
        agent("helper"),
      ],
    });
    await h.turn("one");
    await h.turn("two");
    expect(h.model.requests.length).toBe(6);
    const prefixes = h.model.requests.map((r) => JSON.stringify([r.system, r.tools]));
    expect(new Set(prefixes).size).toBe(1);
  });

  it("keeps earlier messages as an exact prefix of each later request", async () => {
    const h = harness({
      script: (_, i) =>
        i < 2 ? { calls: [{ name: "shell", input: { command: "x" } }] } : { text: "done" },
    });
    await h.turn("go");
    const [a, b, c] = h.model.requests.map((r) => r.messages as unknown[]);
    expect(b?.slice(0, a?.length)).toEqual(a);
    expect(c?.slice(0, b?.length)).toEqual(b);
  });
});
