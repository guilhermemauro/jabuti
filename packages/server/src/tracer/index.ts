// One JSONL line per model step (C8). Traces are local logs: they hold message and
// tool content by design and never leave the machine.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const RESULT_LIMIT = 2_000;

export interface StepTrace {
  conversationId: string;
  /** Present when the step ran inside a subagent. */
  subagent?: { callId: string; agent: string };
  agent: string;
  model: string;
  step: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  stop: string;
  output: string;
  toolCalls: { id: string; name: string; input: unknown }[];
  toolResults: { callId: string; content: string; isError: boolean }[];
}

/** One memory capture (C18): what it read, what it cost, what it proposed. */
export interface CaptureTrace {
  conversationId: string;
  agent: string;
  model: string;
  /** Messages read, by position: from inclusive, to exclusive. */
  read: { from: number; to: number };
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  changes: unknown[];
  problem?: string;
}

/** A context reduction (C10): a clear, a summary, or a summary that failed. */
export interface ContextTrace {
  conversationId: string;
  agent: string;
  model: string;
  mode: "summary" | "clear";
  /** Stored position of the first message kept whole. */
  from: number;
  /** The context's size before, in tokens. */
  tokens: number;
  manual: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  summary?: string;
  problem?: string;
}

export interface Tracer {
  step(trace: StepTrace): void;
  /** Optional: test tracers that only check steps leave them out. */
  capture?(trace: CaptureTrace): void;
  context?(trace: ContextTrace): void;
}

export class JsonlTracer implements Tracer {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  step(trace: StepTrace) {
    const line = {
      at: new Date().toISOString(),
      ...trace,
      toolResults: trace.toolResults.map((r) => ({ ...r, content: truncate(r.content) })),
    };
    this.append(trace.conversationId, line);
  }

  capture(trace: CaptureTrace) {
    this.append(trace.conversationId, { at: new Date().toISOString(), kind: "capture", ...trace });
  }

  context(trace: ContextTrace) {
    this.append(trace.conversationId, { at: new Date().toISOString(), kind: "context", ...trace });
  }

  private append(conversationId: string, line: object) {
    appendFileSync(join(this.dir, `${conversationId}.jsonl`), JSON.stringify(line) + "\n");
  }
}

function truncate(text: string): string {
  return text.length <= RESULT_LIMIT
    ? text
    : `${text.slice(0, RESULT_LIMIT)}… [${String(text.length - RESULT_LIMIT)} more chars]`;
}
