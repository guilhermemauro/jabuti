// UI state, derived only from server messages. The server owns the truth.
import type {
  AgentInfo,
  AgentPlan,
  ApprovalAction,
  AttachmentPart,
  ConversationInfo,
  ContextMark,
  HistoryMessage,
  LoopEvent,
  MemoryProposal,
  ModelInfo,
  ToolFile,
  ToolImage,
  Problem,
  ServerMessage,
  SettingsSnapshot,
  TurnEndReason,
  UserPart,
} from "@jabuti/protocol";

export interface ToolItem {
  kind: "tool";
  callId: string;
  name: string;
  input: unknown;
  approval?: {
    approvalId: string;
    action: ApprovalAction;
    state: "pending" | "approved" | "denied";
  };
  result?: { content: string; isError: boolean; images?: ToolImage[]; files?: ToolFile[] };
  /** Subagent activity, when this is a delegate call. */
  children: Item[];
  streaming: string;
  subagentReason?: TurnEndReason;
}

/** A file the user attached, as the transcript shows it (without the model's copy). */
export type Attached = Omit<AttachmentPart, "type" | "image">;

export type Item =
  | { kind: "user"; text: string; attachments?: Attached[] }
  | { kind: "assistant"; text: string; agent: string; model: string }
  | ToolItem
  | { kind: "turn"; reason: TurnEndReason; steps: number; costUsd: number; problem?: Problem }
  /** A problem that did not stop the turn, such as a connector that did not start. */
  | { kind: "notice"; problem: Problem }
  /** Where the model's view of the conversation was reduced (C10). */
  | { kind: "context"; mark: ContextMark };

interface Open {
  conversation: ConversationInfo;
  items: Item[];
  streaming: string;
}

export interface State {
  connected: boolean;
  agents: AgentInfo[];
  models: ModelInfo[];
  conversations: ConversationInfo[];
  problems: Problem[];
  open?: Open;
  /** Filled while the settings screen is open; never holds secret values. */
  settings?: SettingsSnapshot;
  /** The last settings change that worked, shown briefly. */
  notice?: string;
  /** What to remember, waiting for the owner, and why the last capture failed (C18). */
  memory: { proposals: MemoryProposal[]; problem?: Problem };
  /** Every agent's plan, routine and inbox items (C19). */
  plans: AgentPlan[];
  /** A run the owner just started: the app switches to it. */
  started?: string;
  /** A registered MCP server's login page, for the owner to open (C5). */
  mcpLogin?: { name: string; url: string };
}

export const initialState: State = {
  connected: false,
  agents: [],
  models: [],
  conversations: [],
  problems: [],
  memory: { proposals: [] },
  plans: [],
};

export type Action =
  | { type: "server"; message: ServerMessage }
  | { type: "status"; connected: boolean }
  | { type: "problem"; problem: Problem }
  | { type: "dismiss"; index: number }
  | { type: "notice.clear" };

export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case "status":
      return { ...state, connected: action.connected };
    case "problem":
      return { ...state, problems: [...state.problems, action.problem] };
    case "dismiss":
      return { ...state, problems: state.problems.filter((_, i) => i !== action.index) };
    case "notice.clear": {
      const { notice: _, ...rest } = state;
      return rest;
    }
    case "server":
      return onServer(state, action.message);
  }
}

function onServer(state: State, message: ServerMessage): State {
  switch (message.type) {
    case "init":
      return {
        ...state,
        agents: message.agents,
        models: message.models,
        conversations: message.conversations,
        problems: [...state.problems, ...message.problems],
      };
    case "conversation.opened":
      return {
        ...state,
        open: {
          conversation: message.conversation,
          items: fromHistory(message.history),
          streaming: "",
        },
      };
    case "conversation.updated": {
      const exists = state.conversations.some((c) => c.id === message.conversation.id);
      const conversations = exists
        ? state.conversations.map((c) =>
            c.id === message.conversation.id ? message.conversation : c,
          )
        : [message.conversation, ...state.conversations];
      const open =
        state.open?.conversation.id === message.conversation.id
          ? { ...state.open, conversation: message.conversation }
          : state.open;
      return { ...state, conversations, ...(open ? { open } : {}) };
    }
    case "event":
      if (state.open?.conversation.id !== message.conversationId) return state;
      return { ...state, open: onEvent(state.open, message.event) };
    case "problem":
      return { ...state, problems: [...state.problems, message.problem] };
    case "catalog.updated":
      return {
        ...state,
        agents: message.agents,
        models: message.models,
        // Agent problems are replaced, not appended: they describe the current profiles.
        problems: message.problems,
      };
    case "settings":
      return { ...state, settings: message.settings };
    case "settings.saved":
      return { ...state, notice: message.message };
    case "mcp.authorize":
      return { ...state, mcpLogin: { name: message.name, url: message.url } };
    case "plans":
      return { ...state, plans: message.plans };
    case "conversation.started":
      return { ...state, started: message.conversationId };
    case "memory":
      return {
        ...state,
        memory: {
          proposals: message.proposals,
          ...(message.problem ? { problem: message.problem } : {}),
        },
      };
  }
}

function fromHistory(history: HistoryMessage[]): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, ToolItem>();
  for (const message of history) {
    if (message.role === "context") {
      items.push({ kind: "context", mark: message });
      continue;
    }
    if (message.role === "user") {
      const user = userItem(message.parts);
      if (user) items.push(user);
    }
    for (const part of message.parts) {
      if (part.type === "text") {
        if (message.role === "assistant") {
          items.push({
            kind: "assistant",
            text: part.text,
            agent: message.agent,
            model: message.model,
          });
        }
      } else if (part.type === "attachment") {
        continue;
      } else if (part.type === "tool_call") {
        const tool = newTool(part.id, part.name, part.input);
        tools.set(part.id, tool);
        items.push(tool);
      } else {
        const tool = tools.get(part.callId);
        if (tool) {
          tool.result = {
            content: part.content,
            isError: part.isError,
            ...(part.images ? { images: part.images } : {}),
            ...(part.files ? { files: part.files } : {}),
          };
        }
      }
    }
  }
  return items;
}

/** The user's words and files of one message as one item; tool results are not one. */
function userItem(parts: UserPart[]): Item | undefined {
  const text = parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
  const attachments = parts.flatMap((p): Attached[] =>
    p.type === "attachment"
      ? [{ path: p.path, name: p.name, mediaType: p.mediaType, size: p.size }]
      : [],
  );
  if (!text && attachments.length === 0) return undefined;
  return { kind: "user", text, ...(attachments.length > 0 ? { attachments } : {}) };
}

function newTool(callId: string, name: string, input: unknown): ToolItem {
  return { kind: "tool", callId, name, input, children: [], streaming: "" };
}

/** Applies an event to the open conversation, inside a delegate card when scoped. */
function onEvent(open: Open, event: LoopEvent): Open {
  if ("scope" in event && event.scope) {
    const { callId } = event.scope;
    return {
      ...open,
      items: open.items.map((item) =>
        item.kind === "tool" && item.callId === callId ? applyToContainer(item, event) : item,
      ),
    };
  }
  switch (event.type) {
    case "turn.started":
      return { ...open, streaming: "" };
    case "turn.finished": {
      const { type: _, ...turn } = event;
      return { ...open, streaming: "", items: [...open.items, { kind: "turn", ...turn }] };
    }
    case "approval.resolved":
    case "subagent.finished":
      return { ...open, items: open.items.map((item) => updateTool(item, event)) };
    case "text.delta":
    case "message":
    case "tool.started":
    case "approval.requested":
    case "tool.finished":
    case "notice": {
      const { items, streaming } = apply({ items: open.items, streaming: open.streaming }, event);
      return { ...open, items, streaming };
    }
  }
}

function applyToContainer(tool: ToolItem, event: LoopEvent): ToolItem {
  const { items, streaming } = apply({ items: tool.children, streaming: tool.streaming }, event);
  return { ...tool, children: items, streaming };
}

function apply(
  container: { items: Item[]; streaming: string },
  event: LoopEvent,
): { items: Item[]; streaming: string } {
  const { items, streaming } = container;
  switch (event.type) {
    case "text.delta":
      return { items, streaming: streaming + event.text };
    case "message": {
      const m = event.message;
      // Tool calls arrive as tool.started events; only the text becomes items here.
      const texts: Item[] = [];
      if (m.role === "context") {
        texts.push({ kind: "context", mark: m });
      } else if (m.role === "user") {
        const user = userItem(m.parts);
        if (user) texts.push(user);
      } else {
        for (const p of m.parts) {
          if (p.type === "text") {
            texts.push({ kind: "assistant", text: p.text, agent: m.agent, model: m.model });
          }
        }
      }
      return { items: [...items, ...texts], streaming: "" };
    }
    case "tool.started":
      return { items: [...items, newTool(event.callId, event.name, event.input)], streaming };
    case "notice":
      return { items: [...items, { kind: "notice", problem: event.problem }], streaming };
    case "approval.requested":
      return {
        items: items.map((item) =>
          item.kind === "tool" && item.callId === event.callId
            ? {
                ...item,
                approval: {
                  approvalId: event.approvalId,
                  action: event.action,
                  state: "pending" as const,
                },
              }
            : item,
        ),
        streaming,
      };
    case "tool.finished":
      return {
        items: items.map((item) =>
          item.kind === "tool" && item.callId === event.callId
            ? {
                ...item,
                result: {
                  content: event.content,
                  isError: event.isError,
                  ...(event.images ? { images: event.images } : {}),
                  ...(event.files ? { files: event.files } : {}),
                },
              }
            : item,
        ),
        streaming,
      };
    case "turn.started":
    case "turn.finished":
    case "approval.resolved":
    case "subagent.finished":
      return container;
  }
}

/** Approval and subagent results can target any card, nested or not. */
function updateTool(
  item: Item,
  event: Extract<LoopEvent, { type: "approval.resolved" | "subagent.finished" }>,
): Item {
  if (item.kind !== "tool") return item;
  let next = item;
  if (event.type === "approval.resolved" && item.approval?.approvalId === event.approvalId) {
    next = {
      ...item,
      approval: { ...item.approval, state: event.approved ? "approved" : "denied" },
    };
  }
  if (event.type === "subagent.finished" && item.callId === event.callId) {
    next = { ...item, subagentReason: event.reason };
  }
  return { ...next, children: next.children.map((child) => updateTool(child, event)) };
}
