import { ChangeKind } from "@jabuti/protocol";
import { z } from "zod";
import type { Tool } from "./types.ts";

// One flat object, like the memory tool: each operation checks the fields it needs.
// The rules (locks, limits, evidence) are enforced in agents/plan.ts, not here.
const Input = z.strictObject({
  op: z
    .enum([
      "read",
      "propose_milestone",
      "update_milestone",
      "propose_change",
      "amend",
      "withdraw",
      "record",
      "sync",
    ])
    .describe(
      "read the plan; propose_milestone for the owner to approve; update_milestone " +
        "(progress, done with evidence, or ask to drop it); propose_change: an experiment " +
        "for the owner to approve; amend or withdraw a proposal; record a due check; " +
        "sync: when publishing is set, bring the base branch into your clone (or clone it).",
    ),
  id: z.string().optional().describe("The milestone (M2) or experiment (e-0003)."),
  title: z.string().optional(),
  goal: z.string().optional(),
  done_when: z
    .string()
    .optional()
    .describe("A measurable criterion, such as '≥80% of the 20 key pages indexed'."),
  due: z.string().optional().describe("YYYY-MM-DD."),
  depends_on: z.array(z.string()).optional(),
  priority: z.number().optional().describe("Lower runs first."),
  status: z.enum(["done"]).optional().describe("done: needs evidence that meets its criterion."),
  progress: z.string().optional().describe("Where it stands now, with numbers."),
  evidence: z.string().optional().describe("For done: the measured numbers, period, source."),
  drop_reason: z.string().optional().describe("Asks the owner to drop the milestone."),
  milestone: z.string().optional().describe("For propose_change: the milestone it serves."),
  urls: z.array(z.string()).optional().describe("The pages it changes, or the new page's path."),
  kind: ChangeKind.optional(),
  change: z.string().optional().describe("What changes, before and after when it is text."),
  hypothesis: z.string().optional(),
  metric: z.string().optional().describe("What will show it worked, such as CTR or position."),
  baseline: z
    .string()
    .optional()
    .describe(
      "The metric before, with period, source and segments: 'CTR 0.8% mobile, 1.9% desktop, " +
        "GSC 28 days to 2026-11-01'. Split CTR and position by device.",
    ),
  branch: z
    .string()
    .optional()
    .describe("The local branch with the change, committed: Jabuti pushes it, you cannot."),
  result: z
    .string()
    .optional()
    .describe("For record: the numbers measured, with period, source and the baseline's segments."),
});
type Input = z.infer<typeof Input>;

export const planTool: Tool<Input> = {
  name: "plan",
  description: () =>
    [
      "Your plan: milestones the owner approved, and experiments, each one change measured " +
        "against a baseline. The plan as of this conversation's start is in the system " +
        "prompt; read it for the current state.",
      "Milestones you propose wait for the owner, unseen until approved; you report progress " +
        "and mark one done only with evidence that meets its criterion. Their goal, criterion " +
        "and order are the owner's: a routine run is told which one to work on.",
      "Every change you publish is an experiment (propose_change): the owner approves it, " +
        "and its pages stay locked until every check is recorded, so each result is " +
        "readable. Control pages never change. Record a check only once it is due, from " +
        "fresh data, comparing against the baseline and the control pages. When there is " +
        "no signal yet, say so: do not invent one.",
      "Compare like with like: the same segments, a period of the same length, and the " +
        "control pages over the same dates. Search results change for reasons that are not " +
        "your change, and each device's on its own: a CTR or position measured for all " +
        "devices together can move with no change of yours.",
      "A new page starts with few signals: its position moves for weeks while Google " +
        "estimates it, and most new pages never reach the top 10. Do not judge a new-page " +
        "experiment, or a milestone that rests on new pages, on its early checks; say the " +
        "signal has not settled. Give such a milestone months, not weeks.",
    ].join("\n"),
  input: Input,
  execute(input, ctx) {
    const plans = ctx.state.plans;
    const agent = ctx.agent.name;
    const output = (result: object, ok: (value: never) => string) =>
      Promise.resolve(
        "problem" in result
          ? { content: String(result.problem), isError: true }
          : { content: ok(result as never), isError: false },
      );
    const need = (fields: (keyof Input)[]) => {
      const missing = fields.filter((f) => input[f] === undefined || input[f] === "");
      return missing.length > 0
        ? Promise.resolve({ content: `${input.op} needs ${missing.join(", ")}.`, isError: true })
        : undefined;
    };
    switch (input.op) {
      case "read": {
        const plan = plans.get(agent);
        const finished = plan.experiments.filter((e) => e.status === "done").slice(-10);
        const lines = finished.map(
          (e) =>
            `- ${e.id} [${e.milestone}, ${e.kind}] ${e.urls.join(" ")}: ${e.change}\n` +
            e.checks.map((c) => `  +${String(c.day)}: ${c.result ?? ""}`).join("\n"),
        );
        return Promise.resolve({
          content:
            plans.render(plan) +
            (lines.length > 0 ? `\nFinished experiments:\n${lines.join("\n")}` : ""),
          isError: false,
        });
      }
      case "propose_milestone":
        return (
          need(["title", "goal", "done_when"]) ??
          output(
            plans.proposeMilestone(agent, {
              title: input.title ?? "",
              goal: input.goal ?? "",
              doneWhen: input.done_when ?? "",
              due: input.due ?? null,
              ...(input.depends_on ? { dependsOn: input.depends_on } : {}),
              ...(input.priority !== undefined ? { priority: input.priority } : {}),
            }),
            (m: { id: string }) => `Proposed ${m.id}: it waits for the owner's approval.`,
          )
        );
      case "update_milestone":
        return (
          need(["id"]) ??
          output(
            plans.updateMilestone(agent, input.id ?? "", {
              ...(input.status ? { status: input.status } : {}),
              ...(input.progress !== undefined ? { progress: input.progress } : {}),
              ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
              ...(input.drop_reason !== undefined ? { drop: input.drop_reason } : {}),
            }),
            (m: { id: string; status: string; dropRequest?: string }) =>
              m.dropRequest ? `${m.id}: asked the owner to drop it.` : `${m.id} is ${m.status}.`,
          )
        );
      case "propose_change": {
        const missing = need([
          "milestone",
          "urls",
          "kind",
          "change",
          "hypothesis",
          "metric",
          "baseline",
        ]);
        if (missing) return missing;
        if (plans.get(agent).publish && !input.branch) {
          return Promise.resolve({
            content:
              "Commit the change on a branch of your clone first, and name it (branch): " +
              "Jabuti pushes it and merges it when the owner approves.",
            isError: true,
          });
        }
        const result = plans.proposeChange(agent, {
          milestone: input.milestone ?? "",
          urls: input.urls ?? [],
          kind: input.kind ?? "other",
          change: input.change ?? "",
          hypothesis: input.hypothesis ?? "",
          metric: input.metric ?? "",
          baseline: input.baseline ?? "",
          ...(input.branch ? { branch: input.branch } : {}),
          conversation: ctx.conversationId,
        });
        if (!("problem" in result)) ctx.proposed(result);
        return output(
          result,
          (e: { id: string }) =>
            `Proposed ${e.id}. The owner decides in the inbox; do not wait for it, and do ` +
            "not publish it yourself. If Jabuti cannot push the branch, the plan says why.",
        );
      }
      case "amend": {
        const missing = need(["id"]);
        if (missing) return missing;
        const amended = plans.amend(agent, input.id ?? "", {
          ...(input.urls ? { urls: input.urls } : {}),
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.change !== undefined ? { change: input.change } : {}),
          ...(input.hypothesis !== undefined ? { hypothesis: input.hypothesis } : {}),
          ...(input.metric !== undefined ? { metric: input.metric } : {}),
          ...(input.baseline !== undefined ? { baseline: input.baseline } : {}),
          ...(input.branch !== undefined ? { branch: input.branch } : {}),
        });
        // New commits or a new branch: Jabuti pushes it again.
        if (!("problem" in amended)) ctx.proposed(amended);
        return output(amended, (e: { id: string }) => `Amended ${e.id}.`);
      }
      case "withdraw":
        return (
          need(["id"]) ??
          output(plans.withdraw(agent, input.id ?? ""), (e: { id: string }) => `Withdrew ${e.id}.`)
        );
      case "record":
        return (
          need(["id", "result"]) ??
          output(
            plans.record(agent, input.id ?? "", input.result ?? ""),
            (e: {
              id: string;
              status: string;
              checks: { day: number; result?: string; date?: string }[];
            }) => {
              const next = e.checks.find((c) => c.result === undefined);
              return e.status === "done"
                ? `Recorded. ${e.id} is done: its pages are free again. Note what you learned.`
                : `Recorded. Next check of ${e.id}: +${String(next?.day ?? 0)} on ${next?.date ?? "?"}.`;
            },
          )
        );
      case "sync":
        return sync(ctx, agent);
    }
  },
};

/** The base branch, from GitHub through Jabuti's key, into the agent's clone. */
async function sync(ctx: Parameters<Tool<Input>["execute"]>[1], agent: string) {
  const publish = ctx.state.plans.get(agent).publish;
  if (!publish) {
    return { content: "No publishing is set: there is nothing to sync from.", isError: true };
  }
  const { repo, base, path } = publish.github;
  const result = await ctx.sandbox
    .git(ctx.workspace, { action: "sync", repo, base, source: path }, ctx.signal)
    .catch((error: unknown) => ({
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    }));
  return result.ok
    ? {
        content: `${result.output} Merge or rebase your branches on origin/${base}.`,
        isError: false,
      }
    : { content: `Not synced: ${result.output}`, isError: true };
}
