// Owns the running turns (one loop per running conversation) and their pending
// approvals. Approvals are in memory on purpose: a pending approval cannot outlive
// the loop that waits for it, and a restart ends every loop.
import { randomUUID } from "node:crypto";
import type {
  AttachmentPart,
  ApprovalAction,
  ConnectorInfo,
  ContextMark,
  ConversationInfo,
  Experiment,
  LoopEvent,
  Problem,
  ShellMode,
} from "@jabuti/protocol";
import type { AgentRegistry } from "../agents/registry.ts";
import { saveAgent } from "../agents/save.ts";
import type { AgentState } from "../agents/state.ts";
import type { Mcp } from "../mcp/index.ts";
import type { AgentAdmin } from "../tools/types.ts";
import type { Settings } from "../settings/index.ts";
import type { Conversation, ConversationStore, StoredMessage } from "../conversations/store.ts";
import type { AgentProfile } from "../agents/registry.ts";
import type { CatalogModel } from "../providers/catalog.ts";
import type { Providers } from "../providers/index.ts";
import type { ModelProvider } from "../providers/types.ts";
import type { Sandbox } from "../sandbox/docker.ts";
import type { Tracer } from "../tracer/index.ts";
import { estimate, mark, modelView, plan, summarize, toSave } from "./context.ts";
import { runLoop, type LoopDeps, type RunResult } from "./run.ts";
import { Skills } from "../skills/index.ts";
import type { McpServers } from "../mcp/servers.ts";

export interface RuntimeDeps {
  agents: AgentRegistry;
  providers: Providers;
  store: ConversationStore;
  sandbox: Sandbox;
  state: AgentState;
  /** Absent in tests that need no variables. */
  settings?: Settings;
  /** Absent in tests that use no connectors. */
  mcp?: Mcp;
  /** Connectors a profile may list; none by default. */
  connectors?: readonly ConnectorInfo[];
  /** Remote servers the owner registered, listed with the connectors (C5). */
  mcpServers?: McpServers;
  /** Skills a profile may list (C4); none by default. */
  skills?: Skills;
  tracer: Tracer;
  /** Memory capture (C18): told when turns end and conversations start. */
  capture?: {
    turnEnded(conversationId: string): void;
    conversationStarted(conversationId: string): void;
  };
  /** The autopilot (C19): told of approvals an unattended run could not get, and proposals. */
  autopilot?: {
    refused(conversationId: string, owner: string, asker: string, action: ApprovalAction): void;
    proposed(agent: string, experiment: Experiment): void;
  };
}

export interface RuntimeListener {
  event(conversationId: string, event: LoopEvent): void;
  conversationUpdated(conversation: ConversationInfo): void;
  /** An agent saved a profile through the agents tool: clients need the new list. */
  catalogChanged?(): void;
}

interface PendingApproval {
  conversationId: string;
  /** What a client opening the conversation now needs to see the approval card. */
  replay: LoopEvent[];
  settle: (approved: boolean) => void;
}

/** Saving one tool result in the workspace before a reduction. */
const SAVE_TIMEOUT_MS = 30_000;

interface RunningTurn {
  abort: AbortController;
  done: Promise<void>;
}

/** What reducing a conversation's context needs (C10). */
interface Reducing {
  conversationId: string;
  /** The stored history, kept current: marks are appended to it. */
  history: StoredMessage[];
  agent: AgentProfile;
  model: CatalogModel;
  provider: ModelProvider;
  signal: AbortSignal;
  emit: (event: LoopEvent) => void;
  /** The turn's budget, which a summary made mid-turn is charged to. */
  budget?: { costUsd: number };
}

export class Runtime {
  private readonly deps: RuntimeDeps;
  private readonly listener: RuntimeListener;
  private readonly running = new Map<string, RunningTurn>();
  private readonly approvals = new Map<string, PendingApproval>();
  /** How each conversation's last turn ended, for the autopilot's run reports. */
  private readonly results = new Map<string, RunResult & { costUsd: number }>();
  /** Each conversation's context size at its last step, in tokens (C10). */
  private readonly tokens = new Map<string, number>();

  constructor(deps: RuntimeDeps, listener: RuntimeListener) {
    this.deps = deps;
    this.listener = listener;
  }

  info({ id, title, agent, model, shellMode, unattended }: Conversation): ConversationInfo {
    return { id, title, agent, model, shellMode, running: this.running.has(id), unattended };
  }

  /** How the conversation's last turn ended in this process, if it ran one. */
  lastTurn(conversationId: string): (RunResult & { costUsd: number }) | undefined {
    return this.results.get(conversationId);
  }

  create(agentName: string, options: { unattended?: boolean } = {}): Conversation | Problem {
    const agent = this.deps.agents.get(agentName);
    if (!agent) {
      return {
        message: `There is no agent named "${agentName}".`,
        nextStep: "Pick one of the listed agents, or add its profile under agents/ and restart.",
      };
    }
    // Taken once: the conversation keeps this version of brief and memory (C14).
    const unattended = options.unattended ?? false;
    const context = this.deps.state.snapshot(agent.name, {
      own: agent.tools.includes("memory"),
      user: agent.userMemory,
      plan: agent.tools.includes("plan"),
      // What ran before: the last report, or two for a run nobody watches (C19).
      reports: unattended ? 2 : 1,
    });
    const conversation = this.deps.store.create(agent.name, context, unattended);
    this.deps.capture?.conversationStarted(conversation.id);
    return conversation;
  }

  busy(conversationId: string): boolean {
    return this.running.has(conversationId);
  }

  /** From the next turn on. Subagents keep their own profile's model (C12). */
  selectModel(conversationId: string, model: string | null): Problem | undefined {
    if (!this.deps.store.get(conversationId)) return unknownConversation();
    if (model !== null) {
      const resolved = this.deps.providers.resolve(model);
      if (!resolved.ok) return resolved.problem;
    }
    this.deps.store.setModel(conversationId, model);
    this.updated(conversationId);
    return undefined;
  }

  /** Takes effect from the next command, even mid-turn (C9). */
  selectShellMode(conversationId: string, mode: ShellMode | null): Problem | undefined {
    if (!this.deps.store.get(conversationId)) return unknownConversation();
    this.deps.store.setShellMode(conversationId, mode);
    this.updated(conversationId);
    return undefined;
  }

  /** Starts a turn in the background. Events arrive through the listener. */
  send(
    conversationId: string,
    text: string,
    options: {
      title?: string;
      maxCostUsd?: number;
      owner?: boolean;
      /** Files the owner attached, already saved in the agent's workspace. */
      attachments?: AttachmentPart[];
    } = {},
  ): Problem | undefined {
    const attachments = options.attachments ?? [];
    if (!text.trim() && attachments.length === 0) {
      return { message: "The message is empty.", nextStep: "Write something or attach a file." };
    }
    const found = this.deps.store.get(conversationId);
    if (!found) return unknownConversation();
    // The owner writing in a routine run is there now: approvals wait for them (C19).
    const conversation =
      options.owner && found.unattended ? { ...found, unattended: false } : found;
    if (this.running.has(conversationId)) {
      return {
        message: "This conversation is still working on the previous message.",
        nextStep: "Wait for it to finish, or press Stop.",
      };
    }
    const agent = this.deps.agents.get(conversation.agent);
    if (!agent) {
      return {
        message: `Agent "${conversation.agent}" is no longer loaded.`,
        nextStep: `Restore agents/${conversation.agent}/ and restart the server.`,
      };
    }
    const resolved = this.deps.providers.resolve(conversation.model ?? agent.model);
    if (!resolved.ok) return resolved.problem;

    const abort = new AbortController();
    const turn: RunningTurn = { abort, done: Promise.resolve() };
    this.running.set(conversationId, turn);

    const store = this.deps.store;
    if (found.unattended && !conversation.unattended) store.setAttended(conversationId);
    const history = store.history(conversationId);
    if (history.length === 0) {
      const title = options.title ?? (text.trim() || attachments.map((a) => a.name).join(", "));
      store.setTitle(conversationId, title.slice(0, 60));
    }
    this.closeDanglingCalls(conversationId, history);
    const userMessage: StoredMessage = {
      role: "user",
      // Files first, then the words about them.
      parts: [...attachments, ...(text.trim() ? [{ type: "text" as const, text }] : [])],
      agent: agent.name,
    };
    store.append(conversationId, userMessage);
    history.push(userMessage);
    this.updated(conversationId);

    const emit = (event: LoopEvent) => {
      this.listener.event(conversationId, event);
    };
    emit({ type: "turn.started", agent: agent.name, model: resolved.model.id });
    emit({ type: "message", scope: undefined, message: userMessage });

    const budget = {
      maxSteps: agent.budget.maxSteps,
      // An unattended run also stops at what is left of its monthly cap (C19).
      maxCostUsd: Math.min(agent.budget.maxCostUsd, options.maxCostUsd ?? Infinity),
      steps: 0,
      costUsd: 0,
    };
    const reducing: Reducing = {
      conversationId,
      history,
      agent,
      model: resolved.model,
      provider: resolved.provider,
      signal: abort.signal,
      emit,
      budget,
    };
    const known = this.tokens.get(conversationId);
    const tokens =
      known === undefined
        ? this.measure(history, agent, conversation.context)
        : known + estimate([{ role: "user", parts: userMessage.parts }]);
    turn.done = this.reduce(reducing, tokens, false)
      .then(() =>
        runLoop(this.loopDeps(conversationId, emit), {
          conversationId,
          agent,
          model: resolved.model,
          provider: resolved.provider,
          context: conversation.context,
          workspace: agent.name,
          unattended: conversation.unattended,
          shellPermission: () => {
            // The profile's deny is a hard limit; the conversation chooses between ask and auto.
            if (agent.permissions.shell === "deny") return "deny";
            return store.get(conversationId)?.shellMode ?? agent.permissions.shell;
          },
          history: modelView(history),
          persist: (message) => {
            store.append(conversationId, message);
            history.push(message);
          },
          contextCheck: async (size, continuing) => {
            this.tokens.set(conversationId, size);
            if (!continuing) return undefined;
            return (await this.reduce(reducing, size, false)) ? modelView(history) : undefined;
          },
          budget,
          signal: abort.signal,
          scope: undefined,
        }),
      )
      .then((result) => {
        this.results.set(conversationId, { ...result, costUsd: budget.costUsd });
        emit({
          type: "turn.finished",
          reason: result.reason,
          steps: budget.steps,
          costUsd: budget.costUsd,
          ...(result.problem ? { problem: result.problem } : {}),
        });
      })
      .catch((error: unknown) => {
        this.results.set(conversationId, {
          reason: "error",
          finalText: "",
          costUsd: budget.costUsd,
          problem: { message: String(error), nextStep: "Check the server output." },
        });
        // A bug in the loop must still end the turn visibly (C11).
        emit({
          type: "turn.finished",
          reason: "error",
          steps: budget.steps,
          costUsd: budget.costUsd,
          problem: {
            message: `Internal error: ${error instanceof Error ? error.message : String(error)}`,
            nextStep:
              "This is a Jabuti bug. Check the server output and the trace, then report it.",
          },
        });
      })
      .finally(() => {
        this.running.delete(conversationId);
        this.updated(conversationId);
        this.deps.capture?.turnEnded(conversationId);
      });
    return undefined;
  }

  /** Summarizes the conversation for the model now, as the owner asked (C10). */
  compact(conversationId: string, focus?: string): Problem | undefined {
    const conversation = this.deps.store.get(conversationId);
    if (!conversation) return unknownConversation();
    if (this.running.has(conversationId)) {
      return {
        message: "This conversation is still working.",
        nextStep: "Wait for it to finish, or press Stop, then compact.",
      };
    }
    const agent = this.deps.agents.get(conversation.agent);
    if (!agent) {
      return {
        message: `Agent "${conversation.agent}" is no longer loaded.`,
        nextStep: `Restore agents/${conversation.agent}/ and restart the server.`,
      };
    }
    const resolved = this.deps.providers.resolve(conversation.model ?? agent.model);
    if (!resolved.ok) return resolved.problem;
    const abort = new AbortController();
    const turn: RunningTurn = { abort, done: Promise.resolve() };
    this.running.set(conversationId, turn);
    this.updated(conversationId);
    const history = this.deps.store.history(conversationId);
    const tokens =
      this.tokens.get(conversationId) ?? this.measure(history, agent, conversation.context);
    const reducing: Reducing = {
      conversationId,
      history,
      agent,
      model: resolved.model,
      provider: resolved.provider,
      signal: abort.signal,
      emit: (event) => {
        this.listener.event(conversationId, event);
      },
    };
    turn.done = this.reduce(reducing, tokens, true, focus)
      .then(() => undefined)
      .finally(() => {
        this.running.delete(conversationId);
        this.updated(conversationId);
      });
    return undefined;
  }

  respondApproval(approvalId: string, approved: boolean): Problem | undefined {
    const pending = this.approvals.get(approvalId);
    if (!pending) {
      return {
        message: "That approval is no longer pending.",
        nextStep: "The turn ended or was cancelled. Send a new message to continue.",
      };
    }
    pending.settle(approved);
    return undefined;
  }

  /**
   * Events that put the conversation's pending approvals back on screen. History
   * does not hold them, so a client that opens the conversation mid-turn needs these.
   */
  pendingEvents(conversationId: string): LoopEvent[] {
    return [...this.approvals.values()]
      .filter((a) => a.conversationId === conversationId)
      .flatMap((a) => a.replay);
  }

  cancel(conversationId: string) {
    this.running.get(conversationId)?.abort.abort();
  }

  /** Resolves when the current turn of the conversation, if any, has finished. */
  async idle(conversationId: string) {
    await this.running.get(conversationId)?.done;
  }

  private get connectors(): readonly ConnectorInfo[] {
    return [...(this.deps.connectors ?? []), ...(this.deps.mcpServers?.connectorInfos() ?? [])];
  }

  private readonly noSkills = new Skills();

  private get skills(): Skills {
    return this.deps.skills ?? this.noSkills;
  }

  private readonly agentAdmin: AgentAdmin = {
    profiles: () => this.deps.agents.profiles(),
    models: () => this.deps.providers.list(),
    connectors: () => this.connectors,
    skills: () => this.skills.list(),
    skill: (name) => this.skills.get(name),
    saveSkill: (skill) => this.skills.save(skill, this.skills.get(skill.name)?.source !== "owner"),
    save: (profile, create) => {
      const problem = saveAgent(
        {
          agents: this.deps.agents,
          providers: this.deps.providers,
          connectors: this.connectors,
          skills: this.skills.list(),
        },
        profile,
        create,
      );
      if (!problem) this.listener.catalogChanged?.();
      return problem;
    },
    variablesFor: (agent) =>
      (this.deps.settings?.variablesFor(agent) ?? []).map((v) => ({
        name: v.name,
        shell: v.shell,
      })),
  };

  private loopDeps(conversationId: string, emit: (event: LoopEvent) => void): LoopDeps {
    return {
      providers: this.deps.providers,
      sandbox: this.deps.sandbox,
      state: this.deps.state,
      agentAdmin: this.agentAdmin,
      mcpTools: async (agent) => (await this.deps.mcp?.tools(agent)) ?? { tools: [], problems: [] },
      shellEnv: (agent) => this.deps.settings?.shellEnv(agent) ?? {},
      skills: this.skills,
      tracer: this.deps.tracer,
      findAgent: (name) => this.deps.agents.get(name),
      emit,
      proposed: (agent, experiment) => {
        this.deps.autopilot?.proposed(agent, experiment);
      },
      requestApproval: ({ callId, name, input, agent, action, scope, signal }) =>
        new Promise<boolean>((resolve) => {
          const approvalId = randomUUID();
          const conversation = this.deps.store.get(conversationId);
          if (conversation?.unattended) {
            // Nobody is there to answer: refused at once, and listed for the owner (C19).
            emit({ type: "approval.requested", scope, approvalId, callId, agent, action });
            emit({ type: "approval.resolved", approvalId, approved: false });
            this.deps.autopilot?.refused(conversationId, conversation.agent, agent, action);
            resolve(false);
            return;
          }
          const settle = (approved: boolean) => {
            this.approvals.delete(approvalId);
            signal.removeEventListener("abort", onAbort);
            emit({ type: "approval.resolved", approvalId, approved });
            resolve(approved);
          };
          const onAbort = () => {
            settle(false);
          };
          signal.addEventListener("abort", onAbort);
          const requested: LoopEvent = {
            type: "approval.requested",
            scope,
            approvalId,
            callId,
            agent,
            action,
          };
          // A top-level call is in history; a subagent's is not, so replay its card too.
          const replay: LoopEvent[] = scope
            ? [{ type: "tool.started", scope, callId, name, input }, requested]
            : [requested];
          this.approvals.set(approvalId, { conversationId, replay, settle });
          emit(requested);
        }),
    };
  }

  /**
   * Clears old tool results or summarizes, when the context is that large or the owner
   * asked; appends the mark (C10). True when the model's view changed. A failure is
   * shown and the conversation goes on with its full history.
   */
  private async reduce(
    r: Reducing,
    tokens: number,
    manual: boolean,
    focus?: string,
  ): Promise<boolean> {
    const reduction = plan(r.history, tokens, r.model, manual);
    if (!reduction) {
      if (manual) {
        r.emit({
          type: "notice",
          scope: undefined,
          problem: {
            message: "Nothing to summarize yet: the conversation is short.",
            nextStep: "Keep working; Jabuti summarizes on its own when the context grows.",
          },
        });
      }
      return false;
    }
    const overhead = Math.max(0, tokens - estimate(modelView(r.history)));
    const started = Date.now();
    // Long tool results are saved whole before they leave the view, so the agent reads
    // them again instead of running the tool. In the conversation's current agent's
    // workspace: after a switch to another agent, the files stay with the first one.
    const saved: { callId: string; path: string }[] = [];
    const failed: string[] = [];
    for (const item of toSave(r.history, reduction, r.conversationId)) {
      try {
        const signal = AbortSignal.any([r.signal, AbortSignal.timeout(SAVE_TIMEOUT_MS)]);
        await this.deps.sandbox.writeFile(r.agent.name, item.path, item.text, signal);
        saved.push({ callId: item.callId, path: item.path });
      } catch (error) {
        failed.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failed.length > 0 && !r.signal.aborted) {
      r.emit({
        type: "notice",
        scope: undefined,
        problem: {
          message:
            `Could not save ${String(failed.length)} tool result(s) in the workspace before ` +
            `taking them out of the agent's context: ${failed[0] ?? ""}`,
          nextStep:
            reduction.mode === "clear"
              ? "They stay in its context for now. Check that the agent's shell works."
              : "The summary covers them, but the agent cannot read them whole again. Check that the agent's shell works.",
        },
      });
    }
    // A clear reduces only saved results: nothing saved, nothing cleared.
    if (reduction.mode === "clear" && saved.length === 0) return false;
    let summary: string | undefined;
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    if (reduction.mode === "summary") {
      try {
        ({ summary, usage } = await summarize(
          r.provider,
          r.model,
          r.history,
          reduction.from,
          focus,
          r.signal,
          new Map(saved.map((f) => [f.callId, f.path])),
        ));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.tracer.context?.({
          conversationId: r.conversationId,
          agent: r.agent.name,
          model: r.model.id,
          mode: "summary",
          from: reduction.from,
          tokens,
          manual,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          durationMs: Date.now() - started,
          problem: message,
        });
        if (!r.signal.aborted) {
          r.emit({
            type: "notice",
            scope: undefined,
            problem: {
              message: `Could not summarize the conversation: ${message}`,
              nextStep: "It goes on with the full history. Try Compact again later.",
            },
          });
        }
        return false;
      }
    }
    const costUsd = this.deps.providers.cost(r.model, usage);
    if (r.budget) r.budget.costUsd += costUsd;
    const contextMark: ContextMark = {
      ...mark(reduction, saved, tokens, { ...(summary ? { summary } : {}), manual, focus }),
      costUsd,
      agent: r.agent.name,
      model: r.model.id,
    };
    this.deps.store.append(r.conversationId, contextMark);
    r.history.push(contextMark);
    r.emit({ type: "message", scope: undefined, message: contextMark });
    this.deps.tracer.context?.({
      conversationId: r.conversationId,
      agent: r.agent.name,
      model: r.model.id,
      mode: reduction.mode,
      from: reduction.from,
      tokens,
      manual,
      inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      costUsd,
      durationMs: Date.now() - started,
      ...(summary ? { summary } : {}),
    });
    this.tokens.set(r.conversationId, overhead + estimate(modelView(r.history)));
    return true;
  }

  /** The context's size when no step measured it: after a restart. */
  private measure(history: StoredMessage[], agent: AgentProfile, context: string): number {
    return estimate(modelView(history)) + Math.round((agent.system.length + context.length) / 4);
  }

  /**
   * If the server died between storing a tool call and storing its result, the
   * call has no result and the next request would be rejected (C2). Answer it by
   * appending, never by rewriting history (C10).
   */
  private closeDanglingCalls(conversationId: string, history: StoredMessage[]) {
    const last = history.findLast((m) => m.role !== "context");
    if (last?.role !== "assistant") return;
    const parts = last.parts.flatMap((p) =>
      p.type === "tool_call"
        ? [
            {
              type: "tool_result" as const,
              callId: p.id,
              content: "Interrupted: the server stopped before this tool finished.",
              isError: true,
            },
          ]
        : [],
    );
    if (parts.length === 0) return;
    const message: StoredMessage = { role: "user", parts, agent: last.agent };
    this.deps.store.append(conversationId, message);
    history.push(message);
  }

  private updated(conversationId: string) {
    const conversation = this.deps.store.get(conversationId);
    if (conversation) this.listener.conversationUpdated(this.info(conversation));
  }
}

function unknownConversation(): Problem {
  return {
    message: "That conversation does not exist.",
    nextStep: "Pick one from the list or start a new one.",
  };
}
