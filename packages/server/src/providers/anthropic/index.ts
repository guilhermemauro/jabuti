// Anthropic adapter: the only place in the server that imports @anthropic-ai/sdk (C13).
import Anthropic from "@anthropic-ai/sdk";
import type { AssistantPart } from "@jabuti/protocol";
import { attachmentNote } from "../attachments.ts";
import {
  ModelError,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StopReason,
} from "../types.ts";

const PROVIDER = "anthropic";
// Streaming requests do not hit HTTP timeouts, so give the model room.
const MAX_TOKENS = 64_000;
// A thinking block is bound to the system prompt, tools and history it was made
// under. Jabuti changes those on purpose (a profile edit, a model or agent switch),
// so the API is told to drop such blocks instead of refusing the request.
const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

/** `fetch` is for the Contract tests, which capture requests instead of sending them. */
export function createAnthropicProvider(
  apiKey: string,
  options: { fetch?: typeof globalThis.fetch } = {},
): ModelProvider {
  const client = new Anthropic({ apiKey, ...options });
  return {
    id: PROVIDER,
    async complete(request) {
      try {
        return await complete(client, request);
      } catch (error) {
        throw toModelError(error);
      }
    },
  };
}

async function complete(client: Anthropic, request: ModelRequest): Promise<ModelResponse> {
  // Tool inputs are not streamed to the UI yet, so eager_input_streaming would buy
  // nothing and move input validation onto us. Turn it on when the UI shows them.
  const stream = client.beta.messages.stream(
    {
      model: request.model,
      max_tokens: MAX_TOKENS,
      betas: [THINKING_BINDING_BETA],
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
      // Caches the longest stable prefix: system, tools and history so far (C7).
      cache_control: { type: "ephemeral" },
      system: request.system,
      tools: request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: { type: "object", ...t.inputSchema },
      })),
      messages: toAnthropicMessages(request.messages),
    },
    { signal: request.signal },
  );
  stream.on("text", request.onText);
  const message = await stream.finalMessage();

  return {
    parts: message.content.flatMap((block): AssistantPart[] => {
      if (block.type === "text") return [{ type: "text", text: block.text }];
      if (block.type === "tool_use") {
        return [{ type: "tool_call", id: block.id, name: block.name, input: block.input }];
      }
      return []; // thinking and server blocks live only in `raw`
    }),
    raw: { provider: PROVIDER, model: message.model, content: message.content },
    ...toStop(message),
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

function toStop(message: Anthropic.Beta.BetaMessage): { stop: StopReason; stopDetail?: string } {
  switch (message.stop_reason) {
    case "end_turn":
    case "stop_sequence":
      return { stop: "end" };
    case "tool_use":
      return { stop: "tool_use" };
    case "max_tokens":
      return { stop: "max_tokens" };
    case "refusal":
      return { stop: "refusal", stopDetail: message.stop_details?.category ?? "unspecified" };
    case "model_context_window_exceeded":
      return { stop: "other", stopDetail: "the conversation exceeds the model's context window" };
    // compaction: only returned when compaction is requested, which Jabuti does not do yet.
    case "pause_turn":
    case "compaction":
    case null:
      return { stop: "other", stopDetail: `stop reason ${String(message.stop_reason)}` };
  }
}

function toAnthropicMessages(messages: ModelMessage[]): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const message of messages) {
    const content = toContent(message);
    const last = out.at(-1);
    // A budget stop leaves tool results as the last user message, and the next user
    // turn follows it. The API wants alternating roles, so merge consecutive ones.
    if (last?.role === message.role && Array.isArray(last.content)) {
      last.content.push(...content);
    } else {
      out.push({ role: message.role, content });
    }
  }
  return out;
}

function toContent(message: ModelMessage): Anthropic.Beta.BetaContentBlockParam[] {
  if (message.role === "user") {
    return message.parts.flatMap((part): Anthropic.Beta.BetaContentBlockParam[] => {
      if (part.type === "text") return [{ type: "text", text: part.text }];
      if (part.type === "attachment") {
        const note = { type: "text" as const, text: attachmentNote(part) };
        return part.image
          ? [
              note,
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: part.image.mediaType,
                  data: part.image.data,
                },
              },
            ]
          : [note];
      }
      return [
        {
          type: "tool_result",
          tool_use_id: part.callId,
          content: part.images?.length
            ? [
                { type: "text", text: part.content },
                ...part.images.map((image) => ({
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: image.mediaType,
                    data: image.data,
                  },
                })),
              ]
            : part.content,
          is_error: part.isError,
        },
      ];
    });
  }
  // Replay our own record verbatim so thinking blocks stay valid. Blocks written by
  // another Anthropic model are passed too: the API drops the ones it cannot read.
  if (message.raw?.provider === PROVIDER) {
    return message.raw.content as Anthropic.Beta.BetaContentBlockParam[]; // our own stored response
  }
  return message.parts.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "tool_use", id: part.id, name: part.name, input: part.input },
  );
}

function toModelError(error: unknown): ModelError {
  if (error instanceof ModelError) return error;
  if (error instanceof Anthropic.APIUserAbortError) {
    return new ModelError("aborted", "The request was cancelled.", "Send a new message.");
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new ModelError(
      "auth",
      "Anthropic rejected the API key.",
      "Check ANTHROPIC_API_KEY in jabuti/.env and restart the server.",
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ModelError(
      "rate_limit",
      "Anthropic rate limit reached.",
      "Wait a minute and send the message again.",
    );
  }
  if (error instanceof Anthropic.InternalServerError) {
    return new ModelError(
      "overloaded",
      `Anthropic is unavailable (${String(error.status)}).`,
      "Try again in a moment, or pick another model.",
    );
  }
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError) {
    return new ModelError(
      "invalid_request",
      `Anthropic rejected the request: ${error.message}`,
      "This is likely a Jabuti bug. Check the trace for this conversation and report it.",
    );
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ModelError(
      "connection",
      "Could not reach the Anthropic API.",
      "Check your internet connection and send the message again.",
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ModelError(
    "unknown",
    `Model call failed: ${message}`,
    "Check the trace for this conversation and try again.",
  );
}
