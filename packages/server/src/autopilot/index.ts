// The autopilot (C19): runs each agent with a plan on its routine, unattended, and
// carries out what the owner decides on the Plan and Inbox screens. The plan itself
// is written only by agents/plan.ts; this module decides when runs start, what
// they are told, and publishes approved changes.
//
// An unattended run never waits for the owner: an approval it asks for is refused
// at once and listed in the inbox (runtime.ts asks here). Its spend counts toward a
// monthly cap; past it, runs stop until the next month.
import { randomUUID } from "node:crypto";
import type {
  AgentPlan,
  ApprovalAction,
  Experiment,
  PlanAction,
  Problem,
  Weekday,
} from "@jabuti/protocol";
import type { AgentRegistry } from "../agents/registry.ts";
import type { AgentState } from "../agents/state.ts";
import type { Runtime } from "../loop/runtime.ts";
import type { GitRequest, GitResult, Sandbox } from "../sandbox/docker.ts";

const TICK_MS = 60_000;
const DRAFT_TASK =
  "Draft your plan. Read your brief and notes, and look at fresh data (such as Search " +
  "Console for the last 28 and 90 days) before proposing anything. Then propose 3 to 5 " +
  "milestones with the plan tool, ordered by impact over effort: each with a goal, a " +
  "measurable done-when criterion, a due date and what it depends on. Suggest 3 to 5 " +
  "control pages to leave unchanged, so experiments can be compared against them. End " +
  "with a short summary of the plan for me to approve in the Inbox.";

export interface AutopilotDeps {
  state: AgentState;
  agents: AgentRegistry;
  /** Where the agent's deploy key lives and its git runs (C19); no agent reads the key. */
  sandbox: Sandbox;
  now?: () => Date;
}

export interface AutopilotListener {
  plansChanged(plans: AgentPlan[]): void;
}

export interface ActionResult {
  problem?: Problem;
  saved?: string;
  /** A conversation the action started, for the client to open. */
  conversationId?: string;
}

export class Autopilot {
  private readonly deps: AutopilotDeps;
  private readonly listener: AutopilotListener;
  private runtime: Runtime | undefined;
  /** Agents with a run in progress: a slow run must not start a second one. */
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(deps: AutopilotDeps, listener: AutopilotListener) {
    this.deps = deps;
    this.listener = listener;
    deps.state.plans.onChange = () => {
      this.listener.plansChanged(this.plans());
    };
  }

  /** The runtime is built with this as a dependency, so it is wired in after. */
  wire(runtime: Runtime) {
    this.runtime = runtime;
  }

  start() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Every agent with the plan tool, as the Plan and Inbox screens show them. */
  plans(): AgentPlan[] {
    return this.deps.agents
      .profiles()
      .filter((a) => a.tools.includes("plan"))
      .map((a) => this.planOf(a.name));
  }

  /** Starts each due run; returns the agents it started, for tests. */
  async tick(): Promise<string[]> {
    const started: string[] = [];
    const runs: Promise<unknown>[] = [];
    for (const plan of this.plans()) {
      const kind = this.dueKind(plan);
      if (!kind) continue;
      started.push(plan.agent);
      runs.push(this.run(plan.agent, kind));
    }
    await Promise.all(runs);
    return started;
  }

  /** An approval an unattended run asked for: refused, and kept in its agent's inbox. */
  refused(conversationId: string, owner: string, asker: string, action: ApprovalAction) {
    if (!this.deps.agents.get(owner)?.tools.includes("plan")) return;
    this.deps.state.plans.addDecision(owner, {
      id: randomUUID(),
      at: this.now().toISOString(),
      conversation: conversationId,
      summary: describe(asker, action),
    });
  }

  /**
   * After the agent proposes or amends a change: Jabuti pushes its branch with the
   * deploy key, so the owner can review it on GitHub. The agent cannot push.
   */
  proposed(agent: string, experiment: Experiment) {
    const github = this.plan(agent).publish?.github;
    if (!github || !experiment.branch) return;
    void this.push(agent, experiment.id, experiment.branch, github);
  }

  /** Pushes a proposal's branch; the problem, if any, is also kept on the experiment. */
  private async push(
    agent: string,
    id: string,
    branch: string,
    github: NonNullable<AgentPlan["publish"]>["github"],
  ): Promise<string | undefined> {
    const result = await this.git(agent, {
      action: "push",
      repo: github.repo,
      base: github.base,
      branch,
      source: github.path,
    });
    this.deps.state.plans.setPublishing(
      agent,
      id,
      result.ok
        ? { compare: `https://github.com/${github.repo}/compare/${github.base}...${branch}` }
        : { issue: `The branch was not pushed: ${result.output}` },
    );
    return result.ok ? undefined : result.output;
  }

  /** The runner's git, as one result: a lost connection is a failure like any other. */
  private git(agent: string, request: GitRequest): Promise<GitResult> {
    return this.deps.sandbox
      .git(agent, request, AbortSignal.timeout(300_000))
      .catch((error: unknown) => ({ ok: false, output: message(error) }));
  }

  private plan(agent: string) {
    return this.deps.state.plans.get(agent);
  }

  async act(agent: string, action: PlanAction): Promise<ActionResult> {
    const profile = this.deps.agents.get(agent);
    if (!profile?.tools.includes("plan")) {
      return fail(`${agent} has no plan.`, "Turn on the plan tool for it in Settings → Agents.");
    }
    const plans = this.deps.state.plans;
    const outcome = (result: unknown, saved: string): ActionResult =>
      typeof result === "object" && result !== null && "problem" in result
        ? { problem: { message: String(result.problem), nextStep: "Fix it and try again." } }
        : { saved };
    switch (action.op) {
      case "milestone.save": {
        const result = plans.saveMilestone(agent, action.id, action.fields, action.status);
        return outcome(result, "id" in result ? `Saved ${result.id}.` : "");
      }
      case "milestone.decide": {
        const result = plans.decideMilestone(agent, action.id, action.approve);
        return outcome(result, `${action.id}: ${action.approve ? "approved" : "rejected"}.`);
      }
      case "experiment.decide":
        return action.approve
          ? this.publish(agent, action.id)
          : this.reject(agent, action.id, action.reason);
      case "controls.save":
        return outcome(plans.saveControls(agent, action.urls), "Saved the control pages.");
      case "routine.save":
        return outcome(
          plans.saveRoutine(agent, action.routine),
          action.routine.enabled ? "Routine on." : "Routine paused.",
        );
      case "limits.save":
        return outcome(plans.saveLimits(agent, action.limits), "Saved the limits.");
      case "publish.save":
        return outcome(plans.savePublish(agent, action.publish), "Saved where changes go.");
      case "publish.key":
        return this.key(agent);
      case "publish.test":
        return this.test(agent);
      case "report.read":
        return outcome(plans.readReport(agent, action.id), "");
      case "decision.dismiss":
        return outcome(plans.dismissDecision(agent, action.id), "");
      case "run": {
        const runtime = this.runtime;
        if (!runtime) return fail("Runs are not available.", "Restart the server.");
        if (action.kind === "draft") {
          const conversation = runtime.create(agent);
          if (!("id" in conversation)) return { problem: conversation };
          const problem = runtime.send(conversation.id, DRAFT_TASK);
          return problem ? { problem } : { conversationId: conversation.id };
        }
        if (this.inFlight.has(agent)) {
          return fail(`${agent} is already running.`, "Wait for that run to finish.");
        }
        const kind = action.kind;
        // Answers as soon as the run's conversation exists; the run goes on in the background.
        const id = await new Promise<string | undefined>((resolve) => {
          void this.run(agent, kind, resolve).then(resolve);
        });
        return id
          ? { conversationId: id }
          : fail("The run did not start.", "Check the server output.");
      }
    }
  }

  /** Runs once, unattended; its final answer becomes the run's report. */
  private async run(
    agent: string,
    kind: "measure" | "act",
    onStart?: (conversationId: string) => void,
  ): Promise<string | undefined> {
    const runtime = this.runtime;
    if (!runtime || this.inFlight.has(agent)) return undefined;
    this.inFlight.add(agent);
    try {
      const plan = this.planOf(agent);
      const conversation = runtime.create(agent, { unattended: true });
      if (!("id" in conversation)) return undefined;
      onStart?.(conversation.id);
      const left = plan.routine.monthlyCapUsd - plan.monthSpentUsd;
      const problem = runtime.send(conversation.id, task(kind, this.today(plan.routine.timeZone)), {
        title: `Routine · ${kind} · ${this.today(plan.routine.timeZone)}`,
        maxCostUsd: left,
      });
      if (problem) {
        this.report(agent, conversation.id, kind, 0, "error", problem.message);
        return conversation.id;
      }
      await runtime.idle(conversation.id);
      const result = runtime.lastTurn(conversation.id);
      this.report(
        agent,
        conversation.id,
        kind,
        result?.costUsd ?? 0,
        result?.reason ?? "error",
        [result?.problem ? `Stopped: ${result.problem.message}` : "", result?.finalText ?? ""]
          .filter(Boolean)
          .join("\n\n") || "(no report)",
      );
      return conversation.id;
    } finally {
      this.inFlight.delete(agent);
    }
  }

  private report(
    agent: string,
    conversation: string,
    kind: "measure" | "act",
    costUsd: number,
    reason: string,
    text: string,
  ) {
    this.deps.state.plans.addRun(agent, {
      id: randomUUID(),
      at: this.now().toISOString(),
      kind,
      conversation,
      costUsd,
      reason,
      text,
    });
  }

  private async publish(agent: string, id: string): Promise<ActionResult> {
    const plans = this.deps.state.plans;
    const experiment = plans.get(agent).experiments.find((e) => e.id === id);
    if (experiment?.status !== "proposed") {
      return fail(`${id} is not waiting for a decision.`, "Reload.");
    }
    const github = plans.get(agent).publish?.github;
    if (!github) {
      // Published by the owner: today is its day zero.
      const result = plans.markLive(agent, id);
      return "problem" in result
        ? fail(result.problem, "Reload.")
        : { saved: `${id} is live; its first check is on ${result.checks[0]?.date ?? "?"}.` };
    }
    if (!experiment.branch) {
      return fail(`${id} names no branch to merge.`, "Reject it, or ask the agent to amend it.");
    }
    // A push that failed at proposal is tried again first.
    if (!experiment.compare) {
      const problem = await this.push(agent, id, experiment.branch, github);
      if (problem) {
        return fail(
          `${id} was not published: ${problem}`,
          "Check the deploy key in Plan → Publishing.",
        );
      }
    }
    const merged = await this.git(agent, {
      action: "merge",
      repo: github.repo,
      base: github.base,
      branch: experiment.branch,
      message: `${title(experiment)}\n\n${body(experiment)}`,
    });
    if (!merged.ok) {
      plans.setPublishing(agent, id, { issue: `Not merged: ${merged.output}` });
      return fail(
        `${id} was not published: ${merged.output}`,
        "If the branch conflicts with the base, ask the agent to update it (plan sync), then approve again.",
      );
    }
    const result = plans.markLive(agent, id);
    return "problem" in result
      ? fail(result.problem, "Reload.")
      : {
          saved: `Merged ${experiment.branch} into ${github.base}. ${id} is live; first check on ${result.checks[0]?.date ?? "?"}.`,
        };
  }

  private async reject(agent: string, id: string, reason: string | undefined) {
    const plans = this.deps.state.plans;
    const experiment = plans.get(agent).experiments.find((e) => e.id === id);
    const result = plans.reject(agent, id, reason);
    if ("problem" in result) return fail(result.problem, "Reload.");
    const github = plans.get(agent).publish?.github;
    // Its branch goes from GitHub too; a failure here leaves only a stale branch.
    if (github && experiment?.branch && experiment.compare) {
      await this.git(agent, {
        action: "delete",
        repo: github.repo,
        base: github.base,
        branch: experiment.branch,
      });
    }
    return { saved: `${id} rejected.` };
  }

  /** The agent's deploy key, made on first use: the owner adds its public half on GitHub. */
  private async key(agent: string): Promise<ActionResult> {
    const result = await this.git(agent, { action: "key" });
    if (!result.ok || !result.publicKey) {
      return fail(`No deploy key: ${result.output}`, "Check that the shell runner is running.");
    }
    this.deps.state.plans.saveDeployKey(agent, {
      publicKey: result.publicKey,
      fingerprint: result.fingerprint ?? "",
    });
    return { saved: "Deploy key ready: add it on GitHub, with write access." };
  }

  private async test(agent: string): Promise<ActionResult> {
    const plans = this.deps.state.plans;
    const plan = plans.get(agent);
    if (!plan.publish) return fail("No repository set.", "Save the repository first.");
    if (!plan.deployKey) {
      const made = await this.key(agent);
      if (made.problem) return made;
    }
    const key = plans.get(agent).deployKey;
    const result = await this.git(agent, { action: "test", repo: plan.publish.github.repo });
    if (key) {
      const { problem: _, checkedAt: __, ...base } = key;
      plans.saveDeployKey(
        agent,
        result.ok
          ? { ...base, checkedAt: this.now().toISOString() }
          : { ...base, problem: result.output },
      );
    }
    return result.ok
      ? { saved: result.output }
      : fail(
          `Jabuti cannot reach ${plan.publish.github.repo}: ${result.output}`,
          "Add the deploy key on GitHub (Settings → Deploy keys), with Allow write access, then test again.",
        );
  }

  private planOf(agent: string): AgentPlan {
    const { next: _, ...plan } = this.deps.state.plans.get(agent);
    const month = this.now().toISOString().slice(0, 7);
    const monthSpentUsd = plan.runs
      .filter((r) => r.at.startsWith(month))
      .reduce((sum, r) => sum + r.costUsd, 0);
    const base = { agent, ...plan, monthSpentUsd };
    if (!plan.routine.enabled) return base;
    if (monthSpentUsd >= plan.routine.monthlyCapUsd) {
      return {
        ...base,
        paused:
          `Unattended runs spent US$ ${monthSpentUsd.toFixed(2)} this month, the cap: ` +
          "they resume next month, or raise the cap.",
      };
    }
    return { ...base, nextRun: this.nextRun(base) };
  }

  /** The kind of run due now, if any: at or after the routine's time, once a day. */
  private dueKind(plan: AgentPlan): "measure" | "act" | undefined {
    if (!plan.nextRun || this.inFlight.has(plan.agent)) return undefined;
    const { day, time } = local(this.now(), plan.routine.timeZone);
    return plan.nextRun.day === day && time >= plan.nextRun.time ? plan.nextRun.kind : undefined;
  }

  private nextRun(plan: Omit<AgentPlan, "nextRun">): AgentPlan["nextRun"] {
    const { timeZone, time: at, actDays } = plan.routine;
    const now = local(this.now(), timeZone);
    const ranToday = plan.runs.some((r) => local(new Date(r.at), timeZone).day === now.day);
    // Today, until today's run happened; a time already past still runs (catch-up).
    const date = ranToday ? local(new Date(this.now().getTime() + 86_400_000), timeZone) : now;
    return { day: date.day, time: at, kind: actDays.includes(date.weekday) ? "act" : "measure" };
  }

  private today(timeZone: string): string {
    return local(this.now(), timeZone).day;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

/** What an unattended run is told; the plan and last reports are in its system prompt. */
function task(kind: "measure" | "act", today: string): string {
  const common =
    `Routine run (${kind}), ${today}. Nobody is watching: anything that needs approval is ` +
    "refused and listed in the owner's inbox; do not retry it, move on. First record every " +
    "check due today from fresh data, with the plan tool, and update your milestones' progress.";
  const act =
    kind === "act"
      ? " Then, if the plan's limits allow, prepare the next change for the highest-priority " +
        "running milestone: make it on a branch, push the branch, and propose it with the " +
        "plan tool, with its hypothesis, metric and baseline. One good change beats several."
      : " Do not propose changes today: measure, analyze and plan.";
  return (
    common +
    act +
    " If there is nothing to do or no signal yet, say so: that is a valid outcome. End with " +
    "your report: what you did; what you measured, with numbers, periods and sources; what " +
    "waits for the owner; the next step."
  );
}

const WEEKDAYS: Record<string, Weekday> = {
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
  Sun: "sun",
};

/** The date, time and weekday at an instant in a time zone. */
function local(at: Date, timeZone: string): { day: string; time: string; weekday: Weekday } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    weekday: WEEKDAYS[get("weekday")] ?? "mon",
  };
}

function describe(agent: string, action: ApprovalAction): string {
  switch (action.kind) {
    case "shell":
      return `${agent} wanted to run: ${action.command}`;
    case "file":
      return `${agent} wanted to change ${action.file}`;
    case "run":
      return `${agent} wanted ${action.agent} to run: ${action.task.slice(0, 200)}`;
    case "packages":
      return `${agent} wanted to install ${action.packages.join(", ")}`;
    case "mcp":
      return `${agent} wanted to call ${action.server} ${action.tool}`;
  }
}

function title(e: Experiment): string {
  return `${e.id}: ${e.change.split("\n")[0]?.slice(0, 80) ?? e.id}`;
}

function body(e: Experiment): string {
  return [
    `Experiment ${e.id} (${e.milestone}, ${e.kind}), proposed by the agent through Jabuti.`,
    "",
    `**Pages:** ${e.urls.join(", ")}`,
    `**Change:** ${e.change}`,
    `**Hypothesis:** ${e.hypothesis}`,
    `**Metric:** ${e.metric}`,
    `**Baseline:** ${e.baseline}`,
    "",
    "Approve or reject it in Jabuti's inbox: merging there starts its measurement.",
  ].join("\n");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string, nextStep: string): ActionResult {
  return { problem: { message, nextStep } };
}
