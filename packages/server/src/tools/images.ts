// Looking at images (C21): view_images lays web images or workspace files out in one
// numbered mosaic, built by images.py in the agent's own sandbox, never in this
// server (the same reason as C20: an address the model picks cannot reach the
// server or the owner's network). The mosaic goes to the agent's own model with the
// tool result, so whichever provider the agent uses reads it.
import { z } from "zod";
import type { Tool, ToolOutput } from "./types.ts";
import { check, quote } from "./web.ts";

const IMAGES = "/opt/jabuti/venv/bin/python /opt/jabuti/page/images.py";
const TIMEOUT_SECONDS = 90;
const MAX_IMAGES = 16;
/** A file of the workspace: relative, no "..", no option-like names. */
const FILE_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

const Input = z.strictObject({
  images: z
    .array(z.string().max(2_000))
    .min(1)
    .max(MAX_IMAGES)
    .describe(
      "Web addresses (https://…) of images, or paths of image files in your workspace " +
        `(such as mcp/nanobanana/hero.png). Up to ${String(MAX_IMAGES)}; one alone is shown ` +
        "large, several as a numbered grid in this order.",
    ),
});
type Input = z.infer<typeof Input>;

const Printed = z.object({
  mosaic: z.string().nullable(),
  width: z.number().optional(),
  height: z.number().optional(),
  items: z.array(
    z.object({
      n: z.number(),
      source: z.string(),
      ok: z.boolean(),
      width: z.number().optional(),
      height: z.number().optional(),
      format: z.string().optional(),
      bytes: z.number().optional(),
      error: z.string().optional(),
    }),
  ),
});

/** What each source is, in the order given; a problem for the first one that is neither. */
function sources(images: string[]): { sources: string[] } | { problem: string } {
  const out: string[] = [];
  for (const raw of images) {
    const value = raw.trim();
    if (/^https?:\/\//i.test(value)) {
      const checked = check(value);
      if ("problem" in checked) return checked;
      out.push(checked.url);
    } else if (FILE_PATH.test(value.replace(/^\.\//, ""))) {
      out.push(value.replace(/^\.\//, ""));
    } else {
      return {
        problem: `Not a web address or a file of your workspace: ${raw}. Give https://… or a relative path.`,
      };
    }
  }
  return { sources: out };
}

export const viewImagesTool: Tool<Input> = {
  name: "view_images",
  description: () =>
    "Look at images: web addresses or image files in your workspace, shown to you in " +
    "one numbered grid (one image alone is shown large, for its details). Use it to " +
    "learn what a search's images have in common (subjects, setting, framing, style, " +
    "colors, text on them) before writing an image prompt, and to check images you " +
    "generated before using them. Realistic images need a careful look at the details: " +
    "hands and fingers, faces, how many people, screens facing the right way, objects " +
    "that make physical sense, legible text. Each grid costs about as much as a page " +
    "of text in your context; look at what you need, not more.",
  input: Input,
  async execute(input, ctx): Promise<ToolOutput> {
    const permission = ctx.shellPermission();
    if (permission === "deny") {
      return {
        content: "The shell is disabled for this agent: it cannot look at images.",
        isError: true,
      };
    }
    const checked = sources(input.images);
    if ("problem" in checked) return { content: checked.problem, isError: true };
    const out = `jabuti-view/${ctx.callId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || "mosaic"}.jpg`;
    const command = `${IMAGES} mosaic ${out} -- ${checked.sources.map(quote).join(" ")}`;
    if (permission === "ask") {
      const approved = await ctx.requestApproval({ kind: "shell", command });
      if (!approved) return { content: "The user denied this command.", isError: true };
    }
    if (ctx.signal.aborted) return { content: "Cancelled by the user.", isError: true };
    let printed: z.infer<typeof Printed>;
    try {
      const result = await ctx.sandbox.exec(ctx.workspace, command, {
        timeoutSeconds: TIMEOUT_SECONDS,
        env: {},
        signal: ctx.signal,
      });
      if (result.timedOut) {
        return {
          content: `The images took over ${String(TIMEOUT_SECONDS)}s: try fewer.`,
          isError: true,
        };
      }
      if (result.exitCode === 127 || result.output.includes("No such file or directory: '/opt")) {
        return {
          content:
            "This sandbox has no image viewer: it needs the runner image built with " +
            "images.py. Tell the owner to rebuild the runner (docker compose build runner).",
          isError: true,
        };
      }
      const line = result.output.trim().split("\n").at(-1) ?? "";
      const parsed = Printed.safeParse(json(line));
      if (!parsed.success) {
        return {
          content: `The image viewer failed: ${result.output.slice(-500)}`,
          isError: true,
        };
      }
      printed = parsed.data;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { content: "Cancelled by the user.", isError: true };
      }
      return {
        content: `The sandbox could not show the images: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
    const lines = printed.items.map((item) =>
      item.ok
        ? `${String(item.n)}. ${item.source}: ${String(item.width)}×${String(item.height)} ${item.format ?? ""}, ${String(Math.max(1, Math.round((item.bytes ?? 0) / 1024)))} KB`
        : `${String(item.n)}. ${item.source}: could not be shown (${item.error ?? "unknown"})`,
    );
    if (!printed.mosaic) {
      return {
        content: ["None of the images could be shown:", ...lines].join("\n"),
        isError: true,
      };
    }
    let data: Buffer;
    try {
      data = await ctx.sandbox.readFile(ctx.workspace, printed.mosaic, ctx.signal);
    } catch (error) {
      return {
        content: `The mosaic was made but could not be read: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
    const intro =
      printed.items.length === 1
        ? "The image is attached."
        : "The images are attached in one grid, each numbered as listed:";
    return {
      content: [intro, ...lines].join("\n"),
      isError: false,
      images: [{ mediaType: "image/jpeg", data: data.toString("base64") }],
    };
  },
};

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
