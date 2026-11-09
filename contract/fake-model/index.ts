// A ModelProvider that returns scripted replies instead of calling an API, so the
// Contract tests are deterministic and free. It records every request it receives.
import type { AssistantPart } from "@jabuti/protocol";
import type { CatalogModel } from "../../packages/server/src/providers/catalog.ts";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  StopReason,
  Usage,
} from "../../packages/server/src/providers/types.ts";

interface FakeReply {
  text?: string;
  calls?: { name: string; input: unknown; id?: string }[];
  stop?: StopReason;
  usage?: Partial<Usage>;
}

/** Decides the reply from the request: lets one script serve parent and subagent. */
export type Script = (request: ModelRequest, index: number) => FakeReply | Promise<FakeReply>;

export interface RecordedRequest {
  model: string;
  system: string;
  tools: unknown;
  messages: unknown;
}

export const FAKE_MODEL: CatalogModel = {
  id: "fake/scripted",
  provider: "fake",
  model: "scripted",
  label: "Fake",
  // $1 per million tokens either way: easy cost arithmetic in tests.
  pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
};

/** A second model on the same fake provider, for choosing a model per conversation. */
export const FAKE_OTHER: CatalogModel = { ...FAKE_MODEL, id: "fake/other", model: "other" };

export class FakeModel implements ModelProvider {
  readonly id = "fake";
  readonly requests: RecordedRequest[] = [];
  private readonly script: Script;
  private calls = 0;

  constructor(script: Script) {
    this.script = script;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    // Snapshot: the loop keeps appending to the same arrays.
    this.requests.push(
      structuredClone({
        system: request.system,
        model: request.model,
        tools: request.tools,
        messages: request.messages,
      }),
    );
    const reply = await this.script(request, this.calls);
    const n = this.calls++;
    if (reply.text) request.onText(reply.text);
    const parts: AssistantPart[] = [
      ...(reply.text ? [{ type: "text" as const, text: reply.text }] : []),
      ...(reply.calls ?? []).map((c, i) => ({
        type: "tool_call" as const,
        id: c.id ?? `call_${String(n)}_${String(i)}`,
        name: c.name,
        input: c.input,
      })),
    ];
    return {
      parts,
      raw: { provider: "fake", model: FAKE_MODEL.model, content: reply },
      stop: reply.stop ?? (reply.calls?.length ? "tool_use" : "end"),
      usage: {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        ...reply.usage,
      },
    };
  }
}
