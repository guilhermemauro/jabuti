// MCP server for Google's Nano Banana image models (stdio), through the Gemini
// Interactions API. Jabuti starts one per agent that uses it, with that agent's
// GEMINI_API_KEY in its environment; the key never reaches the model (C5, C16).
// Images come back as files Jabuti saves in the agent's workspace.
//
// GEMINI_API_URL overrides the endpoint, for tests against a fake.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { answer, Common, errorText, failure, plan, type Generated } from "./common.ts";

const KEY = process.env["GEMINI_API_KEY"] ?? "";
const API =
  process.env["GEMINI_API_URL"] ?? "https://generativelanguage.googleapis.com/v1beta/interactions";
const TIMEOUT_MS = 180_000;

/** Google's list price per image, by size (paid tier, standard), as of 2026-11. */
const MODELS = {
  "gemini-nano-banana-2.1": { "1K": 0.0336, "2K": 0.0504, "4K": 0.113 },
  "gemini-3.1-flash-image": { "1K": 0.067, "2K": 0.101, "4K": 0.151 },
  "gemini-3-pro-image": { "1K": 0.134, "2K": 0.134, "4K": 0.24 },
} as const;
type Model = keyof typeof MODELS;
const ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;

// Only what is read: the image blocks of the model's output.
const Block = z.object({ type: z.string(), data: z.string().optional() }).loose();
const Interaction = z
  .object({
    steps: z
      .array(z.object({ type: z.string(), content: z.array(Block).optional() }).loose())
      .optional(),
    output_image: z.object({ data: z.string() }).loose().optional(),
  })
  .loose();

const server = new McpServer({ name: "nanobanana", version: "0.1.0" });

server.registerTool(
  "generate",
  {
    description:
      "Generate images with Google's Nano Banana (Gemini image models). Each image is " +
      "saved as a file in your workspace and paid from the owner's Google account " +
      "(about US$ 0.03 to 0.24 each, by model and size). Models: " +
      "gemini-3-pro-image (default: Nano Banana Pro, best detail and text, most " +
      "expensive), gemini-3.1-flash-image, gemini-nano-banana-2.1 (fast and cheapest). " +
      "Images carry Google's SynthID watermark.",
    inputSchema: {
      ...Common,
      model: z.enum(Object.keys(MODELS) as [Model, ...Model[]]).optional(),
      aspect_ratio: z.enum(ASPECTS).optional().describe("Default 16:9, the usual article image."),
      size: z.enum(["1K", "2K", "4K"]).optional().describe("Default 1K: enough for the web."),
    },
  },
  async (input) => {
    if (!KEY) return failure("GEMINI_API_KEY is not set for this agent.");
    const model: Model = input.model ?? "gemini-3-pro-image";
    const size = input.size ?? "1K";
    const planned = await plan(input);
    if ("refusal" in planned) return failure(planned.refusal);
    const { wanted, start } = planned;
    const results = await Promise.all(
      wanted.map((generated) => generate(model, generated, input.aspect_ratio ?? "16:9", size)),
    );
    const images = results.flatMap((r) => ("bytes" in r ? [r] : []));
    const failures = results.flatMap((r) => ("problem" in r ? [r.problem] : []));
    const each = MODELS[model][size];
    return await answer({
      server: "nanobanana",
      model,
      input,
      images,
      failures,
      next: start + wanted.length,
      cost: `Cost: about US$ ${(each * images.length).toFixed(4)} (Google's list price, ${size}).`,
    });
  },
);

async function generate(
  model: Model,
  generated: Generated,
  aspect: string,
  size: string,
): Promise<{ bytes: Buffer; generated: Generated } | { problem: string }> {
  let res: Response;
  try {
    res = await fetch(API, {
      method: "POST",
      headers: { "x-goog-api-key": KEY, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        input: generated.prompt,
        response_format: { type: "image", aspect_ratio: aspect, image_size: size },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return { problem: `Google did not answer: ${String(error)}` };
  }
  if (!res.ok) {
    const why = await errorText(res);
    if (res.status === 401 || res.status === 403) {
      return { problem: `Google refused the key: ${why}. Check GEMINI_API_KEY and billing.` };
    }
    return { problem: `Google: ${why}` };
  }
  const parsed = Interaction.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) return { problem: "Google sent an answer this connector cannot read." };
  const blocks = (parsed.data.steps ?? [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? []);
  const data =
    blocks.find((b) => b.type === "image" && b.data)?.data ?? parsed.data.output_image?.data;
  if (!data) {
    const said = blocks.flatMap((b) =>
      b.type === "text" && typeof b["text"] === "string" ? [b["text"]] : [],
    );
    return {
      problem: `No image came back${said.length > 0 ? `; the model said: ${said.join(" ").slice(0, 300)}` : ""}. Rephrase the prompt.`,
    };
  }
  return { bytes: Buffer.from(data, "base64"), generated };
}

await server.connect(new StdioServerTransport());
