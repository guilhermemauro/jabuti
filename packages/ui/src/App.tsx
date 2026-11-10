import type {
  ApprovalAction,
  AttachmentPart,
  ClientMessage,
  ContextMark,
  Problem,
} from "@jabuti/protocol";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { connect, type Connection } from "./connection.ts";
import {
  AgentIcon,
  AttachIcon,
  AnimalsContext,
  animals,
  ChatIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FlagIcon,
  HubIcon,
  InboxIcon,
  LogoutIcon,
  ModelIcon,
  PlusIcon,
  RememberIcon,
  CompactIcon,
  SendIcon,
  StopIcon,
  TerminalIcon,
  ToolIcon,
  TortoiseIcon,
  TuneIcon,
} from "./Icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { MemoryProposals } from "./Memory.tsx";
import { inboxCount, InboxScreen, PlanScreen } from "./Plan.tsx";
import { SettingsScreen } from "./Settings.tsx";
import { initialState, reduce, type Attached, type Item, type ToolItem } from "./state.ts";
import { isImage, SentAttachments, size, upload, type Pending } from "./Attachments.tsx";
import "./styles.css";
import { WorkspaceContext, WorkspaceImage } from "./WorkspaceImage.tsx";

type Send = (message: ClientMessage) => void;

export function App(props: { onLogout: () => void; onSessionCheck: () => void }) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const connection = useRef<Connection>(null);
  // Read inside the connection callbacks, which are created once.
  const onSessionCheck = useRef(props.onSessionCheck);
  useEffect(() => {
    onSessionCheck.current = props.onSessionCheck;
  }, [props.onSessionCheck]);
  // The server forgets what a client was watching when the socket drops.
  const openId = useRef<string>(undefined);
  const currentId = state.open?.conversation.id;
  useEffect(() => {
    openId.current = currentId;
  }, [currentId]);

  useEffect(() => {
    const c = connect({
      onMessage: (message) => {
        dispatch({ type: "server", message });
      },
      onStatus: (connected) => {
        dispatch({ type: "status", connected });
        // A dropped socket may mean the session ended (logout elsewhere, expiry).
        if (!connected) onSessionCheck.current();
        if (connected && openId.current) {
          c.send({ type: "conversation.open", conversationId: openId.current });
        }
      },
      onInvalid: (detail) => {
        dispatch({
          type: "problem",
          problem: {
            message: `The UI received a message it does not understand: ${detail}`,
            nextStep: "Reload the page. If it persists, restart `pnpm dev`.",
          },
        });
      },
    });
    connection.current = c;
    return () => {
      c.close();
    };
  }, []);

  // Stable: children use it in effects.
  const send: Send = useCallback((message) => connection.current?.send(message), []);
  const [view, setView] = useState<"chat" | "plan" | "inbox" | "settings">("chat");
  // A run the owner started from the plan or inbox opens in the chat.
  const [seenStarted, setSeenStarted] = useState(state.started);
  if (state.started !== seenStarted) {
    setSeenStarted(state.started);
    setView("chat");
  }
  const openConversation = useCallback(
    (conversationId: string) => {
      setView("chat");
      send({ type: "conversation.open", conversationId });
    },
    [send],
  );
  const waiting = inboxCount(state.plans);
  useEffect(() => {
    if (!state.notice) return;
    const timer = setTimeout(() => {
      dispatch({ type: "notice.clear" });
    }, 3000);
    return () => {
      clearTimeout(timer);
    };
  }, [state.notice]);
  const { open } = state;
  const [picked, setPicked] = useState("");
  const newAgent = (picked !== "" ? picked : state.agents[0]?.name) ?? "";
  const openAgent = state.agents.find((a) => a.name === open?.conversation.agent);
  const agentModel = state.models.find((m) => m.id === openAgent?.model);
  const agentModelLabel = agentModel?.label ?? openAgent?.model ?? "unknown";
  const SHELL_LABELS = { ask: "Ask every command", auto: "Auto", deny: "No shell" } as const;

  const agentNames = state.agents.map((a) => a.name).join("\n");
  const animalSlots = useMemo(() => animals(agentNames.split("\n")), [agentNames]);
  const effectiveModel = open?.conversation.model
    ? (state.models.find((m) => m.id === open.conversation.model)?.label ?? open.conversation.model)
    : agentModelLabel;

  return (
    <AnimalsContext value={animalSlots}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark">
              <TortoiseIcon size={22} />
            </span>
            <div>
              <div className="brand-name">Jabuti</div>
              <div className="brand-sub">Agent harness</div>
            </div>
          </div>
          <label className="field-label" htmlFor="new-agent">
            Agent
          </label>
          <select
            id="new-agent"
            className="mono"
            value={newAgent}
            onChange={(e) => {
              setPicked(e.target.value);
            }}
          >
            {state.agents.map((a) => (
              <option key={a.name} value={a.name} title={a.description}>
                {a.name}
              </option>
            ))}
          </select>
          <button
            className="primary new"
            disabled={!state.connected || !newAgent}
            onClick={() => {
              setView("chat");
              send({ type: "conversation.create", agent: newAgent });
            }}
          >
            <PlusIcon size={16} />
            New conversation
          </button>
          <nav>
            <button
              className={view === "chat" ? "active" : ""}
              onClick={() => {
                setView("chat");
              }}
            >
              <ChatIcon />
              Conversations
            </button>
            <button
              className={view === "plan" ? "active" : ""}
              onClick={() => {
                setView("plan");
              }}
            >
              <FlagIcon />
              Plan
            </button>
            <button
              className={view === "inbox" ? "active" : ""}
              onClick={() => {
                setView("inbox");
              }}
            >
              <InboxIcon />
              Inbox
              {waiting > 0 && <span className="badge">{waiting}</span>}
            </button>
            <button
              className={view === "settings" ? "active" : ""}
              onClick={() => {
                setView("settings");
              }}
            >
              <TuneIcon />
              Agents &amp; settings
            </button>
          </nav>
          <div className="section-label">Recent sessions</div>
          <ul className="sessions">
            {state.conversations.map((c) => (
              <li key={c.id}>
                <button
                  className={c.id === open?.conversation.id && view === "chat" ? "active" : ""}
                  onClick={() => {
                    setView("chat");
                    send({ type: "conversation.open", conversationId: c.id });
                  }}
                >
                  <span className="session-title">{c.title}</span>
                  <span className="session-meta">
                    <span className={`dot ${c.running ? "on" : ""}`} />
                    {c.agent}
                    {c.unattended && " · routine"}
                    {c.running && " · working"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="sidebar-foot">
            <div className="status-row">
              <span className={`dot ${state.connected ? "on" : "off"}`} />
              {state.connected ? "Connected to the server" : "Reconnecting…"}
            </div>
            <button className="ghost" onClick={props.onLogout}>
              <LogoutIcon size={16} />
              Log out
            </button>
          </div>
        </aside>

        <main>
          <div className="topbar">
            <div className="crumbs">
              {view === "settings" || view === "inbox" ? (
                <>
                  <span>jabuti</span>
                  <ChevronRightIcon size={14} />
                  <span className="crumb-current">{view}</span>
                </>
              ) : view === "plan" ? (
                <>
                  <span>agents</span>
                  <ChevronRightIcon size={14} />
                  <span className="crumb-current">{newAgent}</span>
                  <ChevronRightIcon size={14} />
                  <span className="crumb-tail">plan</span>
                </>
              ) : open ? (
                <>
                  <span>agents</span>
                  <ChevronRightIcon size={14} />
                  <span className="crumb-current">{open.conversation.agent}</span>
                  <ChevronRightIcon size={14} />
                  <span className="crumb-tail">{open.conversation.title}</span>
                </>
              ) : (
                <span>conversations</span>
              )}
            </div>
          </div>
          {!state.connected && (
            <ProblemBox
              problem={{
                message: "Cannot reach the Jabuti server.",
                nextStep: "Start it with `pnpm dev` in the jabuti folder. Reconnecting…",
              }}
            />
          )}
          {state.problems.map((problem, index) => (
            <ProblemBox
              key={index}
              problem={problem}
              onDismiss={() => {
                dispatch({ type: "dismiss", index });
              }}
            />
          ))}

          {state.notice && <div className="notice">{state.notice}</div>}
          {state.memory.problem && <ProblemBox problem={state.memory.problem} />}
          <MemoryProposals proposals={state.memory.proposals} send={send} />

          {view === "settings" ? (
            <SettingsScreen
              settings={state.settings}
              models={state.models}
              mcpLogin={state.mcpLogin}
              send={send}
            />
          ) : view === "plan" ? (
            <PlanScreen
              agent={newAgent}
              plan={state.plans.find((p) => p.agent === newAgent)}
              busy={state.conversations.some(
                (c) => c.agent === newAgent && c.unattended && c.running,
              )}
              send={send}
              open={openConversation}
            />
          ) : view === "inbox" ? (
            <InboxScreen plans={state.plans} send={send} open={openConversation} />
          ) : open ? (
            <>
              <header className="conversation-bar">
                <span className="avatar large">
                  <AgentIcon agent={open.conversation.agent} />
                </span>
                <div className="who">
                  <div className="who-name">
                    {open.conversation.agent}
                    <span className={`state-pill ${open.conversation.running ? "on" : ""}`}>
                      <span className="dot" />
                      {open.conversation.running ? "Working" : "Idle"}
                    </span>
                  </div>
                  {openAgent?.description && <div className="who-sub">{openAgent.description}</div>}
                </div>
                <label
                  className="chip"
                  title="Applies from the next message. Subagents keep their own model."
                >
                  <ModelIcon size={14} />
                  <select
                    aria-label="Model for this conversation"
                    value={open.conversation.model ?? ""}
                    disabled={open.conversation.running}
                    onChange={(e) => {
                      send({
                        type: "conversation.selectModel",
                        conversationId: open.conversation.id,
                        model: e.target.value === "" ? null : e.target.value,
                      });
                    }}
                  >
                    <option value="">
                      {agentModelLabel} · default
                      {agentModel && !agentModel.available ? " (no API key)" : ""}
                    </option>
                    {state.models.map((m) => (
                      <option key={m.id} value={m.id} disabled={!m.available}>
                        {m.label}
                        {m.available ? "" : " (no API key)"}
                      </option>
                    ))}
                  </select>
                </label>
                {openAgent && openAgent.shell !== "deny" && (
                  <label
                    className="chip"
                    title="Auto runs every command and package install without asking. Ask waits for your approval on each."
                  >
                    <TerminalIcon size={14} />
                    <select
                      aria-label="Shell mode for this conversation"
                      value={open.conversation.shellMode ?? ""}
                      onChange={(e) => {
                        const value = e.target.value;
                        send({
                          type: "conversation.selectShellMode",
                          conversationId: open.conversation.id,
                          mode: value === "ask" || value === "auto" ? value : null,
                        });
                      }}
                    >
                      <option value="">
                        Shell: agent default ({SHELL_LABELS[openAgent.shell]})
                      </option>
                      <option value="auto">Shell: Auto (never asks)</option>
                      <option value="ask">Shell: Ask every command</option>
                    </select>
                  </label>
                )}
                <button
                  className="remember"
                  title="Read this conversation now and propose what to remember, instead of waiting for it to go quiet."
                  disabled={open.conversation.running}
                  onClick={() => {
                    send({ type: "memory.capture", conversationId: open.conversation.id });
                  }}
                >
                  <RememberIcon size={16} />
                  Remember now
                </button>
                <button
                  className="remember"
                  title="Summarize the conversation so far for the agent, to free its context. You still see every message. Type /compact and what to focus on for a focused summary."
                  disabled={open.conversation.running}
                  onClick={() => {
                    send({ type: "conversation.compact", conversationId: open.conversation.id });
                  }}
                >
                  <CompactIcon size={16} />
                  Compact
                </button>
              </header>
              <WorkspaceContext value={open.conversation.agent}>
                <Transcript
                  items={open.items}
                  streaming={open.streaming}
                  agent={open.conversation.agent}
                  send={send}
                />
              </WorkspaceContext>
              <Composer
                key={open.conversation.id}
                agent={open.conversation.agent}
                running={open.conversation.running}
                model={effectiveModel}
                onSend={(text, attachments) => {
                  const compact = /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim());
                  if (compact && attachments.length === 0) {
                    const focus = compact[1]?.trim();
                    send({
                      type: "conversation.compact",
                      conversationId: open.conversation.id,
                      ...(focus ? { focus } : {}),
                    });
                    return;
                  }
                  send({
                    type: "message.send",
                    conversationId: open.conversation.id,
                    text,
                    ...(attachments.length > 0 ? { attachments } : {}),
                  });
                }}
                onStop={() => {
                  send({ type: "turn.cancel", conversationId: open.conversation.id });
                }}
              />
            </>
          ) : (
            <div className="empty">
              <TortoiseIcon size={40} />
              Start a new conversation, or pick one on the left.
            </div>
          )}
        </main>
      </div>
    </AnimalsContext>
  );
}

function Transcript(props: { items: Item[]; streaming: string; agent: string; send: Send }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [props.items, props.streaming]);
  const thread = exchanges(props.items);
  const lastIsAgent = thread.at(-1)?.kind === "agent";
  return (
    <div className="transcript">
      <div className="thread">
        {thread.map((exchange, i) =>
          exchange.kind === "user" ? (
            <div key={i} className="user">
              {exchange.attachments && <SentAttachments attachments={exchange.attachments} />}
              {exchange.text}
            </div>
          ) : (
            <AgentCard
              key={i}
              agent={exchange.agent ?? props.agent}
              items={exchange.items}
              streaming={i === thread.length - 1 ? props.streaming : ""}
              send={props.send}
            />
          ),
        )}
        {props.streaming && !lastIsAgent && (
          <AgentCard agent={props.agent} items={[]} streaming={props.streaming} send={props.send} />
        )}
      </div>
      <div ref={end} />
    </div>
  );
}

/**
 * The thread as the user reads it: each message of theirs, then one card with
 * everything the agent did until the next one (tool calls, replies, the turn's cost).
 */
type Exchange =
  | { kind: "user"; text: string; attachments?: Attached[] }
  | { kind: "agent"; agent: string | undefined; items: Item[] };

function exchanges(items: Item[]): Exchange[] {
  const out: Exchange[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      out.push(item);
      continue;
    }
    let last = out.at(-1);
    if (last?.kind !== "agent") {
      last = { kind: "agent", agent: undefined, items: [] };
      out.push(last);
    }
    if (item.kind === "assistant") last.agent ??= item.agent;
    last.items.push(item);
  }
  return out;
}

function AgentCard(props: { agent: string; items: Item[]; streaming: string; send: Send }) {
  return (
    <div className="agent-message">
      <span className="avatar">
        <AgentIcon agent={props.agent} />
      </span>
      <div className="agent-body">
        <div className="agent-name">{props.agent}</div>
        <div className="agent-card">
          <Items items={props.items} streaming={props.streaming} send={props.send} />
        </div>
      </div>
    </div>
  );
}

/** Consecutive tool calls become one collapsible group instead of a card each. */
type Block = { kind: "item"; item: Item } | { kind: "tools"; tools: ToolItem[] };

function blocks(items: Item[]): Block[] {
  const out: Block[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (item.kind === "tool" && last?.kind === "tools") last.tools.push(item);
    else if (item.kind === "tool") out.push({ kind: "tools", tools: [item] });
    else out.push({ kind: "item", item });
  }
  return out;
}

function Items({ items, streaming, send }: { items: Item[]; streaming: string; send: Send }) {
  return (
    <>
      {blocks(items).map((block, i) =>
        block.kind === "tools" ? (
          <ToolGroup key={block.tools[0]?.callId ?? i} tools={block.tools} send={send} />
        ) : (
          <ItemView key={i} item={block.item} send={send} />
        ),
      )}
      {streaming && (
        <div className="assistant markdown streaming">
          <Markdown text={streaming} />
        </div>
      )}
    </>
  );
}

function ToolGroup({ tools, send }: { tools: ToolItem[]; send: Send }) {
  const [open, setOpen] = useState(false);
  // A pending approval must be visible: the group opens itself while one waits.
  const waiting = tools.some((t) => t.approval?.state === "pending" && !t.result);
  const running = tools.some((t) => !t.result);
  const failed = tools.filter((t) => t.result?.isError).length;
  const shown = open || waiting;
  return (
    <div className={`tool-group ${running ? "running" : failed > 0 ? "error" : "ok"}`}>
      <button
        className="summary"
        aria-expanded={shown}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <span className={`chevron ${shown ? "open" : ""}`}>
          <ChevronDownIcon size={16} />
        </span>
        <span className="group-title">
          {tools.some((t) => t.name === "delegate") ? (
            <HubIcon size={14} />
          ) : (
            <ToolIcon size={14} />
          )}
          {summarize(tools)}
        </span>
        <span className="status">
          <span className="dot" />
          {waiting
            ? "waiting for you"
            : running
              ? "running…"
              : failed > 0
                ? `${String(failed)} failed`
                : "done"}
        </span>
      </button>
      {shown && (
        <div className="tools">
          {tools.map((tool) => (
            <ToolCard key={tool.callId} tool={tool} send={send} />
          ))}
        </div>
      )}
    </div>
  );
}

/** "3 commands, 1 memory change": what the group did, by kind. */
function summarize(tools: ToolItem[]): string {
  const count = (name: string) => tools.filter((t) => t.name === name).length;
  const plural = (n: number, one: string, many: string) =>
    n === 0 ? [] : [`${String(n)} ${n === 1 ? one : many}`];
  const other =
    tools.length -
    count("shell") -
    count("memory") -
    count("delegate") -
    count("agents") -
    count("packages") -
    count("web_read") -
    count("page_structure") -
    count("site_crawl") -
    count("view_images");
  return [
    ...plural(count("shell"), "command", "commands"),
    ...plural(count("delegate"), "delegation", "delegations"),
    ...plural(count("memory"), "memory change", "memory changes"),
    ...plural(count("agents"), "agent action", "agent actions"),
    ...plural(count("packages"), "package install", "package installs"),
    ...plural(count("web_read") + count("page_structure"), "page read", "pages read"),
    ...plural(count("site_crawl"), "site crawl", "site crawls"),
    ...plural(count("view_images"), "image view", "image views"),
    ...plural(other, "tool call", "tool calls"),
  ].join(", ");
}

function ItemView({ item, send }: { item: Item; send: Send }) {
  switch (item.kind) {
    case "user":
      // Inside a subagent's work: the task it was given.
      return <div className="user nested">{item.text}</div>;
    case "assistant":
      return (
        <div className="assistant markdown">
          <Markdown text={item.text} />
        </div>
      );
    case "tool":
      return <ToolCard tool={item} send={send} />;
    case "notice":
      return <ProblemBox problem={item.problem} />;
    case "context":
      return <ContextMarkView mark={item.mark} />;
    case "turn":
      return (
        <div className="turn">
          {item.problem && <ProblemBox problem={item.problem} />}
          <div className="meta">
            {item.steps} {item.steps === 1 ? "step" : "steps"} · US$ {item.costUsd.toFixed(4)}
          </div>
        </div>
      );
  }
}

/** Where the agent's view was reduced; the messages above stay here for the user (C10). */
function ContextMarkView({ mark }: { mark: ContextMark }) {
  const size = `${String(Math.round(mark.tokens / 1000))}k tokens`;
  const cost = mark.costUsd > 0 ? ` · US$ ${mark.costUsd.toFixed(4)}` : "";
  if (mark.mode === "clear") {
    return (
      <div className="context-mark">
        <CompactIcon size={14} />
        <span>
          {String(mark.cleared ?? 0)} old tool results cleared from the agent's context, saved whole
          in context/ in its workspace for it to read again · {size}
        </span>
      </div>
    );
  }
  return (
    <details className="context-mark">
      <summary>
        <CompactIcon size={14} />
        <span>
          {mark.manual ? "Conversation summarized" : "Conversation summarized to free context"}: the
          agent now sees this summary and the latest messages · {size}
          {cost}
        </span>
      </summary>
      {mark.focus && <div className="caption">Focus: {mark.focus}</div>}
      <div className="markdown">
        <Markdown text={mark.summary ?? ""} />
      </div>
    </details>
  );
}

function ToolCard({ tool, send }: { tool: ToolItem; send: Send }) {
  const input = (tool.input ?? {}) as Record<string, unknown>;
  const command =
    typeof input["command"] === "string" ? input["command"] : JSON.stringify(tool.input);
  const pending = tool.approval?.state === "pending" && !tool.result;
  const status = tool.result ? (tool.result.isError ? "error" : "ok") : "running";

  const runs = tool.name === "agents" && input["action"] === "run";
  if (tool.name === "delegate" || runs) {
    return (
      <div className={`tool delegate ${status}`}>
        <div className="title">
          {runs ? "⚙ run " : "→ "}
          {String(input["agent"])}
          {tool.subagentReason && tool.subagentReason !== "done" && ` (${tool.subagentReason})`}
        </div>
        <div className="task">{String(input["task"])}</div>
        {pending && tool.approval && (
          <Approval
            action={tool.approval.action}
            respond={(approved) => {
              send({
                type: "approval.respond",
                approvalId: tool.approval?.approvalId ?? "",
                approved,
              });
            }}
          />
        )}
        <div className="children">
          <Items items={tool.children} streaming={tool.streaming} send={send} />
        </div>
        {tool.result && <pre className="output">{tool.result.content}</pre>}
      </div>
    );
  }

  const title =
    tool.name === "memory"
      ? `✎ ${String(input["file"])}.md`
      : tool.name === "agents"
        ? agentsTitle(input)
        : tool.name.startsWith("mcp__")
          ? `⚡ ${tool.name.slice(5).replace("__", " · ")} ${mcpSummary(input)}`
          : tool.name === "packages"
            ? `📦 install ${(input["packages"] as string[] | undefined)?.join(" ") ?? ""}`
            : tool.name === "web_read" || tool.name === "page_structure"
              ? `🌐 ${tool.name === "web_read" ? "read" : "structure of"} ${String(input["url"])}`
              : tool.name === "site_crawl"
                ? `🕸 crawled ${String(input["url"])}`
                : tool.name === "view_images"
                  ? `🖼 looked at ${String((input["images"] as unknown[] | undefined)?.length ?? 0)} image(s)`
                  : `$ ${command}`;
  return (
    <div className={`tool ${status}`}>
      <pre className="command">{title}</pre>
      {pending && tool.approval && (
        <Approval
          action={tool.approval.action}
          respond={(approved) => {
            send({
              type: "approval.respond",
              approvalId: tool.approval?.approvalId ?? "",
              approved,
            });
          }}
        />
      )}
      {tool.result && <pre className="output">{tool.result.content.trim()}</pre>}
      {tool.result?.images?.map((image, i) => (
        // What the agent's model saw (view_images, C21), from the server, never a third party.
        <img
          key={i}
          className="tool-image"
          alt="What the agent looked at"
          src={`data:${image.mediaType};base64,${image.data}`}
        />
      ))}
      {tool.result?.files?.map((file) => (
        <WorkspaceImage
          key={`${file.workspace}/${file.path}`}
          workspace={file.workspace}
          path={file.path}
        />
      ))}
    </div>
  );
}

/** The first argument of a connector call, such as the query of a search. */
function mcpSummary(input: Record<string, unknown>): string {
  const first = Object.values(input).find((v) => typeof v === "string");
  return typeof first === "string" ? `"${first}"` : "";
}

/** "⚙ create agent my-blog", or "⚙ list agents". */
function agentsTitle(input: Record<string, unknown>): string {
  const profile = input["profile"] as { name?: unknown } | undefined;
  const action = String(input["action"]);
  return profile ? `⚙ ${action} agent ${String(profile.name)}` : `⚙ ${action} agents`;
}

function Approval({
  action,
  respond,
}: {
  action: ApprovalAction;
  respond: (approved: boolean) => void;
}) {
  return (
    <>
      {action.kind === "file" && (
        <pre className="diff">
          {action.diff.split("\n").map((line, i) => (
            <div
              key={i}
              className={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""}
            >
              {line}
            </div>
          ))}
        </pre>
      )}
      {action.kind === "mcp" && <pre className="diff">{action.input}</pre>}
      {(action.kind === "file" || action.kind === "run") &&
        action.notes?.map((note) => (
          <div key={note} className="note">
            {note}
          </div>
        ))}
      <div className="approval">
        {action.kind === "file"
          ? `Save this change to ${action.file}?`
          : action.kind === "run"
            ? `Let ${action.agent} work on this task, in its own workspace and with its own variables?`
            : action.kind === "packages"
              ? `Install ${action.packages.join(", ")}? System packages stay installed and other agents may use them too.`
              : action.kind === "mcp"
                ? `Let the agent call ${action.tool} on ${action.server} with these arguments?`
                : "Run this command?"}
        <button
          className="primary"
          onClick={() => {
            respond(true);
          }}
        >
          Approve
        </button>
        <button
          onClick={() => {
            respond(false);
          }}
        >
          Deny
        </button>
      </div>
    </>
  );
}

function ProblemBox({ problem, onDismiss }: { problem: Problem; onDismiss?: () => void }) {
  return (
    <div className="problem" role="alert">
      <div>
        <strong>{problem.message}</strong>
        <div>{problem.nextStep}</div>
      </div>
      {onDismiss && (
        <button aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      )}
    </div>
  );
}

function Composer(props: {
  agent: string;
  running: boolean;
  model: string;
  onSend: (text: string, attachments: AttachmentPart[]) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const uploading = files.some((f) => f.state === "uploading");
  const ready = files.flatMap((f) => (f.state === "ready" && f.part ? [f.part] : []));
  const canSend = (text.trim() !== "" || ready.length > 0) && !uploading && !props.running;

  const add = (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      const id = crypto.randomUUID();
      const preview = isImage(file.type) ? URL.createObjectURL(file) : undefined;
      setFiles((now) => [
        ...now,
        {
          id,
          name: file.name,
          size: file.size,
          state: "uploading",
          ...(preview ? { preview } : {}),
        },
      ]);
      upload(props.agent, file).then(
        (part) => {
          setFiles((now) => now.map((f) => (f.id === id ? { ...f, state: "ready", part } : f)));
        },
        (error: unknown) => {
          const why = error instanceof Error ? error.message : String(error);
          setFiles((now) =>
            now.map((f) => (f.id === id ? { ...f, state: "failed", error: why } : f)),
          );
        },
      );
    }
  };
  const remove = (id: string) => {
    setFiles((now) => {
      const gone = now.find((f) => f.id === id);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return now.filter((f) => f.id !== id);
    });
  };
  const submit = () => {
    if (!canSend) return;
    props.onSend(text, ready);
    setText("");
    for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
    setFiles([]);
  };
  return (
    <div className="composer">
      <div
        className={`composer-box${dragging ? " dragging" : ""}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => {
          setDragging(false);
        }}
        onDrop={(e) => {
          if (e.dataTransfer.files.length === 0) return;
          e.preventDefault();
          setDragging(false);
          add(e.dataTransfer.files);
        }}
      >
        {files.length > 0 && (
          <div className="pending-attachments">
            {files.map((f) => (
              <span
                key={f.id}
                className={`attachment-chip ${f.state}`}
                title={f.error ? `${f.name}: ${f.error}` : f.name}
              >
                {f.preview ? <img src={f.preview} alt="" /> : "📎"}
                <span className="attachment-name">{f.name}</span>
                <span className="attachment-size">
                  {f.state === "uploading"
                    ? "uploading…"
                    : f.state === "failed"
                      ? `failed: ${f.error ?? ""}`
                      : size(f.size)}
                </span>
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => {
                    remove(f.id);
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          value={text}
          rows={3}
          placeholder="Message (Enter to send, Shift+Enter for a new line)"
          onChange={(e) => {
            setText(e.target.value);
          }}
          onPaste={(e) => {
            if (e.clipboardData.files.length === 0) return;
            e.preventDefault();
            add(e.clipboardData.files);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="composer-foot">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) add(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="attach"
            aria-label="Attach files"
            title="Attach files (or drop them here, or paste)"
            onClick={() => picker.current?.click()}
          >
            <AttachIcon size={18} />
          </button>
          <span className="composer-model">{props.model}</span>
          {props.running ? (
            <button className="send" onClick={props.onStop}>
              <StopIcon size={16} />
              Stop
            </button>
          ) : (
            <button className="primary send" disabled={!canSend} onClick={submit}>
              Send
              <SendIcon size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
