// What the two image connectors share (C5): the input every generation takes, the
// rotation of variations, file names and the answer. Each connector is its own MCP
// server with its own key; the owner turns on the ones an agent may use.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { earlier, keeping, remember, repeated } from "./history.ts";

const MAX_COUNT = 4;

export const Common = {
  prompt: z
    .string()
    .min(3)
    .max(4_000)
    .describe(
      "The scene: subject, setting, framing, light. For realistic images, state what " +
        "must be physically right, such as which way a phone's screen faces or how many " +
        "people there are. The look every image of the site shares goes in style.",
    ),
  style: z
    .string()
    .max(1_500)
    .optional()
    .describe(
      "The look the site's images share: technique, palette, mood, no text. Kept apart " +
        "from the scene, so each image keeps the look and changes the scene.",
    ),
  elements: z
    .array(z.string().min(1).max(40))
    .min(1)
    .max(8)
    .describe(
      'The scene\'s main objects or subjects, one or two words each, such as ["building", ' +
        '"veil", "house"]. Checked before paying against the images you made before: a ' +
        "scene repeating two elements of an earlier image, or its camera and one element, " +
        "is refused, since a site whose images show the same things looks templated. " +
        "Making the same file_name again, a redo, is not checked.",
    ),
  camera: z
    .string()
    .min(1)
    .max(60)
    .describe(
      "The viewpoint in a few words: isometric, front at eye level, top-down, close-up, " +
        "wide shot, over the shoulder.",
    ),
  repeat_reason: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Only to repeat an earlier scene on purpose, such as a series: why. Skips the check.",
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(MAX_COUNT)
    .optional()
    .describe(
      `How many images, 1 to ${String(MAX_COUNT)}; each is paid. Default 1. Make one ` +
        "unless the user asked for options or you need several different images, such " +
        "as one per section; do not make alternatives for the user to pick from.",
    ),
  vary: z
    .record(z.string().min(1).max(40), z.array(z.string().min(1).max(120)).min(2).max(12))
    .optional()
    .describe(
      "Variations rotated across the images, so they do not all look alike: each key " +
        'an aspect, each value its options, e.g. {"people": ["one woman in her 50s", ' +
        '"two young men"], "setting": ["kitchen", "office"]}. Every image takes the next ' +
        "option of every aspect. Image models drift to the same face, age and scene " +
        "when asked for variety in words; this rotation is done in code.",
    ),
  start: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .describe(
      "Where the rotation starts. Default: where the previous call left off, so it " +
        "keeps rotating across calls and articles.",
    ),
  file_name: z
    .string()
    .max(80)
    .optional()
    .describe(
      "Words for the file name, such as the page's keyword: the file is named after " +
        "them, which search engines read. Default image.",
    ),
};

export interface Generated {
  prompt: string;
  /** The rotation's options this image took. */
  took: string[];
}

export interface Input {
  prompt: string;
  style?: string | undefined;
  elements: string[];
  camera: string;
  repeat_reason?: string | undefined;
  count?: number | undefined;
  vary?: Record<string, string[]> | undefined;
  start?: number | undefined;
  file_name?: string | undefined;
}

/** Before paying: why the scene repeats an earlier image, or the prompt of each image. */
export async function plan(
  input: Input,
): Promise<{ refusal: string } | { wanted: Generated[]; start: number }> {
  const before = await earlier();
  if (!input.repeat_reason) {
    const name = input.file_name === undefined ? undefined : slug(input.file_name);
    const why = repeated({ elements: input.elements, camera: input.camera, name }, before);
    if (why) return { refusal: why };
  }
  const start = input.start ?? before.at(-1)?.next ?? 0;
  const base = input.style ? `${input.prompt}\n\nStyle: ${input.style}` : input.prompt;
  return { wanted: rotate(base, input.count ?? 1, input.vary, start), start };
}

/** The prompt of each image: the base plus the rotation's next option of every aspect. */
function rotate(
  prompt: string,
  count: number,
  vary: Record<string, string[]> | undefined,
  start: number,
): Generated[] {
  const aspects = Object.entries(vary ?? {});
  return Array.from({ length: count }, (_, i) => {
    const n = start + i;
    const took = aspects.map(
      ([aspect, options]) => `${aspect}: ${options[n % options.length] ?? ""}`,
    );
    return {
      prompt: took.length > 0 ? `${prompt}\n\nFor this image: ${took.join("; ")}.` : prompt,
      took,
    };
  });
}

/** "Amigo secreto, no WhatsApp!" -> "amigo-secreto-no-whatsapp". */
function slug(words: string | undefined): string {
  const plain = (words ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return plain || "image";
}

/** The file type, from the bytes: providers do not always say. */
function kind(bytes: Buffer): { ext: string; mimeType: string } {
  if (bytes.subarray(0, 4).toString("hex") === "89504e47")
    return { ext: "png", mimeType: "image/png" };
  if (bytes.subarray(0, 3).toString("hex") === "ffd8ff")
    return { ext: "jpg", mimeType: "image/jpeg" };
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") {
    return { ext: "webp", mimeType: "image/webp" };
  }
  return { ext: "bin", mimeType: "application/octet-stream" };
}

export type Content =
  | { type: "text"; text: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

/** The answer: one file per image (Jabuti saves it in the workspace) and a summary. */
export async function answer(input: {
  server: string;
  model: string;
  input: Input;
  images: { bytes: Buffer; generated: Generated }[];
  failures: string[];
  next: number;
  cost: string;
}): Promise<{ content: Content[]; isError?: boolean }> {
  const base = `${slug(input.input.file_name)}-${randomBytes(2).toString("hex")}`;
  const files: string[] = [];
  const content: Content[] = [];
  const lines = [`${input.server}, ${input.model}: ${String(input.images.length)} image(s).`];
  input.images.forEach(({ bytes, generated }, i) => {
    const { ext, mimeType } = kind(bytes);
    const name = `${base}-${String(i + 1)}.${ext}`;
    files.push(`mcp/${input.server}/${name}`);
    content.push({
      type: "resource",
      resource: { uri: `${input.server}://${name}`, mimeType, blob: bytes.toString("base64") },
    });
    lines.push(
      `${String(i + 1)}. ${name}${generated.took.length > 0 ? ` (${generated.took.join("; ")})` : ""}`,
    );
  });
  for (const failure of input.failures) lines.push(`Failed: ${failure}`);
  lines.push(
    keeping
      ? `Rotation: the next call continues at ${String(input.next)} on its own.`
      : `Rotation: pass start ${String(input.next)} next time to keep varying.`,
    input.cost,
    "Look at each image with view_images before using it. A realistic image needs a " +
      "careful look at the details (hands, faces, how many people, screens facing the " +
      "right way, objects that make sense, text): regenerate one that is wrong. Write " +
      "its alt text from what it shows, and convert it to WebP at the size the page " +
      "uses before publishing. The user already sees these images below this call; to show " +
      "them another file, put ![short description](its/path) in your reply.",
  );
  if (files.length > 0) {
    const { file_name, elements, camera, prompt, repeat_reason } = input.input;
    await remember({
      at: new Date().toISOString(),
      server: input.server,
      ...(file_name === undefined ? {} : { name: slug(file_name) }),
      files,
      elements,
      camera,
      prompt,
      next: input.next,
      ...(repeat_reason ? { repeat: repeat_reason } : {}),
    }).catch((error: unknown) => {
      lines.push(`Not added to the image history: ${String(error)}`);
    });
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }, ...content],
    ...(input.images.length === 0 ? { isError: true } : {}),
  };
}

export function failure(text: string): { content: Content[]; isError: true } {
  return { content: [{ type: "text", text }], isError: true };
}

/** An HTTP error body's message, whatever shape the provider used. */
export async function errorText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  try {
    const body = JSON.parse(raw) as { error?: { message?: unknown; code?: unknown } | string };
    if (typeof body.error === "string") return body.error;
    const message = typeof body.error?.message === "string" ? body.error.message : "";
    const code = typeof body.error?.code === "string" ? ` (${body.error.code})` : "";
    if (message) return `${message}${code}`;
  } catch {
    // Not JSON: the start of the text.
  }
  return raw.slice(0, 300) || `HTTP ${String(res.status)}`;
}
