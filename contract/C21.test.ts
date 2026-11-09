import { describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../packages/server/src/providers/anthropic/index.ts";
import type { Script } from "./fake-model/index.ts";
import { agent, harness } from "./harness.ts";

const IMAGES = "/opt/jabuti/venv/bin/python /opt/jabuti/page/images.py";
const JPEG = Buffer.from("ffd8ffe0synthetic-mosaic", "utf8");

const looks =
  (images: string[]): Script =>
  (_, i) =>
    i === 0 ? { calls: [{ name: "view_images", input: { images } }] } : { text: "ok" };

const results = (h: ReturnType<typeof harness>) =>
  h.events.flatMap((e) => (e.type === "tool.finished" ? [e] : []));

const viewer = agent("viewer", { tools: ["view_images"], permissions: { shell: "auto" } });

/** What images.py prints for these sources: all shown, or the ones named failed. */
function printed(sources: string[], failed: string[] = []) {
  const items = sources.map((source, i) =>
    failed.includes(source)
      ? { n: i + 1, source, ok: false, error: "HTTP Error 403: Forbidden" }
      : { n: i + 1, source, ok: true, width: 800, height: 600, format: "JPEG", bytes: 40_960 },
  );
  const any = items.some((i) => i.ok);
  return JSON.stringify(any ? { mosaic: "jabuti-view/c.jpg", items } : { mosaic: null, items });
}

describe("C21: the agent's own model looks at images, built into one mosaic in its sandbox", () => {
  it("runs images.py in the agent's workspace and shows the mosaic to its model", async () => {
    const sources = ["https://img.example/a.jpg", "mcp/nanobanana/hero-1.png"];
    const h = harness({ script: looks(sources), agents: [viewer] });
    h.sandbox.next = () => ({ exitCode: 0, output: printed(sources), timedOut: false });
    h.sandbox.readNext = () => JPEG;
    await h.turn("look");

    const [command] = h.sandbox.commands;
    expect(command).toMatch(
      new RegExp(
        `^${IMAGES.replaceAll(".", "\\.")} mosaic jabuti-view/[A-Za-z0-9_-]+\\.jpg -- ` +
          `'https://img\\.example/a\\.jpg' 'mcp/nanobanana/hero-1\\.png'$`,
      ),
    );
    expect(h.sandbox.workspaces).toEqual(["viewer"]);
    expect(h.sandbox.envs).toEqual([{}]);
    expect(h.sandbox.reads).toEqual([{ workspace: "viewer", path: "jabuti-view/c.jpg" }]);

    const image = { mediaType: "image/jpeg", data: JPEG.toString("base64") };
    expect(results(h)[0]).toMatchObject({ isError: false, images: [image] });
    expect(results(h)[0]?.content).toContain("1. https://img.example/a.jpg: 800×600 JPEG, 40 KB");
    // The next request carries it, to whichever model the agent uses.
    const messages = h.model.requests[1]?.messages as { parts: unknown[] }[] | undefined;
    const answered = messages?.at(-1)?.parts[0];
    expect(answered).toMatchObject({ type: "tool_result", images: [image] });
  });

  it("names what could not be shown, and fails only when nothing could", async () => {
    const sources = ["https://img.example/a.jpg", "https://img.example/b.jpg"];
    const some = harness({ script: looks(sources), agents: [viewer] });
    some.sandbox.next = () => ({
      exitCode: 0,
      output: printed(sources, ["https://img.example/b.jpg"]),
      timedOut: false,
    });
    await some.turn("go");
    expect(results(some)[0]?.isError).toBe(false);
    expect(results(some)[0]?.content).toContain(
      "2. https://img.example/b.jpg: could not be shown (HTTP Error 403: Forbidden)",
    );

    const none = harness({ script: looks(sources), agents: [viewer] });
    none.sandbox.next = () => ({ exitCode: 1, output: printed(sources, sources), timedOut: false });
    await none.turn("go");
    expect(results(none)[0]).toMatchObject({ isError: true });
    expect(results(none)[0]?.images).toBeUndefined();
    expect(none.sandbox.reads).toEqual([]);

    const old = harness({ script: looks(sources), agents: [viewer] });
    old.sandbox.next = () => ({ exitCode: 127, output: "not found", timedOut: false });
    await old.turn("go");
    expect(results(old)[0]?.content).toContain("docker compose build runner");
  });

  it("refuses what is neither a web address nor a file of the workspace, before running", async () => {
    for (const bad of [
      "/etc/passwd",
      "../other-agent/secret.png",
      "file:///etc/passwd",
      "https://user:secret@img.example/a.jpg",
      "-rf.png",
    ]) {
      const h = harness({ script: looks([bad]), agents: [viewer] });
      await h.turn("go");
      expect(h.sandbox.commands, bad).toEqual([]);
      expect(results(h)[0]?.isError, bad).toBe(true);
    }
    const quoted = harness({ script: looks(["https://img.example/a'b;id.jpg"]), agents: [viewer] });
    quoted.sandbox.next = () => ({ exitCode: 1, output: "", timedOut: false });
    await quoted.turn("go");
    expect(quoted.sandbox.commands[0]).toContain("'https://img.example/a'\\''b;id.jpg'");
  });

  it("asks first in ask mode, and is offered only with a sandbox to run in", async () => {
    const careful = agent("careful", { tools: ["view_images"], permissions: { shell: "ask" } });
    const h = harness({
      script: looks(["https://img.example/a.jpg"]),
      agents: [careful],
      approvals: "deny",
    });
    await h.turn("go");
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: "approval.requested",
        action: expect.objectContaining({ kind: "shell" }) as unknown,
      }),
    );
    expect(h.sandbox.commands).toEqual([]);

    const offered = async (profile: ReturnType<typeof agent>) => {
      const t = harness({ script: () => ({ text: "ok" }), agents: [profile] });
      await t.turn("hi");
      return (t.model.requests[0]?.tools as { name: string }[]).map((x) => x.name);
    };
    expect(await offered(viewer)).toContain("view_images");
    expect(
      await offered(agent("d", { tools: ["view_images"], permissions: { shell: "deny" } })),
    ).not.toContain("view_images");
  });

  it("sends the mosaic to Anthropic as an image block of the tool result", async () => {
    let body: { messages: { content: unknown[] }[] } | undefined;
    const fetch = ((_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string) as typeof body;
      return Promise.resolve(
        new Response(JSON.stringify({ type: "error", error: { type: "x", message: "stop" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof globalThis.fetch;
    await createAnthropicProvider("synthetic-key", { fetch })
      .complete({
        model: "claude-opus-5-5",
        system: "s",
        tools: [],
        messages: [
          { role: "user", parts: [{ type: "text", text: "look" }] },
          {
            role: "assistant",
            parts: [{ type: "tool_call", id: "c1", name: "view_images", input: {} }],
          },
          {
            role: "user",
            parts: [
              {
                type: "tool_result",
                callId: "c1",
                content: "The image is attached.",
                isError: false,
                images: [{ mediaType: "image/jpeg", data: "c3ludGhldGlj" }],
              },
            ],
          },
        ],
        signal: new AbortController().signal,
        onText: () => undefined,
      })
      .catch(() => undefined);
    expect(body?.messages[2]?.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "c1",
      content: [
        { type: "text", text: "The image is attached." },
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: "c3ludGhldGlj" },
        },
      ],
    });
  });
});
