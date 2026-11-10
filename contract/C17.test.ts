import { describe, expect, it } from "vitest";
import type { Script } from "./fake-model/index.ts";
import { agent, harness } from "./harness.ts";

const installs =
  (packages: unknown): Script =>
  (_, i) =>
    i === 0 ? { calls: [{ name: "packages", input: { packages } }] } : { text: "ok" };

const toolNames = (tools: unknown) => (tools as { name: string }[]).map((t) => t.name);

const installer = agent("installer", {
  tools: ["shell", "packages"],
  permissions: { shell: "auto" },
});
const careful = agent("careful", { tools: ["shell", "packages"], permissions: { shell: "ask" } });

describe("C17: system packages are installed only by name, approved by the user in ask mode", () => {
  it("installs after approval in ask mode", async () => {
    const h = harness({ script: installs(["git", "ffmpeg"]), agents: [careful] });
    await h.turn("clone the repo");
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: "approval.requested",
        action: { kind: "packages", packages: ["git", "ffmpeg"] },
      }),
    );
    expect(h.sandbox.installs).toEqual([["git", "ffmpeg"]]);
  });

  it("installs nothing when the user denies", async () => {
    const h = harness({ script: installs(["git"]), agents: [careful], approvals: "deny" });
    await h.turn("clone the repo");
    expect(h.sandbox.installs).toEqual([]);
  });

  it("installs without asking in auto mode", async () => {
    const h = harness({ script: installs(["git"]), agents: [installer], approvals: "deny" });
    await h.turn("clone the repo");
    expect(h.events.some((e) => e.type === "approval.requested")).toBe(false);
    expect(h.sandbox.installs).toEqual([["git"]]);
  });

  it("refuses anything that is not a package name, before asking", async () => {
    for (const bad of ["git; id", "-o=APT::x", "$(id)", "../x", "Git"]) {
      const h = harness({ script: installs(["curl", bad]), agents: [installer] });
      await h.turn("go");
      expect(
        h.events.some((e) => e.type === "approval.requested"),
        bad,
      ).toBe(false);
      expect(h.sandbox.installs, bad).toEqual([]);
    }
  });

  it("is available only when listed, and only with a usable shell", async () => {
    const tools = async (profile: ReturnType<typeof agent>) => {
      const h = harness({ script: () => ({ text: "ok" }), agents: [profile] });
      await h.turn("hi");
      return toolNames(h.model.requests[0]?.tools);
    };
    expect(await tools(installer)).toContain("packages");
    // Switched off by the owner.
    expect(await tools(agent("a", { tools: ["shell"] }))).not.toContain("packages");
    // Listed, but without a shell to use what it installs.
    expect(await tools(agent("b", { tools: ["packages"] }))).not.toContain("packages");
    expect(
      await tools(agent("c", { tools: ["shell", "packages"], permissions: { shell: "deny" } })),
    ).not.toContain("packages");
  });

  it("is refused to a subagent whose caller has no shell (C12)", async () => {
    const parent = agent("parent", {
      tools: ["delegate"],
      subagents: ["helper"],
      permissions: { shell: "deny" },
    });
    const helper = agent("helper", { system: "You help.", tools: ["shell", "packages"] });
    const script: Script = (request) => {
      const done = request.messages.some((m) => m.parts.some((p) => p.type === "tool_result"));
      if (done) return { text: "ok" };
      if (request.system === "You help.") {
        return { calls: [{ name: "packages", input: { packages: ["git"] } }] };
      }
      return { calls: [{ name: "delegate", input: { agent: "helper", task: "x" } }] };
    };
    const h = harness({ script, agents: [parent, helper] });
    await h.turn("go");
    expect(h.events.some((e) => e.type === "approval.requested")).toBe(false);
    expect(h.sandbox.installs).toEqual([]);
  });
});
