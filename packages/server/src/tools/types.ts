import type {
  ApprovalAction,
  ConnectorInfo,
  Experiment,
  LoopEvent,
  ModelInfo,
  Problem,
  SkillInfo,
  SkillInput,
  ToolFile,
  ToolImage,
} from "@jabuti/protocol";
import type { z } from "zod";
import type { AgentProfile, ShellPermission } from "../agents/registry.ts";
import type { AgentState } from "../agents/state.ts";
import type { Sandbox } from "../sandbox/docker.ts";
import type { Skill } from "../skills/index.ts";

export interface ToolOutput {
  content: string;
  isError: boolean;
  /** Shown to the model with the content: view_images' mosaic (C21). */
  images?: ToolImage[];
  /** Shown to the owner only, below the call: images a connector generated (C21). */
  files?: ToolFile[];
}

/** The agent profiles, for the agents tool: the same rules as the settings screen. */
export interface AgentAdmin {
  profiles(): AgentProfile[];
  models(): ModelInfo[];
  /** MCP connectors a profile may list (C5). */
  connectors(): readonly ConnectorInfo[];
  /** Skills a profile may list (C4). */
  skills(): SkillInfo[];
  skill(name: string): Skill | undefined;
  /** Writes the owner's skill: a new one, or the owner's version of an existing one. */
  saveSkill(skill: SkillInput): Problem | undefined;
  save(profile: AgentProfile, create: boolean): Problem | undefined;
  /** Variables whose scope includes this agent name (C16). */
  variablesFor(agent: string): { name: string; shell: boolean }[];
}

export interface ToolContext {
  conversationId: string;
  callId: string;
  /** The agent running this step. Permissions are read from it at execution (C6, C9). */
  agent: AgentProfile;
  signal: AbortSignal;
  /** Read at each command, not when the turn started: the user may switch it (C9). */
  shellPermission: () => ShellPermission;
  /** The running agent's variables marked for its shell, read per command (C16). */
  shellEnv: () => Record<string, string>;
  sandbox: Sandbox;
  /** The agent whose workspace the shell uses: the conversation's, also for subagents. */
  workspace: string;
  /** A routine's run: nobody answers approvals, and what it writes is marked auto (C19). */
  unattended: boolean;
  /** Tells the autopilot of a new proposal, which may open its pull request (C19). */
  proposed: (experiment: Experiment) => void;
  state: AgentState;
  agentAdmin: AgentAdmin;
  /** Asks the user in the UI. Resolves false on denial or cancel. */
  requestApproval: (action: ApprovalAction) => Promise<boolean>;
  /** Runs another agent's loop on a fresh context and returns its final answer (C12). */
  runSubagent: (agent: AgentProfile, task: string) => Promise<ToolOutput>;
  /** The same, but in that agent's own workspace (the agents tool's run, C12). */
  runAgent: (agent: AgentProfile, task: string) => Promise<ToolOutput>;
  findAgent: (name: string) => AgentProfile | undefined;
  emit: (event: LoopEvent) => void;
  /** One of the running agent's skills, with its body; undefined for any other (C4). */
  skill: (name: string) => Skill | undefined;
}

export interface Tool<I = unknown> {
  name: string;
  description(agent: AgentProfile, findAgent: (name: string) => AgentProfile | undefined): string;
  input: z.ZodType<I>;
  /** JSON Schema sent to the model instead of one derived from `input` (MCP tools). */
  inputSchema?: Record<string, unknown>;
  execute(input: I, ctx: ToolContext): Promise<ToolOutput>;
}
