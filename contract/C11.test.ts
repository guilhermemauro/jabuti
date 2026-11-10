import { describe, expect, it } from "vitest";
import { ModelError } from "../packages/server/src/providers/types.ts";
import { Version } from "../packages/server/src/version/index.ts";
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

  it("a failed check for a new version keeps the last answer and says what happens next", async () => {
    let answer: Response = Response.json({
      tag_name: "v0.1.10",
      html_url: "https://github.com/synthetic/jabuti/releases/tag/v0.1.10",
      body: "- fix: something",
      published_at: "2026-11-10T00:00:00Z",
    });
    const urls: string[] = [];
    const version = new Version(
      {
        version: "v0.1.9",
        commit: "abcdef0123",
        repository: "synthetic/jabuti",
      },
      {
        fetch: (url) => {
          urls.push(url);
          return Promise.resolve(answer);
        },
      },
    );
    await version.check();
    expect(urls).toEqual(["https://api.github.com/repos/synthetic/jabuti/releases/latest"]);
    // Compared as numbers: v0.1.10 is newer than v0.1.9, not text order.
    expect(version.info()).toMatchObject({ current: "v0.1.9", commit: "abcdef0", newer: true });

    answer = new Response("rate limited", { status: 403 });
    await version.check();
    const info = version.info();
    expect(info.latest?.version).toBe("v0.1.10");
    expect(info.problem?.message).toContain("403");
    expect(info.problem?.nextStep).toContain("12 hours");

    // A repository with no release yet is not a failure.
    answer = new Response("Not Found", { status: 404 });
    await version.check();
    expect(version.info()).toMatchObject({ latest: null, problem: null, newer: false });

    // A build from source never asks GitHub.
    const dev = new Version({}, { fetch: () => Promise.reject(new Error("called")) });
    dev.start();
    expect(dev.info()).toMatchObject({ current: "dev", newer: false, checkedAt: null });
  });
});
