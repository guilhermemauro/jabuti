import type { AttachmentPart } from "@jabuti/protocol";
import { ClientMessage } from "@jabuti/protocol";
import { describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../packages/server/src/providers/anthropic/index.ts";
import { harness } from "./harness.ts";

// C21 for files the owner attaches: saved in the workspace by /api/upload (C15 tests
// that route), then sent with the message. An image goes to the model reduced; any
// other file is named, for the agent to read with the shell.
const photo: AttachmentPart = {
  type: "attachment",
  path: "uploads/2026-11-07/capa-1a2b.png",
  name: "capa.png",
  mediaType: "image/png",
  size: 204_800,
  image: { mediaType: "image/jpeg", data: "c3ludGhldGlj" },
};
const brief: AttachmentPart = {
  type: "attachment",
  path: "uploads/2026-11-07/briefing-3c4d.pdf",
  name: "Briefing.pdf",
  mediaType: "application/pdf",
  size: 348_160,
};

describe("C21: the owner attaches files to a message", () => {
  it("stores the files before the words, and hands them to the model", async () => {
    const h = harness({ script: () => ({ text: "ok" }) });
    const problem = h.runtime.send(h.conversationId, "Qual capa usar?", {
      attachments: [photo, brief],
    });
    expect(problem).toBeUndefined();
    await h.runtime.idle(h.conversationId);
    expect(h.history()[0]?.parts).toEqual([
      photo,
      brief,
      { type: "text", text: "Qual capa usar?" },
    ]);
    const messages = h.model.requests[0]?.messages as { parts: unknown[] }[] | undefined;
    expect(messages?.[0]?.parts).toEqual([photo, brief, { type: "text", text: "Qual capa usar?" }]);
  });

  it("sends files alone, titled by their names, but never an empty message", async () => {
    const h = harness({ script: () => ({ text: "ok" }) });
    expect(h.runtime.send(h.conversationId, "  ")?.message).toBe("The message is empty.");
    expect(h.runtime.send(h.conversationId, "", { attachments: [brief] })).toBeUndefined();
    await h.runtime.idle(h.conversationId);
    expect(h.history()[0]?.parts).toEqual([brief]);
    expect(h.store.get(h.conversationId)?.title).toBe("Briefing.pdf");
  });

  it("accepts only paths under uploads/ from the UI", () => {
    const send = (path: string) =>
      ClientMessage.safeParse({
        type: "message.send",
        conversationId: "c",
        text: "",
        attachments: [{ ...brief, path }],
      }).success;
    expect(send(brief.path)).toBe(true);
    for (const bad of ["notes/brief.md", "uploads/2026-11-07/../../x", "/etc/passwd"]) {
      expect(send(bad), bad).toBe(false);
    }
  });

  it("gives Anthropic the note and the image, and only the note for a document", async () => {
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
        messages: [{ role: "user", parts: [photo, brief, { type: "text", text: "Qual?" }] }],
        signal: new AbortController().signal,
        onText: () => undefined,
      })
      .catch(() => undefined);
    const content = body?.messages[0]?.content ?? [];
    expect(content).toHaveLength(4);
    expect(content[0]).toMatchObject({ type: "text" });
    expect((content[0] as { text: string }).text).toContain(
      "uploads/2026-11-07/capa-1a2b.png in your workspace",
    );
    expect(content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "c3ludGhldGlj" },
    });
    expect((content[2] as { text: string }).text).toContain("Read it with the shell");
    expect(content[3]).toEqual({ type: "text", text: "Qual?" });
  });
});
