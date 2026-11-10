import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentState } from "../packages/server/src/agents/state.ts";
import type { Script } from "./fake-model/index.ts";
import { agent, harness } from "./harness.ts";

// Synthetic fixtures only: no real site, repository or Search Console data.

const site = agent("site", { tools: ["shell", "plan", "memory"], permissions: { shell: "auto" } });

/** A clock the test moves; plans read today's date from it too. */
function clock(start = "2026-11-03T10:00:00Z") {
  const at = { now: new Date(start) };
  const dir = mkdtempSync(join(tmpdir(), "jabuti-c19-"));
  const state = new AgentState(dir, undefined, () => at.now.toISOString().slice(0, 10));
  return { at, dir, state, now: () => at.now };
}

/** Each request makes the next plan call; then it answers. */
const calls =
  (...inputs: object[]): Script =>
  (_, i) => {
    const input = inputs[i];
    return input ? { calls: [{ name: "plan", input }] } : { text: "Report: done." };
  };

const results = (h: ReturnType<typeof harness>) =>
  h.events.flatMap((e) => (e.type === "tool.finished" ? [e] : []));

const milestone = {
  op: "propose_milestone",
  title: "Quick wins",
  goal: "Raise clicks on existing pages",
  done_when: "4 pages changed and measured at +14 days",
  due: "2026-11-30",
};

const change = (urls: string[], kind = "title") => ({
  op: "propose_change",
  milestone: "M1",
  urls,
  kind,
  change: "Title with the year",
  hypothesis: "The year lifts CTR",
  metric: "CTR",
  baseline: "CTR 0.8%, GSC 28 days to 2026-11-01",
});

describe("C19: an agent works on a plan alone, within limits Jabuti enforces", () => {
  it("keeps milestones the owner approves, and refuses to change their goal or finish them unproven", async () => {
    const c = clock();
    const h = harness({
      script: calls(
        milestone,
        { op: "update_milestone", id: "M1", status: "running" },
        change(["/a"]),
      ),
      agents: [site],
      state: c.state,
      autopilot: { now: c.now },
    });
    await h.turn("draft a plan");
    const [proposed, early, beforeApproval] = results(h);
    expect(proposed?.isError).toBe(false);
    expect(early?.isError).toBe(true);
    expect(beforeApproval?.content).toContain("waiting for the owner");
    expect(c.state.plans.get("site").milestones[0]).toMatchObject({
      id: "M1",
      status: "proposed",
      createdBy: "agent",
    });

    // The owner approves it in the inbox.
    expect(
      await h.autopilot?.act("site", { op: "milestone.decide", id: "M1", approve: true }),
    ).toEqual({
      saved: "M1: approved.",
    });
    // The model cannot pass a goal or criterion to update_milestone: only the owner's screen can.
    const tool = (h.model.requests[0]?.tools as { name: string; inputSchema: object }[]).find(
      (t) => t.name === "plan",
    );
    expect(JSON.stringify(tool?.inputSchema)).toContain('"evidence"');

    const next = harness({
      script: calls(
        change(["https://synthetic.example/a/"]),
        { op: "update_milestone", id: "M1", status: "done" },
        { op: "update_milestone", id: "M1", status: "done", evidence: "4 pages, +14d CTR 1.2%" },
      ),
      agents: [site],
      state: c.state,
      autopilot: { now: c.now },
    });
    await next.turn("go");
    const [proposal, unproven, open] = results(next);
    expect(proposal?.content).toContain("Proposed e-0001");
    expect(unproven?.content).toContain("needs evidence");
    expect(open?.content).toContain("e-0001");
    const plan = c.state.plans.get("site");
    // Normalized to a path; the milestone started with its first change.
    expect(plan.experiments[0]?.urls).toEqual(["/a"]);
    expect(plan.milestones[0]?.status).toBe("running");
    expect(readFileSync(join(c.dir, "site", "plan.md"), "utf8")).toContain(
      "M1 Quick wins (in progress)",
    );
    expect(
      readFileSync(join(c.dir, "site", "plan.log.jsonl"), "utf8").split("\n").length,
    ).toBeGreaterThan(3);

    // The next conversation starts with the plan, and the shell cannot reach it.
    const third = harness({ script: () => ({ text: "ok" }), agents: [site], state: c.state });
    await third.turn("hi");
    const system = third.model.requests[0]?.system ?? "";
    expect(system).toContain("M1 Quick wins (in progress)");
    expect(system).toContain("e-0001 [M1, title] /a");
    expect(existsSync(join(c.dir, "site", "workspace", "plan.json"))).toBe(false);
  });

  it("locks pages being changed or measured, keeps controls unchanged, caps proposals and remembers rejections", async () => {
    const c = clock();
    c.state.plans.saveMilestone("site", undefined, {
      title: "Quick wins",
      goal: "g",
      doneWhen: "d",
    });
    c.state.plans.saveControls("site", ["/control"]);
    c.state.plans.saveLimits("site", {
      openProposals: 2,
      rejectCooldownDays: 30,
      checkDays: [3, 14],
    });
    const h = harness({
      script: calls(
        change(["/a"]),
        change(["/a/"]),
        change(["/control"]),
        change(["/b"]),
        change(["/c"]),
      ),
      agents: [site],
      state: c.state,
      autopilot: { now: c.now },
    });
    await h.turn("propose");
    const out = results(h).map((r) => [r.isError, r.content]);
    expect(out[0]?.[0]).toBe(false);
    expect(out[1]?.[1]).toContain("amend it instead");
    expect(out[2]?.[1]).toContain("control page");
    expect(out[3]?.[0]).toBe(false);
    expect(out[4]?.[1]).toContain("the limit");

    // Rejected with a reason: the same kind of change to that page waits, and the agent is told why.
    await h.autopilot?.act("site", {
      op: "experiment.decide",
      id: "e-0001",
      approve: false,
      reason: "Keep the brand first",
    });
    // Published by hand (no GitHub configured): live today, locked until its last check.
    await h.autopilot?.act("site", { op: "experiment.decide", id: "e-0002", approve: true });
    const again = harness({
      script: calls(change(["/a"]), change(["/b"], "faq"), change(["/a"], "faq")),
      agents: [site],
      state: c.state,
      autopilot: { now: c.now },
    });
    await again.turn("propose again");
    const [sameIdea, measured, otherKind] = results(again);
    expect(sameIdea?.content).toContain("Keep the brand first");
    expect(measured?.content).toContain("being measured until 2026-11-17");
    expect(otherKind?.isError).toBe(false);
    expect(again.model.requests[0]?.system).toContain("Rejected by the owner");
  });

  it("records a check only once it is due, and frees the page after the last", async () => {
    const c = clock();
    c.state.plans.saveMilestone("site", undefined, { title: "t", goal: "g", doneWhen: "d" });
    c.state.plans.saveLimits("site", {
      openProposals: 3,
      rejectCooldownDays: 30,
      checkDays: [3, 14],
    });
    const proposed = c.state.plans.proposeChange("site", {
      ...change(["/a"]),
      kind: "title",
    });
    expect("id" in proposed).toBe(true);
    c.state.plans.markLive("site", "e-0001");

    const record = { op: "record", id: "e-0001", result: "CTR 1.1% (GSC, 3 days)" };
    const h = harness({
      script: calls(record),
      agents: [site],
      state: c.state,
      autopilot: { now: c.now },
    });
    await h.turn("measure");
    expect(results(h)[0]?.content).toContain("on 2026-11-06");

    c.at.now = new Date("2026-11-06T10:00:00Z");
    const due = harness({ script: calls(record, record), agents: [site], state: c.state });
    await due.turn("measure");
    expect(due.model.requests[0]?.system).toContain("Checks due by today (2026-11-06)");
    const [first, second] = results(due);
    expect(first?.isError).toBe(false);
    expect(second?.content).toContain("on 2026-11-17");

    c.at.now = new Date("2026-11-17T10:00:00Z");
    const last = harness({
      script: calls(record, change(["/a"], "faq")),
      agents: [site],
      state: c.state,
    });
    await last.turn("measure");
    expect(results(last)[0]?.content).toContain("is done");
    expect(results(last)[1]?.isError).toBe(false);
  });

  it("works, in a routine, on the milestone Jabuti picks from the owner's priorities, and shows the agent only approved ones", async () => {
    const c = clock();
    const save = (title: string, priority: number, dependsOn: string[] = []) =>
      c.state.plans.saveMilestone("site", undefined, {
        title,
        goal: "g",
        doneWhen: "d",
        priority,
        dependsOn,
      });
    save("Guides", 3);
    save("Hub", 1, ["M1"]);
    save("Fixes", 2);
    const h = harness({
      script: (request, i) =>
        request.system.includes("# Your plan") && i === 0
          ? { calls: [{ name: "plan", input: { ...milestone, title: " guides " } }] }
          : { text: "Report." },
      agents: [site],
      state: c.state,
      autopilot: { now: c.now },
    });
    c.state.plans.proposeMilestone("site", { title: "Agent idea", goal: "g", doneWhen: "d" });

    const run = await h.autopilot?.act("site", { op: "run", kind: "act" });
    await h.runtime.idle(run?.conversationId ?? "");
    // M2 comes first but waits for M1: Jabuti starts M3, the next by priority, and names it.
    expect(c.state.plans.get("site").milestones.map((m) => m.status)).toEqual([
      "pending",
      "pending",
      "running",
      "proposed",
    ]);
    const request = h.model.requests[0];
    expect(JSON.stringify(request?.messages)).toContain("M3 (Fixes)");
    // Only approved milestones, each with what it means; the agent's own idea waits unseen.
    const system = request?.system ?? "";
    expect(system).toContain("M3 Fixes (in progress)");
    expect(system).toContain("M2 Hub (after M1)");
    expect(system).toContain("M1 Guides (approved, not started)");
    expect(system).not.toContain("Agent idea");
    expect(system).not.toContain("pending");
    // A title already in the plan is refused, so an idea the agent cannot see is not proposed twice.
    expect(results(h)[0]?.content).toContain("M1 already");

    // Nothing approved is ready: the run is told why and proposes nothing.
    const idle = clock();
    idle.state.plans.proposeMilestone("site", { title: "Idea", goal: "g", doneWhen: "d" });
    const quiet = harness({
      script: () => ({ text: "Report." }),
      agents: [site],
      state: idle.state,
      autopilot: { now: idle.now },
    });
    const none = await quiet.autopilot?.act("site", { op: "run", kind: "act" });
    await quiet.runtime.idle(none?.conversationId ?? "");
    expect(JSON.stringify(quiet.model.requests[0]?.messages)).toContain(
      "No approved milestone is open",
    );
    expect(idle.state.plans.get("site").milestones[0]?.status).toBe("proposed");
  });

  it("runs on its routine once a day, unattended: approvals refused at once, notes marked auto, a report kept", async () => {
    const c = clock("2026-11-03T07:59:00Z");
    // Ask mode: every command needs an approval nobody will give.
    const careful = { ...site, permissions: { shell: "ask" as const } };
    const script: Script = (request, i) => {
      if (!request.system.includes("# Your plan")) return { text: "ok" };
      const answered = request.messages.at(-1)?.parts.some((p) => p.type === "tool_result");
      if (answered && i % 3 === 2) return { text: "Report: measured nothing yet, no signal." };
      if (answered)
        return { calls: [{ name: "memory", input: { op: "create", summary: "Ran." } }] };
      return { calls: [{ name: "shell", input: { command: "curl https://synthetic.example" } }] };
    };
    const h = harness({
      script,
      agents: [careful],
      state: c.state,
      // "wait": an approval anyone waited for would hang this test.
      approvals: "wait",
      autopilot: { now: c.now },
    });
    c.state.plans.saveRoutine("site", {
      enabled: true,
      time: "08:00",
      timeZone: "UTC",
      actDays: ["tue"],
      monthlyCapUsd: 1,
    });
    expect(h.autopilot?.plans()[0]?.nextRun).toEqual({
      day: "2026-11-03",
      time: "08:00",
      kind: "act",
    });
    expect(await h.autopilot?.tick()).toEqual([]);

    c.at.now = new Date("2026-11-03T08:01:00Z");
    expect(await h.autopilot?.tick()).toEqual(["site"]);
    const plan = c.state.plans.get("site");
    expect(plan.decisions[0]?.summary).toContain("curl https://synthetic.example");
    expect(plan.runs[0]).toMatchObject({ kind: "act", reason: "done", read: false });
    expect(plan.runs[0]?.text).toContain("no signal");
    expect(c.state.notes("site")[0]?.source).toBe("auto");
    const run = h.store.get(plan.runs[0]?.conversation ?? "");
    expect(run).toMatchObject({ unattended: true, title: "Routine · act · 2026-11-03" });
    expect(h.sandbox.commands).toEqual([]);

    // Once a day; the next is tomorrow's, a measure day.
    expect(await h.autopilot?.tick()).toEqual([]);
    expect(h.autopilot?.plans()[0]?.nextRun).toEqual({
      day: "2026-11-04",
      time: "08:00",
      kind: "measure",
    });

    // The next run starts with the last reports in its prompt.
    c.at.now = new Date("2026-11-04T09:00:00Z");
    await h.autopilot?.tick();
    const prompts = h.model.requests.map((r) => r.system).filter((s) => s.includes("# Report of"));
    expect(prompts.at(-1)).toContain("no signal");

    // Past the monthly cap, it stops until next month.
    c.state.plans.addRun("site", {
      id: "spent",
      at: c.now().toISOString(),
      kind: "act",
      conversation: "x",
      costUsd: 5,
      reason: "done",
      text: "",
    });
    c.at.now = new Date("2026-11-05T09:00:00Z");
    expect(h.autopilot?.plans()[0]?.paused).toContain("cap");
    expect(await h.autopilot?.tick()).toEqual([]);
  });

  it("refuses an approval in a routine run, as nobody's answer, and asks again once the owner writes", async () => {
    const c = clock("2026-11-03T08:01:00Z");
    // Ask mode: the command waits for an approval nobody is there to give (C9).
    let pushes = 0;
    const script: Script = (request) => {
      if (!request.system.includes("# Your plan")) return { text: "ok" };
      return pushes++ < 1
        ? { calls: [{ name: "shell", input: { command: "git push -u origin seo/a" } }] }
        : { text: "Report." };
    };
    const h = harness({
      script,
      agents: [{ ...site, permissions: { shell: "ask" as const } }],
      state: c.state,
      approvals: "wait",
      autopilot: { now: c.now },
    });
    await h.autopilot?.act("site", { op: "run", kind: "act" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.sandbox.commands).toEqual([]);
    // The agent learns nobody was there, not that the owner said no.
    expect(results(h).find((r) => r.isError)?.content).toContain("routine run");

    // The owner answers in the routine's conversation: now someone is there to ask.
    const run = c.state.plans.get("site").runs[0]?.conversation ?? "";
    pushes = 0;
    expect(h.runtime.send(run, "Go on.", { owner: true })).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.store.get(run)?.unattended).toBe(false);
    const last = h.events.filter((e) => e.type.startsWith("approval.")).at(-1);
    expect(last?.type).toBe("approval.requested");
    h.runtime.cancel(run);
    await h.runtime.idle(run);
  });

  it("publishes with a deploy key only Jabuti holds: pushes on proposal, merges on approval, deletes on rejection", async () => {
    const c = clock();
    c.state.plans.saveMilestone("site", undefined, { title: "t", goal: "g", doneWhen: "d" });
    const github = { repo: "synthetic/site", base: "main", path: "repo" };
    c.state.plans.savePublish("site", { github });
    const h = harness({
      script: calls(
        change(["/a"]),
        { ...change(["/a"]), branch: "seo/a" },
        { ...change(["/b"]), branch: "seo/b" },
        { op: "amend", id: "e-0002", change: "Amended" },
        { op: "sync" },
      ),
      agents: [site],
      state: c.state,
      autopilot: { now: c.now },
    });
    await h.turn("propose");
    // Without a branch there is nothing to push.
    expect(results(h)[0]?.content).toContain("Commit the change on a branch");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const asked = () => h.sandbox.gits.map((g) => `${g.action} ${g.branch ?? g.base ?? ""}`);
    // Each proposal's branch is pushed by Jabuti, and again when amended.
    expect(asked()).toEqual(["push seo/a", "push seo/b", "push seo/b", "sync main"]);
    expect(h.sandbox.gits[0]).toEqual({
      workspace: "site",
      action: "push",
      repo: "synthetic/site",
      base: "main",
      branch: "seo/a",
      source: "repo",
    });
    expect(c.state.plans.get("site").experiments.map((e) => e.compare)).toEqual([
      "https://github.com/synthetic/site/compare/main...seo/a",
      "https://github.com/synthetic/site/compare/main...seo/b",
    ]);
    expect(results(h).at(-1)?.content).toContain("Merge or rebase your branches on origin/main");
    // The agent is told it cannot push, and how it gets main.
    expect(h.model.requests[0]?.system).toContain("Jabuti holds the deploy key: you cannot push");

    h.sandbox.gits.length = 0;
    expect(
      await h.autopilot?.act("site", { op: "experiment.decide", id: "e-0001", approve: true }),
    ).toMatchObject({ saved: expect.stringContaining("Merged seo/a into main") as string });
    expect(h.sandbox.gits[0]).toMatchObject({ action: "merge", branch: "seo/a", base: "main" });
    expect(h.sandbox.gits[0]?.message).toContain("Hypothesis");
    await h.autopilot?.act("site", {
      op: "experiment.decide",
      id: "e-0002",
      approve: false,
      reason: "Not now",
    });
    expect(h.sandbox.gits[1]).toMatchObject({ action: "delete", branch: "seo/b" });
    expect(c.state.plans.get("site").experiments.map((e) => e.status)).toEqual([
      "live",
      "rejected",
    ]);
  });

  it("keeps a proposal waiting when its branch cannot be pushed or merged, and says why", async () => {
    const c = clock();
    c.state.plans.saveMilestone("site", undefined, { title: "t", goal: "g", doneWhen: "d" });
    c.state.plans.savePublish("site", {
      github: { repo: "synthetic/site", base: "main", path: "repo" },
    });
    const h = harness({
      script: calls({ ...change(["/a"]), branch: "seo/a" }),
      agents: [site],
      state: c.state,
      autopilot: { now: c.now },
    });
    h.sandbox.gitNext = () => ({ ok: false, output: "Permission denied (publickey)." });
    await h.turn("propose");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(c.state.plans.get("site").experiments[0]?.issue).toContain("Permission denied");

    // Approving pushes again first; still refused, it stays proposed.
    const refused = await h.autopilot?.act("site", {
      op: "experiment.decide",
      id: "e-0001",
      approve: true,
    });
    expect(refused?.problem?.message).toContain("Permission denied");
    expect(c.state.plans.get("site").experiments[0]?.status).toBe("proposed");

    // Pushed now, but the merge conflicts: still proposed, with the reason.
    h.sandbox.gitNext = (r) =>
      r.action === "merge" ? { ok: false, output: "CONFLICT in a.ts" } : { ok: true, output: "" };
    const conflict = await h.autopilot?.act("site", {
      op: "experiment.decide",
      id: "e-0001",
      approve: true,
    });
    expect(conflict?.problem?.nextStep).toContain("plan sync");
    const e = c.state.plans.get("site").experiments[0];
    expect(e).toMatchObject({ status: "proposed", issue: "Not merged: CONFLICT in a.ts" });
  });

  it("makes the deploy key on request and records whether it reaches the repository", async () => {
    const c = clock();
    const h = harness({
      script: () => ({ text: "ok" }),
      agents: [site],
      state: c.state,
      autopilot: { now: c.now },
    });
    // No repository: nothing to test against.
    expect((await h.autopilot?.act("site", { op: "publish.test" }))?.problem).toBeDefined();
    expect(await h.autopilot?.act("site", { op: "publish.key" })).toMatchObject({
      saved: expect.any(String) as string,
    });
    expect(c.state.plans.get("site").deployKey).toEqual({
      publicKey: "ssh-ed25519 AAAAsynthetic jabuti-test",
      fingerprint: "SHA256:synthetic",
    });
    c.state.plans.savePublish("site", {
      github: { repo: "synthetic/site", base: "main", path: "repo" },
    });
    h.sandbox.gitNext = () => ({ ok: false, output: "Permission denied (publickey)." });
    expect((await h.autopilot?.act("site", { op: "publish.test" }))?.problem?.nextStep).toContain(
      "Allow write access",
    );
    expect(c.state.plans.get("site").deployKey?.problem).toContain("Permission denied");
    h.sandbox.gitNext = () => ({ ok: true, output: "Jabuti reaches the repository with its key." });
    await h.autopilot?.act("site", { op: "publish.test" });
    const key = c.state.plans.get("site").deployKey;
    expect(key?.checkedAt).toBe(c.now().toISOString());
    expect(key?.problem).toBeUndefined();
    expect(h.sandbox.gits.at(-1)).toEqual({
      workspace: "site",
      action: "test",
      repo: "synthetic/site",
    });
  });
});
