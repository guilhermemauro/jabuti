import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../packages/server/src/db/index.ts";
import { CONNECTORS, type ConnectorSpec } from "../packages/server/src/mcp/catalog.ts";
import { Mcp } from "../packages/server/src/mcp/index.ts";
import { Settings } from "../packages/server/src/settings/index.ts";
import type { Script } from "./fake-model/index.ts";
import { agent, harness } from "./harness.ts";

// C5 for the two image connectors, against fake Gemini and OpenAI APIs. The images
// are synthetic bytes with real file signatures.
const GEMINI_KEY = "synthetic-gemini-key";
const OPENAI_KEY = "synthetic-openai-key";
const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("synthetic-png")]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from("WEBPsynthetic"),
]);

const seen: { path: string; body: Record<string, unknown>; headers: Record<string, unknown> }[] =
  [];
let respond: (path: string, body: Record<string, unknown>) => { status: number; body: object } = (
  path,
) =>
  path.startsWith("/gemini")
    ? {
        status: 200,
        body: {
          steps: [
            { type: "thought", content: [] },
            { type: "model_output", content: [{ type: "image", data: PNG.toString("base64") }] },
          ],
        },
      }
    : {
        status: 200,
        body: {
          data: [{ b64_json: WEBP.toString("base64") }],
          usage: { input_tokens: 100, output_tokens: 1_000 },
        },
      };
const original = respond;

const fake = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
  req.on("end", () => {
    const body = JSON.parse(raw || "{}") as Record<string, unknown>;
    seen.push({ path: req.url ?? "", body, headers: req.headers });
    const answer = respond(req.url ?? "", body);
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body));
  });
});

const connectors: Record<string, ConnectorSpec> = {};
beforeAll(async () => {
  await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${String((fake.address() as AddressInfo).port)}`;
  for (const [name, env] of [
    ["nanobanana", { GEMINI_API_URL: `${base}/gemini` }],
    ["gptimage", { OPENAI_API_URL: `${base}/openai` }],
  ] as const) {
    const real = CONNECTORS.find((c) => c.name === name);
    if (!real) throw new Error(`${name} connector missing`);
    connectors[name] = { ...real, env };
  }
});
afterAll(() => fake.close());

const clients: Mcp[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((m) => m.close()));
  seen.length = 0;
  respond = original;
});

/** A fresh image history per test, unless one is passed to share it. */
function run(
  server: "nanobanana" | "gptimage",
  input: object,
  state = mkdtempSync(join(tmpdir(), "jabuti-images-")),
) {
  const settings = new Settings(openDatabase(":memory:"), randomBytes(32), {});
  settings.saveVariable({
    name: "GEMINI_API_KEY",
    value: GEMINI_KEY,
    scope: ["blog"],
    shell: false,
  });
  settings.saveVariable({
    name: "OPENAI_API_KEY",
    value: OPENAI_KEY,
    scope: ["blog"],
    shell: false,
  });
  const connector = connectors[server];
  if (!connector) throw new Error("not set up");
  const mcp = new Mcp([connector], (a, n) => settings.value(a, n), state);
  clients.push(mcp);
  const script: Script = (_, i) =>
    i === 0 ? { calls: [{ name: `mcp__${server}__generate`, input }] } : { text: "done" };
  return harness({
    script,
    agents: [agent("blog", { mcp: [server] })],
    mcp,
    connectors: [connector],
    settings,
  });
}

const result = (h: ReturnType<typeof run>) =>
  h.events.flatMap((e) => (e.type === "tool.finished" ? [e] : []))[0];

const vary = {
  people: ["one woman in her 50s", "two young men", "a family of four"],
  setting: ["living room", "office"],
};

describe("C5: image connectors generate files in the agent's workspace", () => {
  it("Nano Banana: rotates the variations in code and saves each image under a keyword name", async () => {
    const h = run("nanobanana", {
      prompt: "People exchanging gifts, photo",
      elements: ["people", "gifts"],
      camera: "eye level",
      count: 2,
      vary,
      start: 1,
      file_name: "Amigo secreto no WhatsApp",
    });
    await h.turn("make images");

    expect(seen.map((s) => s.path)).toEqual(["/gemini", "/gemini"]);
    expect(seen[0]?.headers["x-goog-api-key"]).toBe(GEMINI_KEY);
    const prompts = seen.map((s) => s.body["input"]).sort();
    expect(prompts).toEqual([
      "People exchanging gifts, photo\n\nFor this image: people: a family of four; setting: living room.",
      "People exchanging gifts, photo\n\nFor this image: people: two young men; setting: office.",
    ]);
    expect(seen[0]?.body).toMatchObject({
      model: "gemini-3-pro-image",
      response_format: { type: "image", aspect_ratio: "16:9", image_size: "1K" },
    });

    expect(h.sandbox.files).toHaveLength(2);
    for (const file of h.sandbox.files) {
      expect(file.workspace).toBe("blog");
      expect(file.path).toMatch(
        /^mcp\/nanobanana\/amigo-secreto-no-whatsapp-[0-9a-f]{4}-[12]\.png$/,
      );
      expect(Buffer.isBuffer(file.content) && file.content.equals(PNG)).toBe(true);
    }
    // The owner sees each image below the call, served from the workspace, not sent to the model.
    expect(result(h)?.files).toEqual(
      h.sandbox.files.map((f) => ({ workspace: "blog", path: f.path })),
    );
    const text = result(h)?.content ?? "";
    expect(result(h)?.isError).toBe(false);
    expect(text).toContain("(people: two young men; setting: office)");
    expect(text).toContain("the next call continues at 3 on its own");
    expect(text).toContain("Cost: about US$ 0.2680");
    expect(text).toContain("view_images");
    // The key never reaches the model.
    expect(JSON.stringify([h.model.requests, h.events])).not.toContain(GEMINI_KEY);
  });

  it("GPT Image: asks for WebP at the ratio's size and reports the cost from the tokens", async () => {
    const h = run("gptimage", {
      prompt: "A phone on a desk, screen facing the viewer",
      elements: ["phone", "desk"],
      camera: "close-up",
    });
    await h.turn("make one");
    expect(seen[0]?.path).toBe("/openai");
    expect(seen[0]?.headers["authorization"]).toBe(`Bearer ${OPENAI_KEY}`);
    expect(seen[0]?.body).toEqual({
      model: "gpt-image-2.6-flare",
      prompt: "A phone on a desk, screen facing the viewer",
      n: 1,
      size: "1536x864",
      quality: "medium",
      output_format: "webp",
      output_compression: 85,
    });
    expect(h.sandbox.files[0]?.path).toMatch(/^mcp\/gptimage\/image-[0-9a-f]{4}-1\.webp$/);
    // (100 × 5 + 1000 × 30) / 1M
    expect(result(h)?.content).toContain("Cost: about US$ 0.0305");
    expect(JSON.stringify([h.model.requests, h.events])).not.toContain(OPENAI_KEY);
  });

  it("refuses, before paying, a scene that repeats an earlier image of the site", async () => {
    const state = mkdtempSync(join(tmpdir(), "jabuti-images-"));
    const style = "Flat, dark navy, electric blue highlights, no text";
    const first = run(
      "gptimage",
      {
        prompt: "A signed document by a gavel, lines flowing to a house, a car and a safe",
        style,
        elements: ["document", "gavel", "house", "car", "safe"],
        camera: "isometric",
        vary: { light: ["soft", "hard"] },
        file_name: "acao monitoria capa",
      },
      state,
    );
    await first.turn("cover");
    expect(seen[0]?.body["prompt"]).toBe(
      `A signed document by a gavel, lines flowing to a house, a car and a safe\n\nStyle: ${style}\n\nFor this image: light: soft.`,
    );
    const saved = first.sandbox.files[0]?.path ?? "";

    // Plurals, accents and a longer camera still match; the style is not compared.
    seen.length = 0;
    const second = run(
      "gptimage",
      {
        prompt: "A building under a veil, lines to houses, cars and documents",
        style,
        elements: ["building", "veil", "houses", "cars", "documentos"],
        camera: "isométrica, vista de cima",
        file_name: "desconsideracao capa",
      },
      state,
    );
    await second.turn("cover");
    expect(seen).toEqual([]);
    expect(result(second)?.isError).toBe(true);
    const why = result(second)?.content ?? "";
    expect(why).toContain(`Too close to ${saved}`);
    expect(why).toContain("houses, cars, documentos, the isometric camera");
    expect(why).toContain("That image shows: document, gavel, house, car, safe");
    expect(why).toContain("Nothing was generated or paid");

    // A different scene passes, and the rotation continues where the first call stopped.
    const third = run(
      "gptimage",
      {
        prompt: "A judge's bench seen from the front, a scale glowing",
        style,
        elements: ["bench", "scale", "document"],
        camera: "front at eye level",
        vary: { light: ["soft", "hard"] },
        file_name: "desconsideracao capa",
      },
      state,
    );
    await third.turn("cover");
    expect(result(third)?.isError).toBe(false);
    expect(seen[0]?.body["prompt"]).toContain("For this image: light: hard.");

    // A redo of the same file_name is not checked; repeat_reason skips the check.
    seen.length = 0;
    const redo = run(
      "gptimage",
      {
        prompt: "Again",
        elements: ["bench", "scale"],
        camera: "front",
        file_name: "desconsideracao capa",
      },
      state,
    );
    await redo.turn("again");
    const series = run(
      "gptimage",
      {
        prompt: "Part two",
        elements: ["house", "car"],
        camera: "isometric",
        repeat_reason: "a series of covers on purpose",
      },
      state,
    );
    await series.turn("series");
    expect(seen).toHaveLength(2);

    const history = readFileSync(join(state, "blog", "images", "images.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(history).toHaveLength(4);
    expect(history[0]).toMatchObject({
      server: "gptimage",
      name: "acao-monitoria-capa",
      files: [saved],
      elements: ["document", "gavel", "house", "car", "safe"],
      camera: "isometric",
      next: 1,
    });
    expect(history[3]).toMatchObject({ repeat: "a series of covers on purpose" });
  });

  it("explains a refused key, a blocked prompt and an answer without an image", async () => {
    respond = () => ({ status: 403, body: { error: { message: "API key not valid." } } });
    const refused = run("nanobanana", { prompt: "a cat", elements: ["cat"], camera: "close-up" });
    await refused.turn("go");
    expect(result(refused)).toMatchObject({ isError: true });
    expect(result(refused)?.content).toContain("Google refused the key: API key not valid.");
    expect(refused.sandbox.files).toEqual([]);
    expect(result(refused)?.files).toBeUndefined();

    respond = () => ({
      status: 400,
      body: { error: { message: "Your request was rejected.", code: "moderation_blocked" } },
    });
    const blocked = run("gptimage", { prompt: "something", elements: ["thing"], camera: "wide" });
    await blocked.turn("go");
    expect(result(blocked)?.content).toContain("do not retry it as is");

    respond = () => ({
      status: 200,
      body: {
        steps: [{ type: "model_output", content: [{ type: "text", text: "I cannot draw that." }] }],
      },
    });
    const empty = run("nanobanana", { prompt: "something", elements: ["thing"], camera: "wide" });
    await empty.turn("go");
    expect(result(empty)).toMatchObject({ isError: true });
    expect(result(empty)?.content).toContain("the model said: I cannot draw that.");
  });
});
