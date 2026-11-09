// Lets an agent create and edit other agents' profiles, the same profiles the
// settings screen edits. Every write waits for the owner to approve a diff,
// whatever the shell mode. Deleting stays on the settings screen.
//
// run hands a task to another agent in its own workspace, so what it sets up (a
// clone, notes, data) lands with the agent that will use it, never here. It also
// runs with that agent's variables, so the user approves each run (C12, C16).
//
// The tool cannot spread itself: it never grants the agents tool, and never edits
// an agent that has it (itself included), nor a skill such an agent uses, so what
// such an agent may do is set by the owner alone.
//
// It also writes skills (C4), the methods agents share: each save is approved on a
// diff too. Deleting a skill stays on the settings screen.
import { AgentProfileData, SkillInput } from "@jabuti/protocol";
import { z } from "zod";
import type { AgentProfile } from "../agents/registry.ts";
import { STATE_LIMIT } from "../agents/state.ts";
import { format } from "../skills/index.ts";
import { lineDiff } from "./memory.ts";
import type { Tool, ToolOutput } from "./types.ts";

// One flat object, not a union: providers reject anyOf/oneOf at a schema's top level.
const Input = z.strictObject({
  action: z.enum(["list", "create", "update", "run", "read_skill", "save_skill"]),
  profile: AgentProfileData.optional().describe(
    "Required for create and update: the whole profile. For update, start from the " +
      "current one (action list) and change only what was asked.",
  ),
  brief: z
    .string()
    .max(STATE_LIMIT)
    .optional()
    .describe(
      "Create only: the new agent's brief.md, in Markdown: what it works on (site, " +
        "repository, goals, audience, tone), and for an existing site its products and " +
        "services, positioning, calls to action and key pages (each with its path), as the " +
        "owner confirmed them. Needs the memory tool in its profile.",
    ),
  agent: z.string().optional().describe("Run only: the agent that does the task."),
  skill_name: z.string().optional().describe("read_skill only: the skill to read whole."),
  skill: SkillInput.optional().describe(
    "save_skill only: a method several agents can follow, not one site's facts (those go " +
      "in an agent's brief). name: lowercase and hyphens. description: one line saying what " +
      "it does and when to load it; agents decide from it alone, so name the tasks. body: " +
      "Markdown an agent follows step by step: the goal, the steps in order, the rules it " +
      "must not break, and what it delivers. Concrete, no filler, under about 6,000 " +
      "characters. To change one, read_skill first and change only what was asked. Saving " +
      "a built-in's name makes the user's own version of it. Then add it to the agents " +
      "that should use it (update, skills field).",
  ),
  task: z
    .string()
    .optional()
    .describe(
      "Run only: everything the agent needs, since it does not see this conversation. " +
        "Say what to return.",
    ),
});

export const agentsTool: Tool<z.infer<typeof Input>> = {
  name: "agents",
  description: () =>
    "List, create and edit the agents in this harness. Each agent has its own system " +
    "prompt, model, budget, tools, shell mode, subagents, brief, memory and workspace; " +
    "one agent per site or project keeps their work and credentials apart. Call list " +
    "first: it returns every profile, the models available and the MCP connectors " +
    "(listed in a profile's mcp field; each needs variables the user sets in Settings) " +
    "and the skills (methods listed in its skills field, loaded when a task needs one). " +
    "Creating or updating " +
    "sends the whole profile, and the user approves each change after seeing the diff. " +
    "You cannot grant the agents tool, edit an agent that has it, or delete agents: " +
    "the user does that in Settings. It also reads and saves skills, the methods agents " +
    "share (read_skill, save_skill); the user approves each save. Variables (API tokens and the like) are set by " +
    "the user in Settings, never through you. " +
    "Run hands a task to an agent, in its own workspace with its own tools and " +
    "variables, and returns its final answer: use it for any setup that agent will " +
    "use later (cloning a repository, downloading data, first analyses), so the files " +
    "end up in its workspace and not yours.",
  input: Input,
  async execute(input, ctx) {
    const admin = ctx.agentAdmin;
    if (input.action === "list") {
      return {
        content: JSON.stringify(
          {
            agents: admin.profiles(),
            models: admin.models(),
            connectors: admin.connectors(),
            skills: admin.skills(),
          },
          null,
          2,
        ),
        isError: false,
      };
    }
    if (input.action === "run") return run(input.agent, input.task, ctx);
    if (input.action === "read_skill") {
      const skill = input.skill_name ? admin.skill(input.skill_name) : undefined;
      if (!skill) return refuse(`No skill "${input.skill_name ?? ""}". Call list for the names.`);
      return { content: format(skill), isError: false };
    }
    if (input.action === "save_skill") return saveSkill(input.skill, ctx);
    const profile = input.profile;
    if (!profile) return refuse(`Action ${input.action} needs the profile.`);
    const isNew = input.action === "create";
    if (input.brief !== undefined && !isNew) {
      return refuse("A brief is set only at create; afterwards the agent keeps it itself.");
    }
    if (input.brief !== undefined && !profile.tools.includes("memory")) {
      return refuse('A brief needs the memory tool: add "memory" to the profile\'s tools.');
    }
    const current = admin.profiles().find((a) => a.name === profile.name);
    if (profile.tools.includes("agents")) {
      return refuse("Only the user can grant the agents tool, in Settings.");
    }
    if (current?.tools.includes("agents")) {
      return refuse(`Agent "${profile.name}" manages agents; only the user edits it, in Settings.`);
    }
    if (isNew && current) {
      return refuse(`Agent "${profile.name}" already exists. Use update, or pick another name.`);
    }
    if (!isNew && !current) {
      return refuse(`There is no agent "${profile.name}". Use create.`);
    }
    if (!admin.models().some((m) => m.id === profile.model)) {
      return refuse(`Unknown model "${profile.model}". Pick one from action list.`);
    }

    const approved = await ctx.requestApproval({
      kind: "file",
      file: `agent ${profile.name}${isNew ? " (new)" : ""}`,
      diff: lineDiff(current ? profileText(current) : "", profileText(profile, input.brief)),
      ...notes(
        admin.variablesFor(profile.name),
        input.brief !== undefined && ctx.state.readBrief(profile.name) !== ""
          ? ["Replaces the brief a removed agent with this name left."]
          : [],
      ),
    });
    if (!approved) return refuse("The user did not approve this change.");
    if (ctx.signal.aborted) return refuse("Cancelled by the user.");
    const problem = admin.save(profile, isNew);
    if (problem) return refuse(`${problem.message} ${problem.nextStep}`);
    if (input.brief !== undefined) ctx.state.writeBrief(profile.name, input.brief);
    return {
      content:
        `Saved agent ${profile.name}. The user can pick it when starting a conversation; ` +
        "changes apply from its next turn.",
      isError: false,
    };
  },
};

async function saveSkill(
  skill: SkillInput | undefined,
  ctx: Parameters<Tool["execute"]>[1],
): Promise<ToolOutput> {
  if (!skill) return refuse("save_skill needs the skill.");
  const admin = ctx.agentAdmin;
  const users = admin.profiles().filter((a) => a.skills.includes(skill.name));
  const manager = users.find((a) => a.tools.includes("agents"));
  if (manager) {
    return refuse(
      `Agent "${manager.name}" manages agents and uses this skill; only the user edits it, in Settings.`,
    );
  }
  const current = admin.skill(skill.name);
  const label =
    current === undefined
      ? " (new)"
      : current.source === "built-in"
        ? " (the user's version of the built-in)"
        : "";
  const approved = await ctx.requestApproval({
    kind: "file",
    file: `skill ${skill.name}${label}`,
    diff: lineDiff(current ? format(current) : "", format(skill)),
    notes: [
      users.length > 0
        ? `Used by ${users.map((a) => a.name).join(", ")}, from their next turn.`
        : "No agent uses it yet.",
    ],
  });
  if (!approved) return refuse("The user did not approve this skill.");
  if (ctx.signal.aborted) return refuse("Cancelled by the user.");
  const problem = admin.saveSkill(skill);
  if (problem) return refuse(`${problem.message} ${problem.nextStep}`);
  return {
    content:
      `Saved skill ${skill.name}.` +
      (users.length > 0 ? "" : " Add it to the agents that should use it (update, skills)."),
    isError: false,
  };
}

/** The profile as the owner reads it in the diff: agent.json, system.md, brief.md. */
function profileText(profile: AgentProfile, briefText?: string): string {
  const { name: _, system, ...json } = profile;
  const text = `${JSON.stringify(json, null, 2)}\n--- system.md ---\n${system}`;
  return briefText === undefined ? text : `${text}\n--- brief.md ---\n${briefText}`;
}

async function run(
  name: string | undefined,
  task: string | undefined,
  ctx: Parameters<Tool["execute"]>[1],
): Promise<ToolOutput> {
  if (!name || !task) return refuse("Run needs agent and task.");
  const target = ctx.agentAdmin.profiles().find((a) => a.name === name);
  if (!target) return refuse(`There is no agent "${name}".`);
  if (target.tools.includes("agents")) {
    return refuse(`Agent "${name}" manages agents; it cannot be run from here.`);
  }
  const approved = await ctx.requestApproval({
    kind: "run",
    agent: name,
    task,
    ...notes(ctx.agentAdmin.variablesFor(name)),
  });
  if (!approved) return refuse("The user did not approve this run.");
  if (ctx.signal.aborted) return refuse("Cancelled by the user.");
  return ctx.runAgent(target, task);
}

/** Variables already scoped to this name, which the agent receives (C16), and more. */
function notes(variables: { name: string; shell: boolean }[], extra: string[] = []) {
  const all = [
    ...variables.map(
      (v) =>
        `Receives variable ${v.name}` +
        (v.shell ? " in its shell, where its model can read it." : " (server only)."),
    ),
    ...extra,
  ];
  return all.length === 0 ? {} : { notes: all };
}

function refuse(content: string): ToolOutput {
  return { content, isError: true };
}
