import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { JsonlTracer } from "../packages/server/src/tracer/index.ts";
import { harness } from "./harness.ts";

const dir = mkdtempSync(join(tmpdir(), "jabuti-c8-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("C8: every step appends one JSONL line to the conversation trace", () => {
  it("records tokens, tool calls, truncated results, output, cost and duration", async () => {
    const h = harness({
      tracer: new JsonlTracer(dir),
      script: (_, i) =>
        i === 0 ? { calls: [{ name: "shell", input: { command: "big" } }] } : { text: "summary" },
    });
    h.sandbox.next = () => ({ exitCode: 0, output: "x".repeat(10_000), timedOut: false });
    await h.turn("go");

    const lines = readFileSync(join(dir, `${h.conversationId}.jsonl`), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    const [first, second] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(first).toMatchObject({
      step: 0,
      inputTokens: 100,
      outputTokens: 10,
      toolCalls: [{ name: "shell", input: { command: "big" } }],
    });
    expect(typeof first?.["costUsd"]).toBe("number");
    expect(typeof first?.["durationMs"]).toBe("number");
    const results = first?.["toolResults"] as { content: string }[];
    expect(results[0]?.content.length).toBeLessThan(2_100);
    expect(second).toMatchObject({ step: 1, output: "summary", toolCalls: [] });
  });
});
