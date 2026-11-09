// The agent loop: one model step after another until the model answers without a
// tool call or the budget runs out (C1). Written by hand; no framework.
import type {
  ApprovalAction,
  AssistantPart,
  Experiment,
  LoopEvent,
  Problem,
  TurnEndReason,
  UserPart,
} from "@jabuti/protocol";
import type { AgentProfile, ShellPermission } from "../agents/registry.ts";
import type { AgentState } from "../agents/state.ts";
import type { StoredMessage } from "../conversations/store.ts";
import type { CatalogModel } from "../providers/catalog.ts";
import type { Providers } from "../providers/index.ts";
import { ModelError, type ModelMessage, type ModelProvider } from "../providers/types.ts";
import type { Sandbox } from "../sandbox/docker.ts";
import { skillList, type Skills } from "../skills/index.ts";
import { execute, toolsFor, toSpecs, type ToolCall } from "../tools/registry.ts";
import type { AgentAdmin, ToolOutput } from "../tools/types.ts";
import type { McpTools } from "../mcp/index.ts";
import type { Tracer } from "../tracer/index.ts";

/** Spend for one user turn, shared by the agent and every subagent it runs. */
interface Budget {
  maxSteps: number;
  maxCostUsd: number;
  steps: number;
  costUsd: number;
}

export interface LoopDeps {
  providers: Providers;
  sandbox: Sandbox;
  state: AgentState;
  agentAdmin: AgentAdmin;
  /** The agent's MCP connector tools for this run, and connectors that failed (C5). */
  mcpTools: (agent: AgentProfile) => Promise<McpTools>;
  /** Variables marked for this agent's shell (C16). */
  shellEnv: (agent: string) => Record<string, string>;
  /** The skills agents may load (C4). */
  skills: Skills;
  tracer: Tracer;
  findAgent: (name: string) => AgentProfile | undefined;
  emit: (event: LoopEvent) => void;
  /** The agent proposed a change through the plan tool (C19). */
  proposed: (agent: string, experiment: Experiment) => void;
  requestApproval: (request: {
    callId: string;
    name: string;
    input: unknown;
    agent: string;
    action: ApprovalAction;
    scope: Scope;
    signal: AbortSignal;
  }) => Promise<boolean>;
}

type Scope = { callId: string; agent: string } | undefined;

export interface RunOptions {
  conversationId: string;
  agent: AgentProfile;
  model: CatalogModel;
  provider: ModelProvider;
  /** Appended to the agent's system prompt: the conversation's brief and memory (C14). */
  context: string;
  /** The agent whose workspace the shell uses. */
  workspace: string;
  /** Started by a routine: nobody answers approvals, and notes are marked auto (C19). */
  unattended: boolean;
  /** The conversation's shell mode, falling back to the profile's; read per command. */
  shellPermission: () => ShellPermission;
  /** The history the model sees. The loop appends to it as it goes. */
  history: ModelMessage[];
  /** Persists each new message. Subagent transcripts are not stored, only traced. */
  persist: (message: StoredMessage) => void;
  /**
   * Told the context's size after each step; between steps it may reduce the context
   * and return the model's new view (C10). Subagents have none: their context is fresh.
   */
  contextCheck?: (tokens: number, continuing: boolean) => Promise<ModelMessage[] | undefined>;
  budget: Budget;
  signal: AbortSignal;
  scope: Scope;
}

export interface RunResult {
  reason: TurnEndReason;
  finalText: string;
  problem?: Problem;
}

export async function runLoop(deps: LoopDeps, options: RunOptions): Promise<RunResult> {
  const { agent, model, provider, history, budget, signal, scope } = options;
  // Connectors once per run, so the tool list stays the same across steps (C7).
  const connectors = await deps.mcpTools(agent);
  for (const problem of connectors.problems) deps.emit({ type: "notice", scope, problem });
  const tools = [...toolsFor(agent, scope !== undefined), ...connectors.tools];
  // Built once per run: the prefix must not change between steps (C7).
  const specs = toSpecs(tools, agent, deps.findAgent);
  // Their names and descriptions only; a body enters when the agent loads it (C4).
  const skills = deps.skills.for(agent.skills);
  for (const problem of skills.problems) deps.emit({ type: "notice", scope, problem });
  const system = [agent.system, skillList(skills.skills), options.context]
    .filter((part) => part !== "")
    .join("\n\n");
  let finalText = "";

  for (let step = 0; ; step++) {
    const stop = budgetStop(budget, agent);
    if (stop) return { ...stop, finalText };
    if (signal.aborted) return cancelled(finalText);

    const started = Date.now();
    let response;
    try {
      response = await provider.complete({
        model: model.model,
        system,
        tools: specs,
        messages: history,
        signal,
        onText: (text) => {
          deps.emit({ type: "text.delta", scope, text });
        },
      });
    } catch (error) {
      if (error instanceof ModelError && error.kind === "aborted") return cancelled(finalText);
      const problem =
        error instanceof ModelError
          ? { message: error.message, nextStep: error.nextStep }
          : { message: String(error), nextStep: "Check the trace and try again." };
      return { reason: "error", finalText, problem };
    }

    const cost = deps.providers.cost(model, response.usage);
    budget.steps += 1;
    budget.costUsd += cost;

    const assistant: StoredMessage = {
      role: "assistant",
      parts: response.parts,
      agent: agent.name,
      model: model.id,
      raw: response.raw,
    };
    history.push({ role: "assistant", parts: response.parts, raw: response.raw });
    options.persist(assistant);
    deps.emit({
      type: "message",
      scope,
      message: { role: "assistant", parts: response.parts, agent: agent.name, model: model.id },
    });
    finalText = textOf(response.parts) || finalText;

    const calls = response.parts.filter(
      (p): p is Extract<AssistantPart, { type: "tool_call" }> => p.type === "tool_call",
    );
    // A truncated or refused response may carry a half-written tool call: never run it,
    // but still answer it (C2).
    const runnable = response.stop === "tool_use" || response.stop === "end";
    const results: Extract<UserPart, { type: "tool_result" }>[] = [];
    for (const call of calls) {
      const output = runnable
        ? await runTool(deps, options, tools, call)
        : { content: "Not run: the response was cut off.", isError: true };
      results.push({ type: "tool_result", callId: call.id, ...output });
    }
    if (results.length > 0) {
      history.push({ role: "user", parts: results });
      options.persist({ role: "user", parts: results, agent: agent.name });
    }

    deps.tracer.step({
      conversationId: options.conversationId,
      ...(scope ? { subagent: scope } : {}),
      agent: agent.name,
      model: model.id,
      step,
      inputTokens: response.usage.inputTokens,
      cacheReadTokens: response.usage.cacheReadTokens,
      cacheWriteTokens: response.usage.cacheWriteTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: cost,
      durationMs: Date.now() - started,
      stop: response.stop,
      output: textOf(response.parts),
      toolCalls: calls.map(({ id, name, input }) => ({ id, name, input })),
      toolResults: results.map(({ callId, content, isError }) => ({ callId, content, isError })),
    });

    if (options.contextCheck) {
      const u = response.usage;
      const size = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.outputTokens;
      const fresh = await options.contextCheck(size, runnable && calls.length > 0);
      if (fresh) history.splice(0, history.length, ...fresh);
    }

    switch (response.stop) {
      case "tool_use":
        if (calls.length > 0) continue;
        return { reason: "done", finalText };
      case "end":
        if (calls.length > 0) continue;
        return { reason: "done", finalText };
      case "max_tokens":
        return {
          reason: "max_tokens",
          finalText,
          problem: {
            message: "The model hit its output limit and the answer was cut off.",
            nextStep: 'Ask it to continue, or to answer in smaller pieces ("continue").',
          },
        };
      case "refusal":
        return {
          reason: "refusal",
          finalText,
          problem: {
            message: `The model declined to answer (${response.stopDetail ?? "unspecified"}).`,
            nextStep: "Rephrase the request, or pick another model.",
          },
        };
      case "other":
        return {
          reason: "error",
          finalText,
          problem: {
            message: `The model stopped unexpectedly: ${response.stopDetail ?? "unknown reason"}.`,
            nextStep: "Check the trace for this conversation and try again.",
          },
        };
    }
  }
}

async function runTool(
  deps: LoopDeps,
  options: RunOptions,
  tools: ReturnType<typeof toolsFor>,
  call: ToolCall,
): Promise<ToolOutput> {
  const { scope, signal, agent } = options;
  deps.emit({ type: "tool.started", scope, callId: call.id, name: call.name, input: call.input });
  const asked = { refused: false };
  const result: ToolOutput = signal.aborted
    ? { content: "Cancelled by the user.", isError: true }
    : await execute(tools, call, {
        conversationId: options.conversationId,
        callId: call.id,
        agent,
        signal,
        shellPermission: options.shellPermission,
        // The running agent's own scope, also for a subagent in its parent's workspace.
        shellEnv: () => deps.shellEnv(agent.name),
        sandbox: deps.sandbox,
        workspace: options.workspace,
        unattended: options.unattended,
        state: deps.state,
        agentAdmin: deps.agentAdmin,
        findAgent: deps.findAgent,
        emit: deps.emit,
        skill: (name) =>
          agent.skills.includes(name) ? deps.skills.for([name]).skills[0] : undefined,
        proposed: (experiment) => {
          deps.proposed(agent.name, experiment);
        },
        requestApproval: async (action) => {
          const approved = await deps.requestApproval({
            callId: call.id,
            name: call.name,
            input: call.input,
            agent: agent.name,
            action,
            scope,
            signal,
          });
          if (!approved) asked.refused = true;
          return approved;
        },
        runSubagent: (subagent, task) =>
          runSubagent(deps, options, call.id, subagent, task, {
            workspace: options.workspace,
            context: callerBrief(deps, options.agent.name),
          }),
        // Its own workspace: the work and files belong to that agent (C12).
        runAgent: (other, task) =>
          runSubagent(deps, options, call.id, other, task, { workspace: other.name, context: "" }),
      });
  // In a routine run nobody refused it: nobody was there. Say so, or the agent asks
  // an absent owner to approve and retry (C19).
  const output: ToolOutput =
    asked.refused && options.unattended
      ? {
          content:
            "Not done: this is a routine run and nobody is here to approve it. It is " +
            "listed in the owner's inbox. Do not retry it in this run; carry on without " +
            "it and say in your report what is waiting.",
          isError: true,
        }
      : result;
  deps.emit({ type: "tool.finished", scope, callId: call.id, ...output });
  return output;
}

/**
 * The caller's brief, read-only, so a subagent knows what the work is about without
 * the caller retyping it (C12). Read when the subagent starts: a brief saved earlier
 * in this conversation reaches the subagent before the caller sees it (C14).
 */
function callerBrief(deps: LoopDeps, caller: string): string {
  const brief = deps.state.readBrief(caller).trim();
  if (!brief) return "";
  return [
    `# brief.md of ${caller}, the agent that gave you this task`,
    brief,
    "",
    "Read-only: it describes the work your task belongs to. Only that agent changes it.",
  ].join("\n");
}

async function runSubagent(
  deps: LoopDeps,
  parent: RunOptions,
  callId: string,
  agent: AgentProfile,
  task: string,
  { workspace, context }: { workspace: string; context: string },
): Promise<ToolOutput> {
  // The subagent runs on its own profile's model, with a fresh context (C12). Via
  // delegate, in the parent's workspace and with the parent's brief (the task is
  // about the parent's work); via the agents tool's run, in its own, with neither.
  const resolved = deps.providers.resolve(agent.model);
  if (!resolved.ok) {
    return {
      content: `Subagent ${agent.name} cannot run: ${resolved.problem.message}`,
      isError: true,
    };
  }
  const result = await runLoop(deps, {
    conversationId: parent.conversationId,
    agent,
    model: resolved.model,
    provider: resolved.provider,
    context,
    workspace,
    unattended: parent.unattended,
    // The stricter of its profile's mode and the caller's, read per command: a
    // conversation set to ask must not run commands unasked through a subagent (C12).
    shellPermission: () => stricter(agent.permissions.shell, parent.shellPermission()),
    history: [{ role: "user", parts: [{ type: "text", text: task }] }],
    persist: () => undefined,
    budget: parent.budget,
    signal: parent.signal,
    scope: { callId, agent: agent.name },
  });
  deps.emit({ type: "subagent.finished", callId, agent: agent.name, reason: result.reason });
  if (result.reason === "done") return { content: result.finalText, isError: false };
  return {
    content:
      `Subagent ${agent.name} stopped early (${result.reason}): ${result.problem?.message ?? ""}\n` +
      `Partial answer:\n${result.finalText}`,
    isError: true,
  };
}

const STRICTNESS: ShellPermission[] = ["auto", "ask", "deny"];

function stricter(a: ShellPermission, b: ShellPermission): ShellPermission {
  return STRICTNESS.indexOf(a) >= STRICTNESS.indexOf(b) ? a : b;
}

function budgetStop(budget: Budget, agent: AgentProfile): Omit<RunResult, "finalText"> | undefined {
  const config = `agents/${agent.name}/agent.json`;
  if (budget.steps >= budget.maxSteps) {
    return {
      reason: "budget_steps",
      problem: {
        message: `Stopped after ${String(budget.steps)} steps: the turn's step budget is used up.`,
        nextStep: `Send a message to let it continue, or raise budget.maxSteps in ${config}.`,
      },
    };
  }
  if (budget.costUsd >= budget.maxCostUsd) {
    return {
      reason: "budget_cost",
      problem: {
        message: `Stopped at $${budget.costUsd.toFixed(4)}: the turn's cost budget is used up.`,
        nextStep: `Send a message to let it continue, or raise budget.maxCostUsd in ${config}.`,
      },
    };
  }
  return undefined;
}

function cancelled(finalText: string): RunResult {
  return {
    reason: "cancelled",
    finalText,
    problem: { message: "The turn was cancelled.", nextStep: "Send a new message to continue." },
  };
}

function textOf(parts: AssistantPart[]): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
}
