import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../packages/server/src/db/index.ts";
import { Settings } from "../packages/server/src/settings/index.ts";
import type { Script } from "./fake-model/index.ts";
import { agent, harness } from "./harness.ts";

const PAGE = "/opt/jabuti/venv/bin/python /opt/jabuti/page/page.py";
const CRAWL = "/opt/jabuti/venv/bin/python /opt/jabuti/page/crawl.py";

const reads =
  (name: string, input: unknown): Script =>
  (_, i) =>
    i === 0 ? { calls: [{ name, input }] } : { text: "ok" };

const results = (h: ReturnType<typeof harness>) =>
  h.events.flatMap((e) => (e.type === "tool.finished" ? [e] : []));

const toolNames = (tools: unknown) => (tools as { name: string }[]).map((t) => t.name);

const reader = agent("reader", {
  tools: ["web_read", "page_structure", "site_crawl"],
  permissions: { shell: "auto" },
});

describe("C20: web pages are read in the agent's sandbox, never in the server", () => {
  it("runs page.py in the agent's own workspace, with none of its variables", async () => {
    const settings = new Settings(openDatabase(":memory:"), randomBytes(32), {});
    settings.saveVariable({
      name: "A_TOKEN",
      value: "synthetic-token",
      scope: ["reader"],
      shell: true,
    });
    for (const [tool, command] of [
      ["web_read", `${PAGE} read 'https://site.example/blog'`],
      ["page_structure", `${PAGE} structure 'https://site.example/blog'`],
      ["site_crawl", `${CRAWL} 'https://site.example/blog' 300`],
    ] as const) {
      const h = harness({
        script: reads(tool, { url: "https://site.example/blog" }),
        agents: [reader],
        settings,
      });
      h.sandbox.next = () => ({ exitCode: 0, output: "Title: Blog\n", timedOut: false });
      await h.turn("read it");
      expect(h.sandbox.commands).toEqual([command]);
      expect(h.sandbox.workspaces).toEqual(["reader"]);
      expect(h.sandbox.envs).toEqual([{}]);
      expect(results(h)[0]).toMatchObject({ content: "Title: Blog", isError: false });
    }
  });

  it("passes the address as one argument, and refuses what is not a web page", async () => {
    const h = harness({
      script: reads("web_read", { url: "https://site.example/a'b;id" }),
      agents: [reader],
    });
    await h.turn("go");
    expect(h.sandbox.commands).toEqual([`${PAGE} read 'https://site.example/a'\\''b;id'`]);

    const crawl = harness({
      script: reads("site_crawl", { url: "https://site.example/", max_pages: 50 }),
      agents: [reader],
    });
    await crawl.turn("go");
    expect(crawl.sandbox.commands).toEqual([`${CRAWL} 'https://site.example/' 50`]);
    const huge = harness({
      script: reads("site_crawl", { url: "https://site.example/", max_pages: "50; id" }),
      agents: [reader],
    });
    await huge.turn("go");
    expect(huge.sandbox.commands).toEqual([]);

    for (const bad of [
      "file:///etc/passwd",
      "ftp://site.example/x",
      "https://user:secret@site.example/",
      "site.example",
    ]) {
      const refused = harness({ script: reads("web_read", { url: bad }), agents: [reader] });
      await refused.turn("go");
      expect(refused.sandbox.commands, bad).toEqual([]);
      expect(results(refused)[0]?.isError, bad).toBe(true);
    }
  });

  it("asks first in ask mode, like any command", async () => {
    const careful = agent("careful", { tools: ["web_read"], permissions: { shell: "ask" } });
    const h = harness({
      script: reads("web_read", { url: "https://site.example/" }),
      agents: [careful],
      approvals: "deny",
    });
    await h.turn("go");
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: "approval.requested",
        action: { kind: "shell", command: `${PAGE} read 'https://site.example/'` },
      }),
    );
    expect(h.sandbox.commands).toEqual([]);
  });

  it("cuts long pages, and says when the sandbox has no page reader", async () => {
    const long = "x".repeat(20_000);
    const h = harness({
      script: reads("web_read", { url: "https://site.example/" }),
      agents: [reader],
    });
    h.sandbox.next = () => ({ exitCode: 0, output: long, timedOut: false });
    await h.turn("go");
    const content = results(h)[0]?.content ?? "";
    expect(content.startsWith("x".repeat(12_000))).toBe(true);
    expect(content).toContain("cut at 12000 of 20000 characters");

    const more = harness({
      script: reads("web_read", { url: "https://site.example/", max_chars: 30_000 }),
      agents: [reader],
    });
    more.sandbox.next = () => ({ exitCode: 0, output: long, timedOut: false });
    await more.turn("go");
    expect(results(more)[0]?.content).toBe(long);

    const old = harness({
      script: reads("page_structure", { url: "https://site.example/" }),
      agents: [reader],
    });
    old.sandbox.next = () => ({
      exitCode: 127,
      output: "sh: 1: /opt/jabuti/venv/bin/python: not found",
      timedOut: false,
    });
    await old.turn("go");
    expect(results(old)[0]).toMatchObject({ isError: true });
    expect(results(old)[0]?.content).toContain("rebuild the runner");

    const failed = harness({
      script: reads("web_read", { url: "https://site.example/" }),
      agents: [reader],
    });
    failed.sandbox.next = () => ({
      exitCode: 2,
      output: "Could not fetch https://site.example/: timed out",
      timedOut: false,
    });
    await failed.turn("go");
    expect(results(failed)[0]).toMatchObject({
      content: "Could not fetch https://site.example/: timed out",
      isError: true,
    });
  });

  it("reads nothing for a subagent whose caller's shell is denied (C12)", async () => {
    const caller = agent("caller", {
      tools: ["delegate"],
      subagents: ["reader"],
      permissions: { shell: "deny" },
    });
    const helper = { ...reader, system: "You read." };
    const script: Script = (request) => {
      const done = request.messages.some((m) => m.parts.some((p) => p.type === "tool_result"));
      if (done) return { text: "ok" };
      return request.system === "You read."
        ? { calls: [{ name: "web_read", input: { url: "https://site.example/" } }] }
        : { calls: [{ name: "delegate", input: { agent: "reader", task: "read" } }] };
    };
    const h = harness({ script, agents: [caller, helper] });
    await h.turn("go");
    expect(h.sandbox.commands).toEqual([]);
  });

  it("is offered only when listed, and only with a sandbox to run in", async () => {
    const tools = async (profile: ReturnType<typeof agent>) => {
      const h = harness({ script: () => ({ text: "ok" }), agents: [profile] });
      await h.turn("hi");
      return toolNames(h.model.requests[0]?.tools);
    };
    expect(await tools(reader)).toEqual(
      expect.arrayContaining(["web_read", "page_structure", "site_crawl"]),
    );
    expect(await tools(agent("a", { tools: ["web_read"] }))).not.toContain("page_structure");
    expect(await tools(agent("b", { tools: ["shell"] }))).not.toContain("web_read");
    expect(
      await tools(
        agent("c", {
          tools: ["web_read", "page_structure", "site_crawl"],
          permissions: { shell: "deny" },
        }),
      ),
    ).toEqual([]);
  });
});
