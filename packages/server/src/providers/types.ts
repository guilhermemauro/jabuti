// The provider-neutral model interface. The loop only knows this file; each
// provider adapter (providers/<name>/) translates to and from its own API.
import type { AssistantPart, UserPart } from "@jabuti/protocol";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the tool input. */
  inputSchema: Record<string, unknown>;
}

/**
 * A message as the provider sees it. `raw` is the provider's verbatim record of an
 * assistant message (thinking blocks, signatures). Adapters replay it unchanged
 * when the same provider reads it back, because some providers reject edited
 * history. `parts` is the neutral view of the same message; both are written once.
 */
export type ModelMessage =
  | { role: "user"; parts: UserPart[] }
  | { role: "assistant"; parts: AssistantPart[]; raw?: ProviderRecord };

export interface ProviderRecord {
  provider: string;
  model: string;
  content: unknown;
}

export interface ModelRequest {
  /** Model id within the provider, e.g. "claude-opus-5-5". */
  model: string;
  system: string;
  tools: ToolSpec[];
  messages: ModelMessage[];
  signal: AbortSignal;
  onText: (delta: string) => void;
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ModelResponse {
  parts: AssistantPart[];
  raw: ProviderRecord;
  stop: StopReason;
  /** Provider detail for refusals and unexpected stops, shown to the user. */
  stopDetail?: string;
  usage: Usage;
}

export type ModelErrorKind =
  "auth" | "rate_limit" | "overloaded" | "invalid_request" | "connection" | "aborted" | "unknown";

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly nextStep: string;

  constructor(kind: ModelErrorKind, message: string, nextStep: string) {
    super(message);
    this.kind = kind;
    this.nextStep = nextStep;
  }
}

export interface ModelProvider {
  /** Provider id, the prefix of a catalog model id ("anthropic/..."). */
  readonly id: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
