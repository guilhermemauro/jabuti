// An agent's plan on disk (C19): data/agents/<name>/plan.json, the only source of
// truth, written only here. plan.md is a view for people, rebuilt after every
// change; plan.log.jsonl records every change, who made it and when.
//
// The rules that keep an unattended agent moderate live here, in code, not in a
// prompt: a page being measured or waiting for the owner cannot get another change,
// control pages never change, open proposals are capped, a rejected idea waits, a
// check is recorded only once it is due, and a milestone's goal is the owner's.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentPlan,
  DAY,
  type ChangeKind,
  type Decision,
  type DeployKey,
  type Experiment,
  type Milestone,
  type MilestoneStatus,
  type PlanLimits,
  type Publish,
  type Routine,
  type RunReport,
} from "@jabuti/protocol";
import { z } from "zod";
import { writeAtomic } from "./notes.ts";

/** What plan.json holds: the plan, plus the counters that keep ids unique. */
const PlanFile = AgentPlan.omit({
  agent: true,
  monthSpentUsd: true,
  nextRun: true,
  paused: true,
}).extend({ next: z.object({ milestone: z.number(), experiment: z.number() }) });
type PlanFile = z.infer<typeof PlanFile>;

const DEFAULT_ROUTINE: Routine = {
  enabled: false,
  time: "08:00",
  timeZone: "America/Sao_Paulo",
  actDays: ["tue", "fri"],
  monthlyCapUsd: 15,
};

const DEFAULT_LIMITS: PlanLimits = {
  openProposals: 3,
  rejectCooldownDays: 30,
  checkDays: [3, 14, 28],
};

/** Reports kept: the inbox and the next run need the recent ones. */
const RUNS_KEPT = 60;
const TEXT_LIMIT = 2_000;
const REPORT_LIMIT = 12_000;

/** Who changed the plan, recorded in its log. */
export type PlanAuthor = "owner" | "agent" | "jabuti";

export interface MilestoneInput {
  title: string;
  goal: string;
  doneWhen: string;
  due?: string | null;
  dependsOn?: string[];
  priority?: number;
}

export interface ChangeInput {
  milestone: string;
  urls: string[];
  kind: ChangeKind;
  change: string;
  hypothesis: string;
  metric: string;
  baseline: string;
  branch?: string;
  conversation?: string;
}

type Result<T> = T | { problem: string };

export class Plans {
  private readonly dir: string;
  private readonly today: () => string;
  /** Told after every change, so clients see the new plan; set once at wiring. */
  onChange: (agent: string) => void = () => undefined;

  constructor(dir: string, today?: () => string) {
    this.dir = dir;
    this.today = today ?? (() => new Date().toISOString().slice(0, 10));
  }

  get(agent: string): PlanFile {
    const file = join(this.dir, agent, "plan.json");
    if (!existsSync(file)) return empty();
    // Written by this module; a hand edit that breaks it fails loudly, never silently resets.
    return PlanFile.parse(JSON.parse(readFileSync(file, "utf8")));
  }

  // --- Milestones ---

  /** The agent's suggestion: it waits for the owner. */
  proposeMilestone(agent: string, input: MilestoneInput): Result<Milestone> {
    return this.addMilestone(agent, input, "agent");
  }

  /** The owner's: approved by being written. Without id, a new one. */
  saveMilestone(
    agent: string,
    id: string | undefined,
    input: MilestoneInput,
    status?: MilestoneStatus,
  ): Result<Milestone> {
    if (!id) {
      const added = this.addMilestone(agent, input, "owner");
      if ("problem" in added || !status) return added;
      return this.saveMilestone(agent, added.id, input, status);
    }
    return this.mutate(agent, "owner", `milestone.save ${id}`, (plan) => {
      const current = plan.milestones.find((m) => m.id === id);
      if (!current) return { problem: `There is no milestone ${id}.` };
      const problem = invalidMilestone(input, plan, id);
      if (problem) return { problem };
      const { dropRequest: _, ...rest } = current;
      const next: Milestone = {
        ...rest,
        ...milestoneFields(input),
        // Saving a proposed one approves it.
        status: status ?? (current.status === "proposed" ? "pending" : current.status),
        updatedAt: this.today(),
      };
      plan.milestones = plan.milestones.map((m) => (m.id === id ? next : m));
      return next;
    });
  }

  /** The owner approves or rejects a proposed milestone, or a request to drop one. */
  decideMilestone(agent: string, id: string, approve: boolean): Result<Milestone> {
    return this.mutate(agent, "owner", `milestone.decide ${id} ${String(approve)}`, (plan) => {
      const current = plan.milestones.find((m) => m.id === id);
      if (!current) return { problem: `There is no milestone ${id}.` };
      const { dropRequest, ...rest } = current;
      let next: Milestone;
      if (current.status === "proposed") {
        next = { ...rest, status: approve ? "pending" : "dropped" };
      } else if (dropRequest !== undefined) {
        next = approve
          ? { ...rest, status: "dropped", progress: `Dropped: ${dropRequest}` }
          : { ...rest };
      } else {
        return { problem: `${id} is not waiting for a decision.` };
      }
      next.updatedAt = this.today();
      plan.milestones = plan.milestones.map((m) => (m.id === id ? next : m));
      return next;
    });
  }

  /**
   * The agent's side: start, report progress, finish with evidence, or ask to drop.
   * Never the goal, criterion or due date: those are the owner's.
   */
  updateMilestone(
    agent: string,
    id: string,
    change: { status?: "running" | "done"; progress?: string; evidence?: string; drop?: string },
  ): Result<Milestone> {
    return this.mutate(agent, "agent", `milestone.update ${id}`, (plan) => {
      const current = plan.milestones.find((m) => m.id === id);
      if (!current) return { problem: `There is no milestone ${id}.` };
      if (current.status === "proposed") {
        return { problem: `${id} is still waiting for the owner's approval.` };
      }
      if (current.status === "done" || current.status === "dropped") {
        return { problem: `${id} is ${current.status}.` };
      }
      const next: Milestone = { ...current, updatedAt: this.today() };
      if (change.progress !== undefined) next.progress = clip(change.progress);
      if (change.drop !== undefined) next.dropRequest = clip(change.drop);
      if (change.status === "running") {
        const blocked = current.dependsOn.filter(
          (d) => plan.milestones.find((m) => m.id === d)?.status !== "done",
        );
        if (blocked.length > 0) {
          return { problem: `${id} depends on ${blocked.join(", ")}, not done yet.` };
        }
        next.status = "running";
      }
      if (change.status === "done") {
        if (!change.evidence?.trim()) {
          return {
            problem:
              `Marking ${id} done needs evidence: the measured numbers that meet ` +
              `"${current.doneWhen}", with their period and source.`,
          };
        }
        const open = plan.experiments.filter(
          (e) => e.milestone === id && (e.status === "proposed" || e.status === "live"),
        );
        if (open.length > 0) {
          return {
            problem: `${id} still has experiments open: ${open.map((e) => e.id).join(", ")}. Finish or withdraw them first.`,
          };
        }
        next.status = "done";
        next.evidence = clip(change.evidence);
      }
      plan.milestones = plan.milestones.map((m) => (m.id === id ? next : m));
      return next;
    });
  }

  // --- Experiments ---

  /** A change for the owner to approve, refused when the plan's rules forbid it. */
  proposeChange(agent: string, input: ChangeInput): Result<Experiment> {
    return this.mutate(agent, "agent", "experiment.propose", (plan) => {
      const milestone = plan.milestones.find((m) => m.id === input.milestone);
      if (!milestone) return { problem: `There is no milestone ${input.milestone}.` };
      if (milestone.status === "proposed") {
        return { problem: `${milestone.id} is still waiting for the owner's approval.` };
      }
      if (milestone.status === "done" || milestone.status === "dropped") {
        return { problem: `${milestone.id} is ${milestone.status}.` };
      }
      const urls = paths(input.urls);
      if ("problem" in urls) return urls;
      const problem = invalidChange(input) ?? this.blocked(plan, urls, input.kind);
      if (problem) return { problem };
      const open = plan.experiments.filter((e) => e.status === "proposed").length;
      if (open >= plan.limits.openProposals) {
        return {
          problem:
            `${String(open)} proposals already wait for the owner, the limit. ` +
            "Measure and analyze instead, or amend one of them.",
        };
      }
      if (milestone.status === "pending") {
        const blocked = milestone.dependsOn.filter(
          (d) => plan.milestones.find((m) => m.id === d)?.status !== "done",
        );
        if (blocked.length > 0) {
          return { problem: `${milestone.id} depends on ${blocked.join(", ")}, not done yet.` };
        }
        milestone.status = "running";
        milestone.updatedAt = this.today();
      }
      const experiment: Experiment = {
        id: `e-${String(plan.next.experiment++).padStart(4, "0")}`,
        milestone: milestone.id,
        urls,
        kind: input.kind,
        change: clip(input.change),
        hypothesis: clip(input.hypothesis),
        metric: clip(input.metric),
        baseline: clip(input.baseline),
        ...(input.branch ? { branch: input.branch } : {}),
        status: "proposed",
        createdAt: this.today(),
        checks: plan.limits.checkDays.map((day) => ({ day })),
        ...(input.conversation ? { conversation: input.conversation } : {}),
      };
      plan.experiments.push(experiment);
      return experiment;
    });
  }

  /** While it waits for the owner, the agent may correct it instead of proposing again. */
  amend(
    agent: string,
    id: string,
    input: Partial<Omit<ChangeInput, "milestone" | "conversation">>,
  ): Result<Experiment> {
    return this.mutate(agent, "agent", `experiment.amend ${id}`, (plan) => {
      const current = plan.experiments.find((e) => e.id === id);
      if (!current) return { problem: `There is no experiment ${id}.` };
      if (current.status !== "proposed") {
        return { problem: `${id} is ${current.status}: only a proposal can be amended.` };
      }
      let urls = current.urls;
      if (input.urls) {
        const normalized = paths(input.urls);
        if ("problem" in normalized) return normalized;
        urls = normalized;
      }
      const kind = input.kind ?? current.kind;
      const others = { ...plan, experiments: plan.experiments.filter((e) => e.id !== id) };
      const problem = this.blocked(others, urls, kind);
      if (problem) return { problem };
      const next: Experiment = {
        ...current,
        urls,
        kind,
        ...(input.change !== undefined ? { change: clip(input.change) } : {}),
        ...(input.hypothesis !== undefined ? { hypothesis: clip(input.hypothesis) } : {}),
        ...(input.metric !== undefined ? { metric: clip(input.metric) } : {}),
        ...(input.baseline !== undefined ? { baseline: clip(input.baseline) } : {}),
        ...(input.branch !== undefined ? { branch: input.branch } : {}),
      };
      plan.experiments = plan.experiments.map((e) => (e.id === id ? next : e));
      return next;
    });
  }

  withdraw(agent: string, id: string): Result<Experiment> {
    return this.setExperiment(agent, "agent", id, ["proposed"], (e) => ({
      ...e,
      status: "withdrawn",
    }));
  }

  /** The measurement of the next check, refused before its date. */
  record(agent: string, id: string, result: string): Result<Experiment> {
    return this.mutate(agent, "agent", `experiment.record ${id}`, (plan) => {
      const current = plan.experiments.find((e) => e.id === id);
      if (!current) return { problem: `There is no experiment ${id}.` };
      if (current.status !== "live") {
        return { problem: `${id} is ${current.status}: only a live experiment is measured.` };
      }
      if (!result.trim()) return { problem: "record needs the result: numbers, period, source." };
      const at = current.checks.findIndex((c) => c.result === undefined);
      const check = current.checks[at];
      if (!check?.date) return { problem: `${id} has no check left.` };
      if (check.date > this.today()) {
        return {
          problem:
            `${id}'s next check (+${String(check.day)} days) is on ${check.date}. ` +
            "Data from before then says nothing yet: measure it then.",
        };
      }
      const checks = current.checks.map((c, i) => (i === at ? { ...c, result: clip(result) } : c));
      const last = checks.every((c) => c.result !== undefined);
      const next: Experiment = { ...current, checks, ...(last ? { status: "done" } : {}) };
      plan.experiments = plan.experiments.map((e) => (e.id === id ? next : e));
      return next;
    });
  }

  /** Published today: its checks get their dates. */
  markLive(agent: string, id: string): Result<Experiment> {
    const today = this.today();
    return this.setExperiment(agent, "owner", id, ["proposed"], (e) => {
      const { issue: _, ...rest } = e;
      return {
        ...rest,
        status: "live",
        liveAt: today,
        checks: e.checks.map((c) => ({ day: c.day, date: addDays(today, c.day) })),
      };
    });
  }

  reject(agent: string, id: string, reason: string | undefined): Result<Experiment> {
    return this.setExperiment(agent, "owner", id, ["proposed"], (e) => ({
      ...e,
      status: "rejected",
      rejectReason: reason?.trim() ? reason.trim() : "No reason given.",
      decidedAt: this.today(),
    }));
  }

  /** Publishing state Jabuti records: the branch it pushed, or why a step failed. */
  setPublishing(
    agent: string,
    id: string,
    publishing: { compare?: string; issue?: string },
  ): Result<Experiment> {
    return this.setExperiment(agent, "jabuti", id, ["proposed"], (e) => {
      const { issue: _, ...rest } = e;
      return {
        ...rest,
        ...(publishing.compare ? { compare: publishing.compare } : {}),
        ...(publishing.issue ? { issue: publishing.issue } : {}),
      };
    });
  }

  // --- The owner's settings ---

  saveControls(agent: string, urls: string[]): Result<string[]> {
    return this.mutate(agent, "owner", "controls.save", (plan) => {
      const normalized = paths(urls, { allowEmpty: true });
      if ("problem" in normalized) return normalized;
      const touched = normalized.filter((u) => this.lockOf(plan, u));
      if (touched.length > 0) {
        return { problem: `Already being changed or measured: ${touched.join(", ")}.` };
      }
      plan.controls = [...new Set(normalized)];
      return plan.controls;
    });
  }

  saveRoutine(agent: string, routine: Routine): Result<Routine> {
    if (!validTimeZone(routine.timeZone))
      return { problem: `Unknown time zone ${routine.timeZone}.` };
    return this.mutate(agent, "owner", "routine.save", (plan) => (plan.routine = routine));
  }

  saveLimits(agent: string, limits: PlanLimits): Result<PlanLimits> {
    return this.mutate(agent, "owner", "limits.save", (plan) => (plan.limits = limits));
  }

  savePublish(agent: string, publish: Publish | null): Result<Publish | null> {
    return this.mutate(agent, "owner", "publish.save", (plan) => (plan.publish = publish));
  }

  /** What the runner said about the agent's deploy key; the private half never leaves it. */
  saveDeployKey(agent: string, key: DeployKey): DeployKey {
    // Not returned from the change: a key with a problem would read as a refused change.
    this.mutate(agent, "jabuti", "deploy key", (plan) => {
      plan.deployKey = key;
      return key.fingerprint;
    });
    return key;
  }

  // --- Runs ---

  addRun(agent: string, run: Omit<RunReport, "read">): RunReport {
    const report: RunReport = { ...run, text: run.text.slice(0, REPORT_LIMIT), read: false };
    this.mutate(agent, "jabuti", `run ${run.id}`, (plan) => {
      plan.runs = [report, ...plan.runs].slice(0, RUNS_KEPT);
      return report;
    });
    return report;
  }

  readReport(agent: string, id: string): Result<RunReport> {
    return this.mutate(agent, "owner", `report.read ${id}`, (plan) => {
      const run = plan.runs.find((r) => r.id === id);
      if (!run) return { problem: `There is no report ${id}.` };
      run.read = true;
      return run;
    });
  }

  addDecision(agent: string, decision: Decision) {
    this.mutate(agent, "jabuti", `decision ${decision.id}`, (plan) => {
      plan.decisions = [decision, ...plan.decisions].slice(0, RUNS_KEPT);
      return decision;
    });
  }

  dismissDecision(agent: string, id: string): Result<string> {
    return this.mutate(agent, "owner", `decision.dismiss ${id}`, (plan) => {
      if (!plan.decisions.some((d) => d.id === id)) return { problem: `No decision ${id}.` };
      plan.decisions = plan.decisions.filter((d) => d.id !== id);
      return id;
    });
  }

  // --- What the agent sees ---

  /** Why a page cannot get a change now, or undefined. */
  lock(agent: string, url: string): string | undefined {
    const path = paths([url]);
    return "problem" in path ? path.problem : this.lockOf(this.get(agent), path[0] ?? "/");
  }

  /** Experiments with a check due by today, oldest first. */
  due(plan: PlanFile): { experiment: Experiment; day: number; date: string }[] {
    return plan.experiments.flatMap((e) => {
      if (e.status !== "live") return [];
      const next = e.checks.find((c) => c.result === undefined);
      return next?.date && next.date <= this.today()
        ? [{ experiment: e, day: next.day, date: next.date }]
        : [];
    });
  }

  /** The plan as the agent sees it at a conversation's start (C7). */
  render(plan: PlanFile, options: { reports?: number } = {}): string {
    const today = this.today();
    const lines = [`# Your plan, as of ${today} (change it with the plan tool)`, ""];
    const active = plan.milestones.filter((m) => m.status !== "dropped");
    if (active.length === 0) {
      lines.push("No milestones yet: propose some for the owner to approve.", "");
    } else {
      lines.push("Milestones (lower priority number first):");
      for (const m of [...active].sort(byPriority)) {
        const parts = [`- ${m.id} [${m.status}] ${m.title}: ${m.goal}`];
        parts.push(`  done when: ${m.doneWhen}`);
        const meta = [
          m.due ? `due ${m.due}` : "",
          m.dependsOn.length > 0 ? `after ${m.dependsOn.join(", ")}` : "",
          `priority ${String(m.priority)}`,
        ].filter(Boolean);
        parts.push(`  ${meta.join(" · ")}`);
        if (m.progress) parts.push(`  progress: ${m.progress}`);
        if (m.evidence) parts.push(`  evidence: ${m.evidence}`);
        if (m.dropRequest) parts.push(`  you asked to drop it: ${m.dropRequest}`);
        lines.push(...parts);
      }
      lines.push("");
    }
    const open = plan.experiments.filter((e) => e.status === "proposed" || e.status === "live");
    if (open.length > 0) {
      lines.push("Open experiments:");
      for (const e of open) {
        const next = e.checks.find((c) => c.result === undefined);
        const state =
          e.status === "proposed"
            ? "waiting for the owner"
            : `live since ${e.liveAt ?? "?"}, next check +${String(next?.day ?? 0)} on ${next?.date ?? "?"}`;
        lines.push(
          `- ${e.id} [${e.milestone}, ${e.kind}] ${e.urls.join(" ")}: ${e.change} (${state})`,
        );
        lines.push(`  baseline: ${e.baseline}`);
        for (const c of e.checks.filter((c) => c.result)) {
          lines.push(`  +${String(c.day)}: ${c.result ?? ""}`);
        }
      }
      lines.push("");
    }
    const due = this.due(plan);
    if (due.length > 0) {
      lines.push(`Checks due by today (${today}): measure and record these first`);
      for (const d of due) {
        lines.push(`- ${d.experiment.id} +${String(d.day)} (due ${d.date}) ${d.experiment.metric}`);
      }
      lines.push("");
    }
    const rejected = plan.experiments.filter(
      (e) =>
        e.status === "rejected" &&
        addDays(e.decidedAt ?? e.createdAt, plan.limits.rejectCooldownDays) > today,
    );
    if (rejected.length > 0) {
      lines.push("Rejected by the owner (do not propose again):");
      for (const e of rejected) {
        lines.push(
          `- ${e.id} ${e.kind} ${e.urls.join(" ")}: ${e.change}. Reason: ${e.rejectReason ?? ""}`,
        );
      }
      lines.push("");
    }
    if (plan.publish) {
      const { repo, base, path } = plan.publish.github;
      lines.push(
        `Publishing: ${repo}, base ${base}, your clone in ${path}. Jabuti holds the deploy key: ` +
          "you cannot push. Commit each change on its own branch and propose it with that " +
          `branch; Jabuti pushes it, and merges it into ${base} when the owner approves. ` +
          `To get ${base}, or the clone itself, use the plan tool's sync.`,
        "",
      );
    }
    const proposals = plan.experiments.filter((e) => e.status === "proposed").length;
    lines.push(
      `Open proposals: ${String(proposals)} of ${String(plan.limits.openProposals)}.` +
        (plan.controls.length > 0
          ? ` Control pages, never changed: ${plan.controls.join(" ")}.`
          : " No control pages yet: suggest a few unchanged pages to compare against."),
      "",
    );
    const reports = plan.runs.slice(0, options.reports ?? 0);
    for (const run of reports) {
      lines.push(`# Report of your ${run.kind} run on ${run.at.slice(0, 10)}`, run.text.trim(), "");
    }
    return lines.join("\n");
  }

  private blocked(plan: PlanFile, urls: string[], kind: ChangeKind): string | undefined {
    for (const url of urls) {
      const lock = this.lockOf(plan, url);
      if (lock) return lock;
      const rejected = plan.experiments.find(
        (e) =>
          e.status === "rejected" &&
          e.kind === kind &&
          e.urls.includes(url) &&
          addDays(e.decidedAt ?? e.createdAt, plan.limits.rejectCooldownDays) > this.today(),
      );
      if (rejected) {
        return (
          `The owner rejected a ${kind} change to ${url} (${rejected.id}): ` +
          `"${rejected.rejectReason ?? ""}". Not again before ` +
          `${addDays(rejected.decidedAt ?? rejected.createdAt, plan.limits.rejectCooldownDays)}.`
        );
      }
    }
    return undefined;
  }

  private lockOf(plan: PlanFile, url: string): string | undefined {
    if (plan.controls.includes(url)) {
      return `${url} is a control page: it stays unchanged so others can be compared to it.`;
    }
    for (const e of plan.experiments) {
      if (!e.urls.includes(url)) continue;
      if (e.status === "proposed") {
        return `${url} already has a proposal waiting for the owner (${e.id}): amend it instead.`;
      }
      if (e.status === "live") {
        const last = e.checks.at(-1)?.date ?? "?";
        return (
          `${url} is being measured until ${last} (experiment ${e.id}). ` +
          "Another change now would spoil the measurement: pick another page or wait."
        );
      }
    }
    return undefined;
  }

  private addMilestone(
    agent: string,
    input: MilestoneInput,
    by: "owner" | "agent",
  ): Result<Milestone> {
    return this.mutate(agent, by, "milestone.add", (plan) => {
      const problem = invalidMilestone(input, plan, undefined);
      if (problem) return { problem };
      const milestone: Milestone = {
        id: `M${String(plan.next.milestone++)}`,
        ...milestoneFields(input),
        priority: input.priority ?? plan.milestones.length + 1,
        status: by === "owner" ? "pending" : "proposed",
        createdBy: by,
        updatedAt: this.today(),
      };
      plan.milestones.push(milestone);
      return milestone;
    });
  }

  private setExperiment(
    agent: string,
    author: PlanAuthor,
    id: string,
    from: Experiment["status"][],
    change: (e: Experiment) => Experiment,
  ): Result<Experiment> {
    return this.mutate(agent, author, `experiment ${id}`, (plan) => {
      const current = plan.experiments.find((e) => e.id === id);
      if (!current) return { problem: `There is no experiment ${id}.` };
      if (!from.includes(current.status)) return { problem: `${id} is ${current.status}.` };
      const next = change(current);
      plan.experiments = plan.experiments.map((e) => (e.id === id ? next : e));
      return next;
    });
  }

  /** Read, change, write: one writer per process, so no lock is needed. */
  private mutate<T>(
    agent: string,
    author: PlanAuthor,
    what: string,
    change: (plan: PlanFile) => T | { problem: string },
  ): Result<T> {
    const plan = this.get(agent);
    const result = change(plan);
    if (isProblem(result)) return result;
    const folder = join(this.dir, agent);
    mkdirSync(folder, { recursive: true });
    writeAtomic(join(folder, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    writeAtomic(join(folder, "plan.md"), this.render(plan));
    appendFileSync(
      join(folder, "plan.log.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), author, what, result })}\n`,
    );
    this.onChange(agent);
    return result;
  }
}

function empty(): PlanFile {
  return {
    milestones: [],
    experiments: [],
    controls: [],
    routine: DEFAULT_ROUTINE,
    limits: DEFAULT_LIMITS,
    publish: null,
    deployKey: null,
    runs: [],
    decisions: [],
    next: { milestone: 1, experiment: 1 },
  };
}

function isProblem(value: unknown): value is { problem: string } {
  return typeof value === "object" && value !== null && "problem" in value;
}

function milestoneFields(input: MilestoneInput) {
  return {
    title: clip(input.title, 120),
    goal: clip(input.goal),
    doneWhen: clip(input.doneWhen),
    ...(input.due ? { due: input.due } : {}),
    dependsOn: input.dependsOn ?? [],
    priority: input.priority ?? 1,
  };
}

function invalidMilestone(input: MilestoneInput, plan: PlanFile, self: string | undefined) {
  if (!input.title.trim() || !input.goal.trim() || !input.doneWhen.trim()) {
    return "A milestone needs a title, a goal and a measurable done-when criterion.";
  }
  if (input.due && !DAY.test(input.due)) return "due must be a date, YYYY-MM-DD.";
  const unknown = (input.dependsOn ?? []).find(
    (d) => d === self || !plan.milestones.some((m) => m.id === d),
  );
  if (unknown) return `It cannot depend on ${unknown}.`;
  return undefined;
}

function invalidChange(input: ChangeInput): string | undefined {
  const missing = (["change", "hypothesis", "metric", "baseline"] as const).filter(
    (field) => !input[field].trim(),
  );
  if (missing.length > 0) {
    return (
      `A change is an experiment: it needs ${missing.join(", ")}. The baseline names ` +
      "the number, its period and its source, measured before the change."
    );
  }
  return undefined;
}

/** Paths only, the way pages are compared: /blog/post, no host, query or trailing slash. */
function paths(urls: string[], options: { allowEmpty?: boolean } = {}): Result<string[]> {
  if (urls.length === 0 && !options.allowEmpty) {
    return { problem: "Name the pages it changes (urls), or the new page's path." };
  }
  const out: string[] = [];
  for (const raw of urls) {
    let path: string;
    try {
      path = new URL(raw.trim(), "https://site.invalid").pathname;
    } catch {
      return { problem: `Not a page: ${raw}.` };
    }
    if (path.length > 1) path = path.replace(/\/+$/, "");
    out.push(path);
  }
  return [...new Set(out)];
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function byPriority(a: Milestone, b: Milestone) {
  return a.priority - b.priority || a.id.localeCompare(b.id, "en", { numeric: true });
}

function clip(text: string, limit = TEXT_LIMIT): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}
