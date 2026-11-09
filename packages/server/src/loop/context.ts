// What the model sees of a long conversation (C10). History is never rewritten: a
// context mark is appended where the view was reduced, and the view is rebuilt from
// the history and its marks on every load. Two reductions, the cheaper first:
//
// - clear: tool results before a point become one line (they are the bulk of an SEO
//   agent's context);
// - summary: the model summarizes everything before a point; the model then sees the
//   summary and the latest messages as they were.
//
// Either way, a long tool result leaving the view is first saved whole in the agent's
// workspace (context/<conversation>/<call>.txt), and the view names the file: the
// agent reads what it needs again instead of running the tool, which may cost money
// or answer differently now. A result that could not be saved is not cleared.
//
// Both keep a tail of recent messages whole, and never separate a tool call from its
// result. Thresholds are in tokens, well below the 1M windows of current models: past
// them each step costs more and the model attends worse.
import type { ContextMark, UserPart } from "@jabuti/protocol";
import type { StoredMessage } from "../conversations/store.ts";
import type { CatalogModel } from "../providers/catalog.ts";
import type { ModelMessage, ModelProvider, Usage } from "../providers/types.ts";

/** Tool results are cleared from here on, if that saves enough. */
const CLEAR_AT = 100_000;
/** The conversation is summarized from here on. */
const SUMMARIZE_AT = 200_000;
/** A clear is worth it only above this many tokens saved. */
const MIN_SAVINGS = 20_000;
/** The recent messages kept whole: at most this many tokens and two user messages. */
const TAIL_TOKENS = 30_000;
const TAIL_TURNS = 2;
/** A tool result this short is kept by a clear. */
const KEEP_RESULT = 500;
/** What the summarizer reads of each tool result, and of the whole part. */
const RESULT_IN_SUMMARY = 1_500;
const SUMMARY_INPUT = 400_000;
/** Tokens counted for an image the model sees. */
const IMAGE_TOKENS = 1_600;

export type Reduction =
  { mode: "clear"; from: number; saved: number } | { mode: "summary"; from: number };

/** The history as the model sees it, after the latest summary and clear. */
export function modelView(history: StoredMessage[]): ModelMessage[] {
  const { summary, clearedBefore, cleared: clearedFiles } = marks(history);
  const reduce = (part: UserPart) => cleared(part, clearedFiles);
  const view: ModelMessage[] = summary
    ? [{ role: "user", parts: [{ type: "text", text: summaryText(summary.summary ?? "") }] }]
    : [];
  for (let i = summary?.from ?? 0; i < history.length; i++) {
    const m = history[i];
    if (!m || m.role === "context") continue;
    if (m.role === "user") {
      view.push({ role: "user", parts: i < clearedBefore ? m.parts.map(reduce) : m.parts });
    } else {
      view.push(
        m.raw
          ? { role: "assistant", parts: m.parts, raw: m.raw }
          : { role: "assistant", parts: m.parts },
      );
    }
  }
  return view;
}

/** About how many tokens messages take: a quarter of their characters, plus images. */
export function estimate(messages: ModelMessage[]): number {
  let total = 0;
  for (const m of messages) {
    for (const part of m.parts) {
      if (part.type === "text") total += part.text.length / 4;
      else if (part.type === "tool_call")
        total += JSON.stringify(part.input ?? null).length / 4 + 10;
      else if (part.type === "tool_result") {
        total += part.content.length / 4 + (part.images?.length ?? 0) * IMAGE_TOKENS;
      } else total += 50 + (part.image ? IMAGE_TOKENS : 0);
    }
  }
  return Math.round(total);
}

/**
 * What to do at this size: nothing, clear old tool results, or summarize. A manual
 * request always summarizes. Undefined when nothing can be reduced.
 */
export function plan(
  history: StoredMessage[],
  tokens: number,
  model: CatalogModel,
  manual: boolean,
): Reduction | undefined {
  const summarizeAt = Math.min(SUMMARIZE_AT, model.contextWindow * 0.8);
  const clearAt = Math.min(CLEAR_AT, model.contextWindow * 0.5);
  if (!manual && tokens < clearAt) return undefined;
  const { summary, clearedBefore } = marks(history);
  const start = summary?.from ?? 0;
  if (!manual) {
    const from = tailStart(history, Math.max(start, clearedBefore));
    if (from !== undefined) {
      const saved = savings(history, Math.max(start, clearedBefore), from);
      if (saved >= MIN_SAVINGS && tokens - saved < summarizeAt) {
        return { mode: "clear", from, saved };
      }
    }
    if (tokens < summarizeAt) return undefined;
  }
  const from = tailStart(history, start);
  return from === undefined ? undefined : { mode: "summary", from };
}

const SUMMARY_SYSTEM = `You summarize the earlier part of a conversation between a user and an AI agent. The agent will continue the work seeing only your summary and the latest messages, so it must not lose anything it still needs. Write in the language the user writes in, as plain Markdown with these sections:

## Goal
What the user is trying to achieve, in their terms.

## What the user said
Requests, decisions, corrections and preferences, with exact wording where it matters (names, rules, things to avoid). Latest wins when they changed their mind.

## Done
Results so far: findings with their numbers, IDs, URLs, commands that worked, what failed and why.

## Files
Workspace paths and what each holds, including the files tool results were saved in. The files are still there; the agent can read them again.

## Open
What is pending, questions waiting for the user, and what the agent was doing when the summary was made.

Leave out what no longer matters, such as dead ends already explained and raw tool output. No preamble.`;

/** Asks the model for a summary of the history before `from`. */
export async function summarize(
  provider: ModelProvider,
  model: CatalogModel,
  history: StoredMessage[],
  from: number,
  focus: string | undefined,
  signal: AbortSignal,
  files: Map<string, string>,
): Promise<{ summary: string; usage: Usage }> {
  const { summary: earlier, saved } = marks(history);
  for (const [callId, path] of saved) if (!files.has(callId)) files.set(callId, path);
  const part = transcript(history.slice(earlier?.from ?? 0, from), files);
  const input = [
    earlier?.summary ? `<earlier_summary>\n${earlier.summary}\n</earlier_summary>` : "",
    `<conversation>\n${part}\n</conversation>`,
    focus ? `The user asks the summary to focus on: ${focus}` : "",
    "Write the summary now.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const response = await provider.complete({
    model: model.model,
    system: SUMMARY_SYSTEM,
    tools: [],
    messages: [{ role: "user", parts: [{ type: "text", text: input }] }],
    signal,
    onText: () => undefined,
  });
  const summary = response.parts
    .flatMap((p) => (p.type === "text" ? [p.text] : []))
    .join("")
    .trim();
  if (!summary) throw new Error(`the model answered without a summary (${response.stop})`);
  return { summary, usage: response.usage };
}

export interface ToSave {
  callId: string;
  path: string;
  /** The whole result, headed by the call that produced it. */
  text: string;
}

/**
 * The long tool results this reduction takes out of the model's view and that are not
 * saved yet: each with its workspace path and the text to write there.
 */
export function toSave(
  history: StoredMessage[],
  reduction: Reduction,
  conversationId: string,
): ToSave[] {
  const { summary, clearedBefore, saved } = marks(history);
  const start =
    reduction.mode === "clear" ? Math.max(summary?.from ?? 0, clearedBefore) : (summary?.from ?? 0);
  const calls = new Map<string, { name: string; input: unknown }>();
  for (const m of history) {
    if (m.role !== "assistant") continue;
    for (const p of m.parts) if (p.type === "tool_call") calls.set(p.id, p);
  }
  return results(history, start, reduction.from)
    .filter((p) => !saved.has(p.callId))
    .map((p) => {
      const call = calls.get(p.callId);
      const head = [
        `Tool: ${call?.name ?? "unknown"}`,
        `Input: ${shorten(JSON.stringify(call?.input ?? null), 2_000)}`,
        ...(p.isError ? ["(an error)"] : []),
      ];
      return {
        callId: p.callId,
        path: `context/${conversationId}/${p.callId.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`,
        text: `${head.join("\n")}\n\n${p.content}`,
      };
    });
}

/** A mark for the history, without what the caller adds (agent, model, cost). */
export function mark(
  reduction: Reduction,
  saved: { callId: string; path: string }[],
  tokens: number,
  extra: { summary?: string; manual: boolean; focus?: string | undefined },
): Omit<ContextMark, "agent" | "model" | "costUsd"> {
  const base = {
    role: "context" as const,
    parts: [],
    mode: reduction.mode,
    from: reduction.from,
    tokens,
    manual: extra.manual,
    ...(saved.length > 0 ? { saved } : {}),
  };
  if (reduction.mode === "clear") return { ...base, cleared: saved.length };
  return { ...base, summary: extra.summary ?? "", ...(extra.focus ? { focus: extra.focus } : {}) };
}

function marks(history: StoredMessage[]): {
  summary: ContextMark | undefined;
  clearedBefore: number;
  /** Every saved result's file, by call. */
  saved: Map<string, string>;
  /** The saved results a clear took out of the view, by call. */
  cleared: Map<string, string>;
} {
  let summary: ContextMark | undefined;
  let clearedBefore = 0;
  const saved = new Map<string, string>();
  const cleared = new Map<string, string>();
  for (const m of history) {
    if (m.role !== "context") continue;
    for (const s of m.saved ?? []) {
      saved.set(s.callId, s.path);
      if (m.mode === "clear") cleared.set(s.callId, s.path);
    }
    if (m.mode === "summary") summary = m;
    else clearedBefore = Math.max(clearedBefore, m.from);
  }
  return { summary, clearedBefore, saved, cleared };
}

function summaryText(summary: string): string {
  return [
    "<conversation_summary>",
    "This conversation is longer than what you see: its earlier part is summarized " +
      "here. The user still sees all of it. Files it mentions are in your workspace.",
    "",
    summary,
    "</conversation_summary>",
  ].join("\n");
}

/**
 * Where the kept tail starts: the latest point that is not a tool result, extended
 * back while it stays within the tail's size. Undefined if nothing before it, after
 * `after`, would be reduced.
 */
function tailStart(history: StoredMessage[], after: number): number | undefined {
  let best: number | undefined;
  let tokens = 0;
  let turns = 0;
  for (let i = history.length - 1; i > after; i--) {
    const m = history[i];
    if (!m || m.role === "context") continue;
    tokens += estimate([m]);
    const answers = m.role === "user" && m.parts.some((p) => p.type === "tool_result");
    if (m.role === "user" && !answers) turns++;
    if (answers) continue;
    if (best !== undefined && (tokens > TAIL_TOKENS || turns > TAIL_TURNS)) break;
    best = i;
  }
  return best;
}

/** The tool results a clear would reduce, from `start` up to `end`. */
function results(history: StoredMessage[], start: number, end: number) {
  const found: Extract<UserPart, { type: "tool_result" }>[] = [];
  for (let i = start; i < end; i++) {
    const m = history[i];
    if (m?.role !== "user") continue;
    for (const p of m.parts) {
      if (p.type === "tool_result" && (p.content.length > KEEP_RESULT || p.images)) found.push(p);
    }
  }
  return found;
}

function savings(history: StoredMessage[], start: number, end: number): number {
  return results(history, start, end).reduce(
    (sum, p) => sum + (p.content.length - 200) / 4 + (p.images?.length ?? 0) * IMAGE_TOKENS,
    0,
  );
}

/**
 * A message part as a clear leaves it: a saved tool result becomes a line naming its
 * file, an attachment loses the model's copy of its image (the file stays in uploads/).
 */
function cleared(part: UserPart, files: Map<string, string>): UserPart {
  if (part.type === "attachment") {
    const { image: _, ...rest } = part;
    return rest;
  }
  const path = part.type === "tool_result" ? files.get(part.callId) : undefined;
  if (part.type !== "tool_result" || !path) return part;
  const { images: _, files: __, ...rest } = part;
  return {
    ...rest,
    content:
      `[Tool result cleared from the context to save space (${String(part.content.length)} ` +
      `characters). It is saved whole in ${path} in your workspace: read only what you ` +
      "need from it (head, grep, a script) instead of running the tool again." +
      `${part.images ? " Its images are not in the file." : ""}]`,
  };
}

/** The messages as text for the summarizer, tool output shortened, saved files named. */
function transcript(messages: StoredMessage[], files: Map<string, string>): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === "context") continue;
    for (const part of m.parts) {
      if (part.type === "text") {
        lines.push(`${m.role === "user" ? "User" : `Agent (${m.agent})`}: ${part.text}`);
      } else if (part.type === "attachment") {
        lines.push(`User attached ${part.name} (${part.path} in the workspace)`);
      } else if (part.type === "tool_call") {
        lines.push(
          `Agent called ${part.name}: ${shorten(JSON.stringify(part.input ?? null), 600)}`,
        );
      } else {
        const path = files.get(part.callId);
        lines.push(
          `${part.isError ? "Tool error" : "Tool result"}${path ? ` (saved whole in ${path})` : ""}: ` +
            shorten(part.content, RESULT_IN_SUMMARY),
        );
      }
    }
  }
  const text = lines.join("\n\n");
  return text.length > SUMMARY_INPUT
    ? `[…the oldest messages are left out…]\n\n${text.slice(-SUMMARY_INPUT)}`
    : text;
}

function shorten(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}… [${String(text.length - limit)} more characters]`;
}
