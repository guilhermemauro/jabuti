// Builds a real Runtime around the fake model, an in-memory store and a fake
// sandbox, and records everything the UI would see.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationInfo, LoopEvent, MemoryProposal, Problem } from "@jabuti/protocol";
import { AgentRegistry, type AgentProfile } from "../packages/server/src/agents/registry.ts";
import { AgentState } from "../packages/server/src/agents/state.ts";
import { Autopilot } from "../packages/server/src/autopilot/index.ts";
import { ConversationStore } from "../packages/server/src/conversations/store.ts";
import { openDatabase } from "../packages/server/src/db/index.ts";
import { Runtime } from "../packages/server/src/loop/runtime.ts";
import type { ConnectorSpec } from "../packages/server/src/mcp/catalog.ts";
import type { Mcp } from "../packages/server/src/mcp/index.ts";
import { Capture } from "../packages/server/src/memory/capture.ts";
import { Providers } from "../packages/server/src/providers/index.ts";
import type {
  ExecOptions,
  ExecResult,
  GitRequest,
  GitResult,
  Sandbox,
} from "../packages/server/src/sandbox/docker.ts";
import type { Settings } from "../packages/server/src/settings/index.ts";
import type { Skills } from "../packages/server/src/skills/index.ts";
import type { CaptureTrace, StepTrace, Tracer } from "../packages/server/src/tracer/index.ts";
import { FAKE_MODEL, FAKE_OTHER, FakeModel, type Script } from "./fake-model/index.ts";

export function agent(name: string, overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name,
    description: `${name} agent`,
    system: `You are ${name}.`,
    model: FAKE_MODEL.id,
    budget: { maxSteps: 10, maxCostUsd: 1 },
    tools: ["shell"],
    permissions: { shell: "auto" },
    subagents: [],
    mcp: [],
    skills: [],
    // Off unless a test is about them (C18): they add a tool and a capture call.
    userMemory: false,
    capture: false,
    ...overrides,
  };
}

class FakeSandbox implements Sandbox {
  readonly commands: string[] = [];
  /** The workspace each command ran in. */
  readonly workspaces: string[] = [];
  /** The variables each command received. */
  readonly envs: Record<string, string>[] = [];
  next: (command: string) => ExecResult | Promise<ExecResult> = () => ({
    exitCode: 0,
    output: "ok",
    timedOut: false,
  });

  /** Each install request: the packages, in order. */
  readonly installs: string[][] = [];

  install(_workspace: string, packages: string[]) {
    this.installs.push(packages);
    return Promise.resolve({ exitCode: 0, output: "ok", timedOut: false });
  }

  /** Each file written into a workspace (C5). */
  readonly files: { workspace: string; path: string; content: string | Buffer }[] = [];

  writeFile(workspace: string, path: string, content: string | Buffer) {
    this.files.push({ workspace, path, content });
    return Promise.resolve();
  }

  /** Each file read from a workspace, and the bytes it returns (C21). */
  readonly reads: { workspace: string; path: string }[] = [];
  readNext: (path: string) => Buffer = (path) => Buffer.from(`synthetic bytes of ${path}`);

  readFile(workspace: string, path: string) {
    this.reads.push({ workspace, path });
    return Promise.resolve(this.readNext(path));
  }

  /** Each publishing step asked of the runner, with its workspace (C19). */
  readonly gits: (GitRequest & { workspace: string })[] = [];
  gitNext: (request: GitRequest) => GitResult = (request) =>
    request.action === "key"
      ? {
          ok: true,
          output: "",
          publicKey: "ssh-ed25519 AAAAsynthetic jabuti-test",
          fingerprint: "SHA256:synthetic",
        }
      : { ok: true, output: `${request.action} done.` };

  git(workspace: string, request: GitRequest) {
    this.gits.push({ workspace, ...request });
    return Promise.resolve(this.gitNext(request));
  }

  async exec(workspace: string, command: string, options: ExecOptions) {
    this.commands.push(command);
    this.workspaces.push(workspace);
    this.envs.push(options.env);
    return this.next(command);
  }
}

export type ApprovalPolicy = "approve" | "deny" | "wait";

export function harness(options: {
  script: Script;
  agents?: AgentProfile[];
  tracer?: Tracer;
  approvals?: ApprovalPolicy;
  /** Agent brief and memory on disk; a fresh temporary directory by default. */
  state?: AgentState;
  /** Variables for agents' shells; none by default. */
  settings?: Settings;
  /** Profiles on disk, for tests that save agents; in memory from `agents` otherwise. */
  registry?: AgentRegistry;
  /** MCP connectors and the clients that start them (C5). */
  mcp?: Mcp;
  connectors?: ConnectorSpec[];
  /** Skills agents may list (C4); none by default. */
  skills?: Skills;
  /** Memory capture (C18) on the fake model; off by default. */
  capture?: { idleMs?: number; model?: string };
  /** Plans and routines (C19): a clock. Publishing goes to the fake sandbox's git. */
  autopilot?: { now: () => Date };
}) {
  const model = new FakeModel(options.script);
  const sandbox = new FakeSandbox();
  const traces: StepTrace[] = [];
  const captures: CaptureTrace[] = [];
  const tracer = options.tracer ?? {
    step: (t: StepTrace) => traces.push(t),
    capture: (t: CaptureTrace) => captures.push(t),
  };
  const events: LoopEvent[] = [];
  const updates: ConversationInfo[] = [];
  const db = openDatabase(":memory:");
  const store = new ConversationStore(db);
  const agents = options.registry ?? new AgentRegistry(options.agents ?? [agent("assistant")]);
  const profiles = agents.profiles();
  let catalogChanges = 0;
  const state = options.state ?? new AgentState(mkdtempSync(join(tmpdir(), "jabuti-state-")));
  const providers = Providers.withClients([FAKE_MODEL, FAKE_OTHER], [model]);
  const policy = options.approvals ?? "approve";
  /** What the UI was last told about memory proposals. */
  const memory: { proposals: MemoryProposal[]; problem: Problem | undefined } = {
    proposals: [],
    problem: undefined,
  };
  const capture = options.capture
    ? new Capture(
        {
          db,
          store,
          state,
          agents,
          providers,
          tracer,
          model: options.capture.model ?? FAKE_MODEL.id,
          // Called only after the runtime below exists.
          isRunning: (id) => runtime.busy(id),
          idleMs: options.capture.idleMs ?? 60_000,
          today: () => "2026-01-15",
        },
        {
          memoryChanged: (proposals, problem) => {
            memory.proposals = proposals;
            memory.problem = problem;
          },
        },
      )
    : undefined;

  const autopilot = options.autopilot
    ? new Autopilot(
        {
          state,
          agents,
          sandbox,
          now: options.autopilot.now,
        },
        { plansChanged: () => undefined },
      )
    : undefined;

  const runtime: Runtime = new Runtime(
    {
      agents,
      providers,
      store,
      sandbox,
      state,
      settings: options.settings,
      mcp: options.mcp,
      connectors: options.connectors,
      ...(options.skills ? { skills: options.skills } : {}),
      tracer,
      capture,
      autopilot,
    },
    {
      event: (_, event) => {
        events.push(event);
        if (event.type === "approval.requested" && policy !== "wait") {
          queueMicrotask(() => runtime.respondApproval(event.approvalId, policy === "approve"));
        }
      },
      conversationUpdated: (conversation) => {
        updates.push(conversation);
      },
      catalogChanged: () => {
        catalogChanges++;
      },
    },
  );

  autopilot?.wire(runtime);

  const created = runtime.create(profiles[0]?.name ?? "assistant");
  if (!("id" in created)) throw new Error(created.message);
  const conversationId = created.id;

  return {
    model,
    db,
    capture,
    autopilot,
    memory,
    agents,
    providers,
    sandbox,
    state,
    traces,
    captures,
    events,
    /** What every client was told about conversations, in order. */
    updates,
    store,
    runtime,
    conversationId,
    catalogChanges: () => catalogChanges,
    history: () => store.history(conversationId),
    /** Sends a message and waits for the turn to finish; returns its final event. */
    async turn(text: string) {
      const problem = runtime.send(conversationId, text);
      if (problem) throw new Error(problem.message);
      await runtime.idle(conversationId);
      const last = events.at(-1);
      if (last?.type !== "turn.finished") throw new Error("turn did not finish");
      return last;
    },
  };
}

/** Every tool call in the history, paired with how many results answer it. */
export function resultCounts(history: ReturnType<ReturnType<typeof harness>["history"]>) {
  const counts = new Map<string, number>();
  for (const message of history) {
    for (const part of message.parts) {
      if (part.type === "tool_call") counts.set(part.id, counts.get(part.id) ?? 0);
      if (part.type === "tool_result") counts.set(part.callId, (counts.get(part.callId) ?? 0) + 1);
    }
  }
  return counts;
}
