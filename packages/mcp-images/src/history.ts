// The images an agent made before, shared by both image connectors (C5). Checked before
// paying: a site whose images show the same things from the same angle looks
// templated, and the model writing the prompts drifts back to the scene it used last.
// The agent names the scene's elements and camera; they are compared here, fuzzily, so
// plurals, accents and typos still match. Synonyms do not, so the refusal shows the
// earlier list.
//
// JABUTI_STATE_DIR is the agent's folder for these connectors, set by Jabuti. Without
// it (a connector run by hand) nothing is kept or checked.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const DIR = process.env["JABUTI_STATE_DIR"];
const FILE = DIR ? join(DIR, "images.jsonl") : undefined;
/** Earlier images compared: the most recent. */
const KEEP = 500;
/** Two names are the same element from this similarity up (1 is identical). */
const SAME = 0.8;

const Made = z.object({
  at: z.string(),
  server: z.string(),
  /** The file_name the agent gave, if any: generating it again is a redo. */
  name: z.string().optional(),
  files: z.array(z.string()),
  elements: z.array(z.string()),
  camera: z.string(),
  prompt: z.string(),
  next: z.number(),
  repeat: z.string().optional(),
});
export type Made = z.infer<typeof Made>;

export const keeping = FILE !== undefined;

export async function earlier(): Promise<Made[]> {
  if (!FILE) return [];
  const raw = await readFile(FILE, "utf8").catch(() => "");
  return raw
    .split("\n")
    .flatMap((line) => {
      try {
        const parsed = Made.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    })
    .slice(-KEEP);
}

export async function remember(made: Made): Promise<void> {
  if (!DIR || !FILE) return;
  await mkdir(DIR, { recursive: true });
  await appendFile(FILE, `${JSON.stringify(made)}\n`);
}

export interface Scene {
  elements: string[];
  camera: string;
  name: string | undefined;
}

/** Why this scene repeats an earlier image, or undefined. */
export function repeated(scene: Scene, before: Made[]): string | undefined {
  let worst: { made: Made; shared: string[]; camera: boolean } | undefined;
  for (const made of before) {
    if (scene.name !== undefined && made.name === scene.name) continue;
    const shared = scene.elements.filter((e) => made.elements.some((m) => same(e, m)));
    const camera = sameCamera(scene.camera, made.camera);
    if (shared.length < 2 && !(camera && shared.length >= 1)) continue;
    if (!worst || score(shared, camera) > score(worst.shared, worst.camera)) {
      worst = { made, shared, camera };
    }
  }
  if (!worst) return undefined;
  const { made, shared, camera } = worst;
  const repeats = [...shared, ...(camera ? [`the ${made.camera} camera`] : [])];
  return (
    `Too close to ${made.files[0] ?? "an earlier image"} (${made.at.slice(0, 10)}): it repeats ` +
    `${repeats.join(", ")}. That image shows: ${made.elements.join(", ")}; camera ` +
    `${made.camera}. Look at it with view_images, then change the visual idea, the ` +
    "objects and the framing, keeping only the style. Nothing was generated or paid. " +
    "If the repetition is on purpose, such as a series, pass repeat_reason."
  );
}

function score(shared: string[], camera: boolean): number {
  return shared.length * 2 + (camera ? 1 : 0);
}

/** "Documentos" and "documento", "isométrica" and "isometric" are the same. */
function same(a: string, b: string): boolean {
  const x = plain(a);
  const y = plain(b);
  if (!x || !y) return false;
  return 1 - distance(x, y) / Math.max(x.length, y.length) >= SAME;
}

/** "isometric" matches "isometric view from above". */
function sameCamera(a: string, b: string): boolean {
  const x = plain(a);
  const y = plain(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x) || same(x, y);
}

function plain(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((word) => (word.length > 3 ? word.replace(/s$/, "") : word))
    .join(" ");
}

/** Levenshtein distance. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next.push(Math.min((row[j] ?? 0) + 1, (next[j - 1] ?? 0) + 1, (row[j - 1] ?? 0) + cost));
    }
    row = next;
  }
  return row[b.length] ?? 0;
}
