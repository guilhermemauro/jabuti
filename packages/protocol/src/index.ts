// The WebSocket messages between server and UI. This package is their only owner:
// both sides import the schemas from here and validate at the boundary.
import { z } from "zod";

// --- Conversation history (provider-neutral) ---

export const TextPart = z.object({ type: z.literal("text"), text: z.string() });
export const ToolCallPart = z.object({
  type: z.literal("tool_call"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
/** An image a tool shows the model, base64 without a data: prefix (view_images, C21). */
export const ToolImage = z.object({
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  data: z.string(),
});
export type ToolImage = z.infer<typeof ToolImage>;
/** An image a tool saved in a workspace, for the UI to show from /api/files; not sent to the model. */
export const ToolFile = z.object({ workspace: z.string(), path: z.string() });
export type ToolFile = z.infer<typeof ToolFile>;
export const ToolResultPart = z.object({
  type: z.literal("tool_result"),
  callId: z.string(),
  content: z.string(),
  isError: z.boolean(),
  images: z.array(ToolImage).optional(),
  files: z.array(ToolFile).optional(),
});

/** Where the UI's uploads land in the agent's workspace: uploads/<date>/<name>. */
export const UPLOAD_PATH = /^uploads\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,150}$/;
/**
 * A file the user attached, saved in the agent's workspace. An image also carries a
 * reduced copy, which the model sees with the message; any other file it reads there.
 */
export const AttachmentPart = z.object({
  type: z.literal("attachment"),
  path: z.string().regex(UPLOAD_PATH),
  name: z.string().max(200),
  mediaType: z.string().max(200),
  size: z.number().int().nonnegative(),
  image: ToolImage.extend({ data: z.string().max(4_000_000) }).optional(),
});
export type AttachmentPart = z.infer<typeof AttachmentPart>;

export const UserPart = z.discriminatedUnion("type", [TextPart, ToolResultPart, AttachmentPart]);
export const AssistantPart = z.discriminatedUnion("type", [TextPart, ToolCallPart]);
export type UserPart = z.infer<typeof UserPart>;
export type AssistantPart = z.infer<typeof AssistantPart>;

/**
 * A mark in the history where the model's view of the conversation was reduced (C10).
 * Nothing before it is deleted: the user still sees every message. From then on the
 * model sees, for a summary, the summary and the messages from `from` on; for a
 * clear, the saved tool results before `from` reduced to a line naming their file.
 */
export const ContextMark = z.object({
  role: z.literal("context"),
  /** Always empty: a mark holds no message parts. */
  parts: z.array(z.never()).max(0),
  mode: z.enum(["summary", "clear"]),
  /** Stored position of the first message kept as it was. */
  from: z.number().int().nonnegative(),
  /** The context's size in tokens when it was reduced. */
  tokens: z.number().int().nonnegative(),
  summary: z.string().optional(),
  /** How many tool results a clear reduced. */
  cleared: z.number().int().nonnegative().optional(),
  /**
   * Tool results taken out of the model's view, each saved whole in the agent's
   * workspace so it can read them again instead of running the tool. A clear reduces
   * only these.
   */
  saved: z.array(z.object({ callId: z.string(), path: z.string() })).optional(),
  /** Asked for by the owner, rather than reached by size. */
  manual: z.boolean(),
  focus: z.string().optional(),
  costUsd: z.number(),
  agent: z.string(),
  model: z.string(),
});
export type ContextMark = z.infer<typeof ContextMark>;

/** One stored message, with the agent and model active for the turn that wrote it (C6). */
export const HistoryMessage = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), parts: z.array(UserPart), agent: z.string() }),
  z.object({
    role: z.literal("assistant"),
    parts: z.array(AssistantPart),
    agent: z.string(),
    model: z.string(),
  }),
  ContextMark,
]);
export type HistoryMessage = z.infer<typeof HistoryMessage>;

// --- Agent profiles (agents/<name>/agent.json + system.md) ---

/** The name becomes a directory under data/agents/ and a Unix user in the runner. */
export const AGENT_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** ask: every command and package install; auto: none of them (C9, C17); deny: no shell. */
export const ShellPermission = z.enum(["ask", "auto", "deny"]);
export type ShellPermission = z.infer<typeof ShellPermission>;

/**
 * agents: creates and edits other agents' profiles, each change approved by the owner.
 * packages: installs system packages, with the shell (C17).
 * plan: keeps milestones and experiments, and runs on a routine (C19).
 */
export const ToolName = z.enum([
  "shell",
  "packages",
  "web_read",
  "page_structure",
  "site_crawl",
  "view_images",
  "delegate",
  "memory",
  "agents",
  "plan",
]);
export type ToolName = z.infer<typeof ToolName>;

/** agent.json, as on disk and as the settings screen edits it. */
export const AgentJson = z.strictObject({
  description: z.string().trim().min(1),
  /** Catalog model id: the default; a conversation may pick another. Subagents always use it. */
  model: z.string().min(1),
  budget: z.strictObject({
    maxSteps: z.number().int().positive(),
    maxCostUsd: z.number().positive(),
  }),
  /** memory: the agent keeps a brief and a memory across conversations (C14). */
  tools: z.array(ToolName),
  permissions: z.strictObject({ shell: ShellPermission }),
  /** Agents this one may hand a task to through the delegate tool (C12). */
  subagents: z.array(z.string()).default([]),
  /** MCP connectors it uses, by name (C5). Their credentials come from its variables. */
  mcp: z.array(z.string()).default([]),
  /** Skills it may load, by name (C4): listed in its system prompt, loaded on demand. */
  skills: z.array(z.string()).default([]),
  /** Reads what Jabuti knows about the user, shared by every agent that has this on (C18). */
  userMemory: z.boolean().default(true),
  /** After a conversation, proposes what to remember, for the owner to approve (C18). */
  capture: z.boolean().default(true),
});
export type AgentJson = z.infer<typeof AgentJson>;

export const AgentProfileData = AgentJson.extend({
  name: z.string().regex(AGENT_NAME, "Use lowercase letters, digits and hyphens."),
  system: z.string(),
});
export type AgentProfileData = z.infer<typeof AgentProfileData>;

// --- Settings ---

/** A skill agents may list (C4): built in (the repository's skills/) or the owner's. */
export const SkillInfo = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(["built-in", "owner"]),
});
export type SkillInfo = z.infer<typeof SkillInfo>;

/** A skill as the settings screen edits it. */
export const SkillData = SkillInfo.extend({
  body: z.string(),
  /** An owner's skill with a built-in's name: deleting it brings the built-in back. */
  replacesBuiltIn: z.boolean(),
});
export type SkillData = z.infer<typeof SkillData>;

/** What the owner or the agents tool saves as a skill (C4). */
export const SkillInput = z.strictObject({
  name: z.string().regex(AGENT_NAME, "Use lowercase letters, digits and hyphens."),
  description: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .refine((d) => !d.includes("\n"), "One line."),
  body: z.string().trim().min(1).max(60_000),
});
export type SkillInput = z.infer<typeof SkillInput>;

/** An MCP connector the harness can start, and the variables it needs (C5, C16). */
export const ConnectorInfo = z.object({
  name: z.string(),
  description: z.string(),
  variables: z.array(z.string()),
  /** For each variable: where the owner gets its value, in plain words. */
  help: z.record(z.string(), z.string()).optional(),
  /** Why no agent can use it yet, such as an OAuth server not connected. */
  problem: z.string().optional(),
});
export type ConnectorInfo = z.infer<typeof ConnectorInfo>;

/** A remote MCP server's name: also the middle of its tools' names, mcp__<name>__<tool>. */
export const MCP_SERVER_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** One tool of a registered server, as listed, with the owner's choice for it. */
export const McpToolRule = z.object({
  name: z.string(),
  description: z.string(),
  /** The server says the tool only reads (MCP readOnlyHint). */
  readOnly: z.boolean(),
  /** Offered to the agents that use the server. */
  on: z.boolean(),
  /** Each call waits for the owner's approval. */
  ask: z.boolean(),
});
export type McpToolRule = z.infer<typeof McpToolRule>;

/** A header sent to a registered server: ${NAME} is replaced by a variable's value (C16). */
export const McpHeader = z.object({
  name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "Letters, digits and hyphens."),
  value: z.string().max(4_096),
});

/** What the owner enters to register a remote MCP server. */
export const McpServerInput = z.strictObject({
  name: z
    .string()
    .max(30)
    .regex(MCP_SERVER_NAME, "Lowercase letters and digits, separated by single hyphens."),
  description: z.string().trim().min(1).max(300),
  url: z.string().trim().max(2_000),
  headers: z.array(McpHeader).max(10),
  /** Logs in with OAuth in the browser; the tokens are kept encrypted. */
  oauth: z.boolean(),
});
export type McpServerInput = z.infer<typeof McpServerInput>;

/** A registered server as the settings screen shows it: never a token. */
export const McpServerInfo = McpServerInput.extend({
  /** OAuth only: tokens are stored. */
  connected: z.boolean(),
  tools: z.array(McpToolRule),
  /** When its tools were last listed; absent before the first listing. */
  listedAt: z.string().optional(),
  /** Variables its headers name. */
  variables: z.array(z.string()),
});
export type McpServerInfo = z.infer<typeof McpServerInfo>;

/** Variable names as in a shell: FOO_BAR. */
export const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** A variable as the UI sees it: never its value (C16). */
export const VariableInfo = z.object({
  /** One value of the name: a name may hold one per scope. */
  id: z.string(),
  name: z.string(),
  /** "all", or the agents that may use it. */
  scope: z.union([z.literal("all"), z.array(z.string())]),
  /** Injected into the shell of agents in scope: their model can then read it. */
  shell: z.boolean(),
  updatedAt: z.string(),
  /** Set when the stored value cannot be decrypted (the secret key changed). */
  problem: z.string().optional(),
});
export type VariableInfo = z.infer<typeof VariableInfo>;

/** A variable Jabuti itself uses, with how to get it and who still lacks it. */
export const KnownVariable = z.object({
  name: z.string(),
  /** What reads it: a connector, or plan publishing. */
  usedBy: z.string(),
  help: z.string(),
  /** Agents that use it and have no value for it in their scope yet. */
  missingFor: z.array(z.string()),
});
export type KnownVariable = z.infer<typeof KnownVariable>;

export const ProviderKeyInfo = z.object({
  provider: z.string(),
  /** environment: from the server's environment (.env), read-only in the UI. */
  source: z.enum(["settings", "environment", "none"]),
});
export type ProviderKeyInfo = z.infer<typeof ProviderKeyInfo>;

// --- Notes (C14) ---

/**
 * Who wrote a note, set by Jabuti, never by the model: the owner in Settings; the
 * agent in a conversation with the owner (chat) or in an unattended run (auto); or
 * the capture, approved by the owner.
 */
export const NoteSource = z.enum(["owner", "chat", "auto", "capture"]);
export type NoteSource = z.infer<typeof NoteSource>;

/** One note an agent keeps, as Jabuti stores and indexes it. */
export const Note = z.object({
  /** m-0001, never reused. */
  id: z.string(),
  /** Of the last change, YYYY-MM-DD. */
  date: z.string(),
  source: NoteSource,
  /** The conversation that last changed it, if any. */
  conversation: z.string().optional(),
  /** One line: what the index shows. */
  summary: z.string(),
  /** When to look at it again, YYYY-MM-DD. */
  check: z.string().optional(),
  body: z.string(),
  /** Relative to the agent's folder, such as memories/m-0001-faq.md. */
  path: z.string(),
});
export type Note = z.infer<typeof Note>;

// --- Plan, experiments and routine (C19) ---

export const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * proposed: the agent suggested it, waiting for the owner. pending: approved, not
 * started. running: being worked on. done: its criterion was measured. dropped.
 */
export const MilestoneStatus = z.enum(["proposed", "pending", "running", "done", "dropped"]);
export type MilestoneStatus = z.infer<typeof MilestoneStatus>;

export const Milestone = z.object({
  /** M1, M2…, never reused. */
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  /** A measurable criterion: the agent cannot mark it done without evidence. */
  doneWhen: z.string(),
  due: z.string().optional(),
  dependsOn: z.array(z.string()),
  /** Lower runs first. */
  priority: z.number(),
  status: MilestoneStatus,
  /** The agent's latest progress line. */
  progress: z.string().optional(),
  /** What showed the criterion met, when done. */
  evidence: z.string().optional(),
  /** The agent asks to drop it, with this reason; the owner decides. */
  dropRequest: z.string().optional(),
  createdBy: z.enum(["owner", "agent"]),
  updatedAt: z.string(),
});
export type Milestone = z.infer<typeof Milestone>;

export const ChangeKind = z.enum([
  "title",
  "meta",
  "content",
  "faq",
  "links",
  "schema",
  "new-page",
  "technical",
  "other",
]);
export type ChangeKind = z.infer<typeof ChangeKind>;

/**
 * proposed: waiting for the owner. live: published, being measured, its pages locked.
 * done: every check recorded. rejected or withdrawn: never published.
 */
export const ExperimentStatus = z.enum(["proposed", "live", "done", "rejected", "withdrawn"]);
export type ExperimentStatus = z.infer<typeof ExperimentStatus>;

export const Experiment = z.object({
  /** e-0001, never reused. */
  id: z.string(),
  milestone: z.string(),
  /** Paths, normalized by Jabuti: /blog/post. */
  urls: z.array(z.string()),
  kind: ChangeKind,
  change: z.string(),
  hypothesis: z.string(),
  metric: z.string(),
  /** With its period and source, such as "CTR 0.8%, GSC 28 days to 2026-11-01". */
  baseline: z.string(),
  /** Where the change waits: a git branch. */
  branch: z.string().optional(),
  /** Its branch on GitHub against the base, once Jabuti pushed it: for the owner to review. */
  compare: z.string().optional(),
  /** Why the last publishing step failed, shown to the owner. */
  issue: z.string().optional(),
  status: ExperimentStatus,
  createdAt: z.string(),
  /** The day it went live: day zero of its checks. */
  liveAt: z.string().optional(),
  /** Days after going live, each with its date once live, and what was measured. */
  checks: z.array(
    z.object({ day: z.number(), date: z.string().optional(), result: z.string().optional() }),
  ),
  rejectReason: z.string().optional(),
  /** When the owner rejected it: the cooldown counts from here. */
  decidedAt: z.string().optional(),
  conversation: z.string().optional(),
});
export type Experiment = z.infer<typeof Experiment>;

export const Weekday = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type Weekday = z.infer<typeof Weekday>;

/** When the agent runs alone: it measures every day and acts on actDays. */
export const Routine = z.strictObject({
  enabled: z.boolean(),
  /** HH:MM in timeZone. */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM."),
  timeZone: z.string().min(1),
  actDays: z.array(Weekday),
  /** Unattended runs stop for the month once they have spent this much. */
  monthlyCapUsd: z.number().positive(),
});
export type Routine = z.infer<typeof Routine>;

/** How much the agent may change at once (C19). */
export const PlanLimits = z.strictObject({
  openProposals: z.number().int().positive(),
  rejectCooldownDays: z.number().int().nonnegative(),
  checkDays: z.array(z.number().int().positive()).min(1),
});
export type PlanLimits = z.infer<typeof PlanLimits>;

/**
 * Where approved changes go. Without it, the owner publishes and marks them live.
 * With it, Jabuti pushes and merges with a deploy key only it holds (C19).
 */
export const Publish = z.strictObject({
  github: z.strictObject({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "Use owner/name."),
    base: z.string().min(1),
    /** The clone's folder in the agent's workspace. */
    path: z
      .string()
      .regex(
        /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/,
        "A folder, relative.",
      )
      .default("repo"),
  }),
});
export type Publish = z.infer<typeof Publish>;

/** The deploy key Jabuti made for an agent: its public half, and whether GitHub took it. */
export const DeployKey = z.object({
  publicKey: z.string(),
  fingerprint: z.string(),
  /** When Jabuti last reached the repository with it. */
  checkedAt: z.string().optional(),
  /** Why the last check failed. */
  problem: z.string().optional(),
});
export type DeployKey = z.infer<typeof DeployKey>;

/** One unattended run, its report the agent's final answer. */
export const RunReport = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum(["measure", "act"]),
  conversation: z.string(),
  costUsd: z.number(),
  /** How the run ended: done, budget, error… */
  reason: z.string(),
  text: z.string(),
  read: z.boolean(),
});
export type RunReport = z.infer<typeof RunReport>;

/** An approval an unattended run could not get: refused, and shown to the owner. */
export const Decision = z.object({
  id: z.string(),
  at: z.string(),
  conversation: z.string(),
  summary: z.string(),
});
export type Decision = z.infer<typeof Decision>;

export const AgentPlan = z.object({
  agent: z.string(),
  milestones: z.array(Milestone),
  experiments: z.array(Experiment),
  /** Pages kept unchanged to compare against: no proposal touches them. */
  controls: z.array(z.string()),
  routine: Routine,
  limits: PlanLimits,
  publish: Publish.nullable(),
  deployKey: DeployKey.nullable().default(null),
  /** Newest first. */
  runs: z.array(RunReport),
  decisions: z.array(Decision),
  /** Spent by unattended runs this month (UTC). */
  monthSpentUsd: z.number(),
  /** The next unattended run, in the routine's time zone; absent when off or capped. */
  nextRun: z
    .object({ day: z.string(), time: z.string(), kind: z.enum(["measure", "act"]) })
    .optional(),
  /** Why the routine is not running, such as the monthly cap. */
  paused: z.string().optional(),
});
export type AgentPlan = z.infer<typeof AgentPlan>;

const MilestoneFields = z.object({
  title: z.string().trim().min(1),
  goal: z.string().trim().min(1),
  doneWhen: z.string().trim().min(1),
  due: z.string().regex(DAY).nullable(),
  dependsOn: z.array(z.string()),
  priority: z.number(),
});

/** What the owner does on the Plan and Inbox screens. */
export const PlanAction = z.discriminatedUnion("op", [
  /** Without id: a new milestone, approved by being the owner's. */
  z.object({
    op: z.literal("milestone.save"),
    id: z.string().optional(),
    fields: MilestoneFields,
    status: MilestoneStatus.optional(),
  }),
  /** A proposed milestone, or a request to drop one. */
  z.object({ op: z.literal("milestone.decide"), id: z.string(), approve: z.boolean() }),
  z.object({
    op: z.literal("experiment.decide"),
    id: z.string(),
    approve: z.boolean(),
    reason: z.string().optional(),
  }),
  z.object({ op: z.literal("controls.save"), urls: z.array(z.string()) }),
  z.object({ op: z.literal("routine.save"), routine: Routine }),
  z.object({ op: z.literal("limits.save"), limits: PlanLimits }),
  z.object({ op: z.literal("publish.save"), publish: Publish.nullable() }),
  /** Makes the agent's deploy key if it has none, and shows its public half. */
  z.object({ op: z.literal("publish.key") }),
  /** Checks that the key reaches the repository. */
  z.object({ op: z.literal("publish.test") }),
  z.object({ op: z.literal("run"), kind: z.enum(["measure", "act", "draft"]) }),
  z.object({ op: z.literal("report.read"), id: z.string() }),
  z.object({ op: z.literal("decision.dismiss"), id: z.string() }),
]);
export type PlanAction = z.infer<typeof PlanAction>;

/** The running version and the newest release, for the owner to update (deploy/). */
export const VersionInfo = z.object({
  /** The release tag this image was built from, such as v0.1.2; "dev" for any other build. */
  current: z.string(),
  commit: z.string().nullable(),
  /** owner/name on GitHub, where releases are published. */
  repository: z.string(),
  latest: z
    .object({
      version: z.string(),
      url: z.string(),
      notes: z.string(),
      publishedAt: z.string().nullable(),
    })
    .nullable(),
  /** Whether latest is newer than current. */
  newer: z.boolean(),
  checkedAt: z.string().nullable(),
  problem: z.object({ message: z.string(), nextStep: z.string() }).nullable(),
});
export type VersionInfo = z.infer<typeof VersionInfo>;

/** A template's newer version of an agent's file (C22). */
export const TemplateUpdate = z.object({
  agent: z.string(),
  template: z.string(),
  file: z.enum(["system.md", "agent.json"]),
  /** Lines of the agent's file now against the template's: "- " removed, "+ " added. */
  diff: z.string(),
  /** applied: written at this start, the owner had not changed the file. available: the owner decides. */
  status: z.enum(["applied", "available"]),
});
export type TemplateUpdate = z.infer<typeof TemplateUpdate>;

export const SettingsSnapshot = z.object({
  agents: z.array(AgentProfileData),
  /** Starting points for a new agent (the repository's agents/ folder). */
  templates: z.array(AgentProfileData),
  templateUpdates: z.array(TemplateUpdate),
  variables: z.array(VariableInfo),
  providerKeys: z.array(ProviderKeyInfo),
  /** The built-in connectors and the registered servers, as agents list them (C5). */
  connectors: z.array(ConnectorInfo),
  /** The remote MCP servers the owner registered. */
  mcpServers: z.array(McpServerInfo),
  /** The owner's domain on a server (deploy/); null while it answers on its sslip.io name. */
  domain: z.string().nullable(),
  version: VersionInfo,
  skills: z.array(SkillData),
  knownVariables: z.array(KnownVariable),
  /** Setup issues worth fixing, such as a secret key stored next to the data. */
  warnings: z.array(z.object({ message: z.string(), nextStep: z.string() })),
  /** What agents keep across conversations, editable by the owner (C14, C18). */
  memory: z.object({
    user: z.string(),
    agents: z.array(z.object({ name: z.string(), brief: z.string(), notes: z.array(Note) })),
    /** Characters in the brief and in user memory. */
    limit: z.number(),
    /** Characters in a note's summary and body. */
    summaryLimit: z.number(),
    bodyLimit: z.number(),
  }),
});
export type SettingsSnapshot = z.infer<typeof SettingsSnapshot>;

// --- Memory capture (C18) ---

/**
 * One proposed change. `before` is the item (user) or the note's summary (agent) as
 * the capture read it: an edit made meanwhile means nothing is written.
 */
export const MemoryChange = z.object({
  op: z.enum(["add", "update", "remove"]),
  /** user: shared by agents with user memory; agent: the agent's own notes. */
  scope: z.enum(["user", "agent"]),
  text: z.string(),
  before: z.string().optional(),
  /** The user's words it comes from, so the owner can judge it. */
  evidence: z.string(),
  /** agent scope: the note it updates or removes. */
  id: z.string().optional(),
});
export type MemoryChange = z.infer<typeof MemoryChange>;

export const MemoryProposal = z.object({
  id: z.string(),
  conversationId: z.string(),
  conversationTitle: z.string(),
  agent: z.string(),
  changes: z.array(MemoryChange),
  costUsd: z.number(),
  createdAt: z.string(),
});
export type MemoryProposal = z.infer<typeof MemoryProposal>;

// --- Catalog ---

export const AgentInfo = z.object({
  name: z.string(),
  description: z.string(),
  model: z.string(),
  /** The profile's shell permission: ask, auto, or deny (no shell). */
  shell: ShellPermission,
});
export type AgentInfo = z.infer<typeof AgentInfo>;

export const ModelInfo = z.object({
  id: z.string(),
  label: z.string(),
  /** False when the provider has no credentials configured. */
  available: z.boolean(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

/** ask: every command and package install. auto: none of them (C9, C17). */
export const ShellMode = z.enum(["ask", "auto"]);
export type ShellMode = z.infer<typeof ShellMode>;

export const ConversationInfo = z.object({
  id: z.string(),
  title: z.string(),
  agent: z.string(),
  /** The conversation's model choice; null runs the agent's own model. */
  model: z.string().nullable(),
  /** The conversation's shell mode; null follows the agent's profile. */
  shellMode: ShellMode.nullable(),
  running: z.boolean(),
  /** Approvals waiting for the owner, its subagents' included (C9). */
  waiting: z.number(),
  /** Started by the agent's routine, with nobody watching (C19). */
  unattended: z.boolean(),
});
export type ConversationInfo = z.infer<typeof ConversationInfo>;

/** A failure as the user sees it: what happened and what to do next (C11). */
export const Problem = z.object({ message: z.string(), nextStep: z.string() });
export type Problem = z.infer<typeof Problem>;

// --- Loop events ---

export const TurnEndReason = z.enum([
  "done",
  "budget_steps",
  "budget_cost",
  "max_tokens",
  "refusal",
  "cancelled",
  "error",
]);
export type TurnEndReason = z.infer<typeof TurnEndReason>;

/** What the user is asked to approve. */
export const ApprovalAction = z.discriminatedUnion("kind", [
  /** A command in ask mode (C9). */
  z.object({ kind: z.literal("shell"), command: z.string() }),
  /** A write to one of the agent's own files; diff lines start with "+ ", "- " or "  ". */
  z.object({
    kind: z.literal("file"),
    file: z.string(),
    diff: z.string(),
    /** What the change implies beyond the diff, such as variables the agent will receive. */
    notes: z.array(z.string()).optional(),
  }),
  /** Another agent works on a task in its own workspace, with its own variables (C12, C16). */
  z.object({
    kind: z.literal("run"),
    agent: z.string(),
    task: z.string(),
    /** The variables that agent's commands receive. */
    notes: z.array(z.string()).optional(),
  }),
  /** System packages installed as root, by name only (C17). */
  z.object({ kind: z.literal("packages"), packages: z.array(z.string()) }),
  /** A registered MCP server's tool the owner set to ask first (C5). */
  z.object({
    kind: z.literal("mcp"),
    server: z.string(),
    tool: z.string(),
    /** The call's arguments, as JSON. */
    input: z.string(),
  }),
]);
export type ApprovalAction = z.infer<typeof ApprovalAction>;

/** Set when the event comes from a subagent run through the delegate tool. */
const Scope = z.object({ callId: z.string(), agent: z.string() }).optional();

export const LoopEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("turn.started"), agent: z.string(), model: z.string() }),
  z.object({ type: z.literal("text.delta"), scope: Scope, text: z.string() }),
  z.object({
    type: z.literal("message"),
    scope: Scope,
    message: HistoryMessage,
  }),
  z.object({
    type: z.literal("tool.started"),
    scope: Scope,
    callId: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal("approval.requested"),
    scope: Scope,
    approvalId: z.string(),
    callId: z.string(),
    agent: z.string(),
    action: ApprovalAction,
  }),
  z.object({ type: z.literal("approval.resolved"), approvalId: z.string(), approved: z.boolean() }),
  z.object({
    type: z.literal("tool.finished"),
    scope: Scope,
    callId: z.string(),
    content: z.string(),
    isError: z.boolean(),
    images: z.array(ToolImage).optional(),
    files: z.array(ToolFile).optional(),
  }),
  /** A problem that does not stop the turn, such as a connector that did not start (C5, C11). */
  z.object({ type: z.literal("notice"), scope: Scope, problem: Problem }),
  z.object({
    type: z.literal("subagent.finished"),
    callId: z.string(),
    agent: z.string(),
    reason: TurnEndReason,
  }),
  z.object({
    type: z.literal("turn.finished"),
    reason: TurnEndReason,
    steps: z.number(),
    costUsd: z.number(),
    problem: Problem.optional(),
  }),
]);
export type LoopEvent = z.infer<typeof LoopEvent>;

// --- Wire messages ---

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("conversation.create"), agent: z.string() }),
  z.object({ type: z.literal("conversation.open"), conversationId: z.string() }),
  z.object({
    type: z.literal("conversation.selectModel"),
    conversationId: z.string(),
    /** null goes back to the agent's model. */
    model: z.string().nullable(),
  }),
  z.object({
    type: z.literal("conversation.selectShellMode"),
    conversationId: z.string(),
    /** null goes back to the agent's profile. */
    mode: ShellMode.nullable(),
  }),
  z.object({
    type: z.literal("message.send"),
    conversationId: z.string(),
    /** May be empty when the message carries attachments. */
    text: z.string().trim(),
    attachments: z.array(AttachmentPart).max(10).optional(),
  }),
  z.object({ type: z.literal("approval.respond"), approvalId: z.string(), approved: z.boolean() }),
  z.object({ type: z.literal("settings.open") }),
  z.object({
    type: z.literal("variable.save"),
    /** The value to change; omitted for a new value of the name. */
    id: z.string().optional(),
    name: z.string().regex(VARIABLE_NAME, "Use A-Z, 0-9 and _, starting with a letter or _."),
    /** Omitted to keep the stored value and change only scope or shell. */
    value: z
      .string()
      .max(64 * 1024)
      .optional(),
    scope: z.union([z.literal("all"), z.array(z.string())]),
    shell: z.boolean(),
  }),
  z.object({ type: z.literal("variable.delete"), id: z.string() }),
  z.object({
    type: z.literal("providerKey.save"),
    provider: z.string(),
    /** null removes the key stored in settings. */
    key: z.string().trim().min(1).max(4096).nullable(),
  }),
  z.object({
    type: z.literal("agent.save"),
    profile: AgentProfileData,
    /** true when creating: refused if the agent exists. */
    create: z.boolean(),
  }),
  z.object({ type: z.literal("agent.delete"), name: z.string() }),
  /** A template update the owner changed: apply the template's file, or keep theirs (C22). */
  z.object({
    type: z.literal("agent.template"),
    name: z.string(),
    file: z.enum(["system.md", "agent.json"]),
    apply: z.boolean(),
  }),
  /** Re-reads agents/<name>/ from disk after editing the files by hand. */
  z.object({ type: z.literal("agents.reload") }),
  /** Writes the owner's skill (C4); a built-in's name makes the owner's version of it. */
  z.object({ type: z.literal("skill.save"), skill: SkillInput, create: z.boolean() }),
  /** Deletes the owner's skill; a built-in it replaced comes back. */
  z.object({ type: z.literal("skill.delete"), name: z.string() }),
  /** Registers or edits a remote MCP server (C5). */
  z.object({ type: z.literal("mcp.save"), server: McpServerInput, create: z.boolean() }),
  z.object({ type: z.literal("mcp.delete"), name: z.string() }),
  /** Connects to the server and lists its tools, keeping the choices already made. */
  z.object({ type: z.literal("mcp.list"), name: z.string() }),
  /** Which tools agents get, and which ask first. */
  z.object({
    type: z.literal("mcp.tools"),
    name: z.string(),
    tools: z.array(z.object({ name: z.string(), on: z.boolean(), ask: z.boolean() })),
  }),
  /** Starts the OAuth login: the reply is mcp.authorize, a page to open. */
  z.object({ type: z.literal("mcp.connect"), name: z.string() }),
  /** Forgets the server's OAuth tokens. */
  z.object({ type: z.literal("mcp.disconnect"), name: z.string() }),
  /** Sets the instance's domain, checked against the address the owner is on; null forgets it. */
  z.object({ type: z.literal("domain.save"), domain: z.string().max(253).nullable() }),
  z.object({ type: z.literal("turn.cancel"), conversationId: z.string() }),
  /** Summarizes the conversation for the model now (C10); focus says what to keep. */
  z.object({
    type: z.literal("conversation.compact"),
    conversationId: z.string(),
    focus: z.string().trim().max(500).optional(),
  }),
  /** Reads what is new in the conversation now, instead of waiting for it to go idle. */
  z.object({ type: z.literal("memory.capture"), conversationId: z.string() }),
  /** Saves the chosen changes, as the owner edited them; none discards the proposal. */
  z.object({
    type: z.literal("memory.decide"),
    proposalId: z.string(),
    accept: z.array(z.object({ index: z.number().int().nonnegative(), text: z.string() })),
  }),
  /** The owner edits a file by hand: an agent's brief, or (agent null) user memory. */
  z.object({
    type: z.literal("memory.save"),
    agent: z.string().nullable(),
    content: z.string(),
  }),
  /** The owner writes or confirms a note (without id: a new one); its source becomes owner. */
  z.object({
    type: z.literal("note.save"),
    agent: z.string(),
    id: z.string().optional(),
    summary: z.string(),
    body: z.string(),
    check: z.string().nullable(),
  }),
  z.object({ type: z.literal("note.delete"), agent: z.string(), id: z.string() }),
  z.object({ type: z.literal("plan.action"), agent: z.string(), action: PlanAction }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("init"),
    agents: z.array(AgentInfo),
    models: z.array(ModelInfo),
    conversations: z.array(ConversationInfo),
    /** Problems found at startup, such as an invalid agent profile. */
    problems: z.array(Problem),
  }),
  z.object({
    type: z.literal("conversation.opened"),
    conversation: ConversationInfo,
    history: z.array(HistoryMessage),
  }),
  z.object({ type: z.literal("conversation.updated"), conversation: ConversationInfo }),
  /** Agents, models or their problems changed (settings saved, profiles reloaded). */
  z.object({
    type: z.literal("catalog.updated"),
    agents: z.array(AgentInfo),
    models: z.array(ModelInfo),
    problems: z.array(Problem),
  }),
  z.object({ type: z.literal("settings"), settings: SettingsSnapshot }),
  /** A settings change worked; the UI shows it briefly. */
  z.object({ type: z.literal("settings.saved"), message: z.string() }),
  /** Open this page to log in to a registered MCP server (OAuth). */
  z.object({ type: z.literal("mcp.authorize"), name: z.string(), url: z.string() }),
  z.object({ type: z.literal("event"), conversationId: z.string(), event: LoopEvent }),
  z.object({ type: z.literal("problem"), problem: Problem }),
  /** Proposals waiting for the owner, and the last capture failure if any (C11, C18). */
  z.object({
    type: z.literal("memory"),
    proposals: z.array(MemoryProposal),
    problem: Problem.optional(),
  }),
  /** Every plan, sent at connect and after any change (C19). */
  z.object({ type: z.literal("plans"), plans: z.array(AgentPlan) }),
  /** A run the owner started: the client opens it. */
  z.object({ type: z.literal("conversation.started"), conversationId: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/**
 * A note's summary: one line in the index. Models are asked for the target; the limit,
 * checked by the server and shown by the UI, leaves room for a line that runs a little over.
 */
export const NOTE_SUMMARY_TARGET = 120;
export const NOTE_SUMMARY_LIMIT = 150;
