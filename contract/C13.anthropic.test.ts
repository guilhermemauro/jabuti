import { describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../packages/server/src/providers/anthropic/index.ts";
import type { ModelMessage } from "../packages/server/src/providers/types.ts";

// The real Anthropic adapter, with fetch replaced: the request is captured and
// refused, so nothing reaches the network and nothing is spent.
async function capture(messages: ModelMessage[]) {
  let sent: { headers: Headers; body: Record<string, unknown> } | undefined;
  const fetch = ((_url: string, init: RequestInit) => {
    sent = {
      headers: new Headers(init.headers),
      // The SDK sends a JSON string body.
      body: JSON.parse(init.body as string) as Record<string, unknown>,
    };
    const response = new Response(
      JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "stop" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
    return Promise.resolve(response);
  }) as typeof globalThis.fetch;
  const provider = createAnthropicProvider("synthetic-key", { fetch });
  await provider
    .complete({
      model: "claude-opus-5-5",
      system: "You are a synthetic agent.",
      tools: [],
      messages,
      signal: new AbortController().signal,
      onText: () => undefined,
    })
    .catch(() => undefined);
  if (!sent) throw new Error("no request was sent");
  return sent;
}

// A turn made under an earlier system prompt, with its thinking block.
const thinking = { type: "thinking", thinking: "synthetic", signature: "c2lnbmF0dXJl" };
const history: ModelMessage[] = [
  { role: "user", parts: [{ type: "text", text: "hi" }] },
  {
    role: "assistant",
    parts: [{ type: "text", text: "hello" }],
    raw: {
      provider: "anthropic",
      model: "claude-opus-5-5",
      content: [thinking, { type: "text", text: "hello" }],
    },
  },
  { role: "user", parts: [{ type: "text", text: "and now?" }] },
];

describe("C13: a changed prefix never breaks replayed history (Anthropic)", () => {
  it("lets the API drop thinking blocks bound to an earlier prefix", async () => {
    // The profile, the model or the agent may have changed since the block was
    // made; the API must drop such blocks, not refuse the request.
    const { headers, body } = await capture(history);
    expect(headers.get("anthropic-beta")).toContain("thinking-binding-controls-2026-08-01");
    expect(body["thinking"]).toEqual({
      type: "adaptive",
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    });
  });

  it("still replays its own thinking blocks verbatim", async () => {
    const { body } = await capture(history);
    const messages = body["messages"] as { role: string; content: unknown[] }[];
    expect(messages[1]?.content[0]).toEqual(thinking);
  });
});
