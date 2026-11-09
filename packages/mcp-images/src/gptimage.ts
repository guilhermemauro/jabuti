// MCP server for OpenAI's GPT Image models (stdio), through the Images API. Jabuti
// starts one per agent that uses it, with that agent's OPENAI_API_KEY in its
// environment; the key never reaches the model (C5, C16). Images come back as files
// Jabuti saves in the agent's workspace.
//
// OPENAI_API_URL overrides the endpoint, for tests against a fake.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { answer, Common, errorText, failure, plan, type Generated } from "./common.ts";

const KEY = process.env["OPENAI_API_KEY"] ?? "";
const API = process.env["OPENAI_API_URL"] ?? "https://api.openai.com/v1/images/generations";
const TIMEOUT_MS = 240_000;

/** OpenAI's prices per million tokens, as of 2026-11-06: text in, image out. */
const MODELS = {
  "gpt-image-2.6-flare": { text: 5, image: 30 },
  "gpt-image-2.6-sunburst": { text: 5, image: 30 },
  "gpt-image-2.5-flare": { text: 5, image: 30 },
  "gpt-image-2.5-sunburst": { text: 5, image: 30 },
  "gpt-image-2": { text: 5, image: 30 },
  "gpt-image-1-mini": { text: 2, image: 8 },
} as const;
type Model = keyof typeof MODELS;
const SIZES = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "16:9": "1536x864",
  "9:16": "864x1536",
} as const;
type Aspect = keyof typeof SIZES;

const Answer = z
  .object({
    data: z.array(z.object({ b64_json: z.string().optional() }).loose()).optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

const server = new McpServer({ name: "gptimage", version: "0.1.0" });

server.registerTool(
  "generate",
  {
    description:
      "Generate images with OpenAI's GPT Image models. Each image is saved as a WebP " +
      "file in your workspace and paid from the owner's OpenAI account (about US$ 0.01 " +
      "to 0.20 each, by model and quality). Models: gpt-image-2.6-flare (default, fast " +
      "everyday images), gpt-image-2.6-sunburst (most precise), the 2.5 versions of both, " +
      "gpt-image-2, " +
      "gpt-image-1-mini (cheapest). Good at following detailed instructions and at text " +
      "inside the image.",
    inputSchema: {
      ...Common,
      model: z.enum(Object.keys(MODELS) as [Model, ...Model[]]).optional(),
      aspect_ratio: z
        .enum(Object.keys(SIZES) as [Aspect, ...Aspect[]])
        .optional()
        .describe("Default 16:9, the usual article image."),
      quality: z
        .enum(["low", "medium", "high"])
        .optional()
        .describe("Default medium; high costs several times more."),
    },
  },
  async (input) => {
    if (!KEY) return failure("OPENAI_API_KEY is not set for this agent.");
    const model: Model = input.model ?? "gpt-image-2.6-flare";
    const planned = await plan(input);
    if ("refusal" in planned) return failure(planned.refusal);
    const { wanted, start } = planned;
    const size = SIZES[input.aspect_ratio ?? "16:9"];
    const results = await Promise.all(
      wanted.map((generated) => generate(model, generated, size, input.quality ?? "medium")),
    );
    const images = results.flatMap((r) => ("bytes" in r ? [r] : []));
    const failures = results.flatMap((r) => ("problem" in r ? [r.problem] : []));
    const cost = results.reduce((sum, r) => sum + ("cost" in r ? (r.cost ?? 0) : 0), 0);
    const reported = results.every((r) => !("bytes" in r) || r.cost !== undefined);
    return await answer({
      server: "gptimage",
      model,
      input,
      images,
      failures,
      next: start + wanted.length,
      cost: reported
        ? `Cost: about US$ ${cost.toFixed(4)} (from the tokens OpenAI reported).`
        : "Cost: OpenAI did not report usage; see the OpenAI dashboard.",
    });
  },
);

async function generate(
  model: Model,
  generated: Generated,
  size: string,
  quality: string,
): Promise<{ bytes: Buffer; generated: Generated; cost?: number } | { problem: string }> {
  let res: Response;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: generated.prompt,
        n: 1,
        size,
        quality,
        output_format: "webp",
        output_compression: 85,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { problem: `OpenAI did not answer: ${String(error)}` };
  }
  if (!res.ok) {
    const why = await errorText(res);
    if (res.status === 401)
      return { problem: `OpenAI refused the key: ${why}. Check OPENAI_API_KEY.` };
    if (why.includes("moderation_blocked")) {
      return {
        problem: `OpenAI's moderation blocked the prompt: ${why}. Change the prompt; do not retry it as is.`,
      };
    }
    if (why.toLowerCase().includes("verif")) {
      return {
        problem: `OpenAI: ${why}. GPT Image needs the organization verified in OpenAI's settings.`,
      };
    }
    return { problem: `OpenAI: ${why}` };
  }
  const parsed = Answer.safeParse(await res.json().catch(() => undefined));
  const data = parsed.success ? parsed.data.data?.[0]?.b64_json : undefined;
  if (!parsed.success || !data) return { problem: "OpenAI sent no image." };
  const usage = parsed.data.usage;
  const prices = MODELS[model];
  const cost =
    usage?.output_tokens === undefined
      ? undefined
      : ((usage.input_tokens ?? 0) * prices.text + usage.output_tokens * prices.image) / 1_000_000;
  return { bytes: Buffer.from(data, "base64"), generated, ...(cost === undefined ? {} : { cost }) };
}

await server.connect(new StdioServerTransport());
