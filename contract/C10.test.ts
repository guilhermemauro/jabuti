import { describe, expect, it } from "vitest";
import { harness } from "./harness.ts";

describe("C10: history is append-only", () => {
  it("keeps every earlier message, including provider records, byte-identical", async () => {
    const h = harness({
      script: (_, i) =>
        i % 2 === 0
          ? { calls: [{ name: "shell", input: { command: `c${String(i)}` } }] }
          : { text: `t${String(i)}` },
    });
    await h.turn("one");
    const before = h.history();
    await h.turn("two");
    const after = h.history();
    expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
    expect(after.length).toBeGreaterThan(before.length);
  });
});
