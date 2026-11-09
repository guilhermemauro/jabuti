import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../packages/server/src/db/index.ts";
import { CONNECTORS, type ConnectorSpec } from "../packages/server/src/mcp/catalog.ts";
import { Mcp } from "../packages/server/src/mcp/index.ts";
import { Settings } from "../packages/server/src/settings/index.ts";
import type { Script } from "./fake-model/index.ts";
import { agent, harness } from "./harness.ts";

// Synthetic key; a fake Serper records what reaches it.
const KEY = "synthetic-serper-key-c5";
const seen: { path: string; headers: IncomingHttpHeaders; body: unknown }[] = [];
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk.toString()));
  req.on("end", () => {
    seen.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(body) as unknown });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        searchParameters: { q: "synthetic query", engine: "google" },
        organic: [{ position: 1, title: "Synthetic result", link: "https://synthetic.example" }],
        // Blocks the connector does not parse, in no particular shape: listed anyway.
        videos: Array.from({ length: 8 }, (_, i) => ({
          title: `Synthetic video ${String(i)}`,
          link: `https://video.example/${String(i)}`,
          channel: "Synthetic channel",
          imageUrl: "https://video.example/thumb.jpg",
        })),
        syntheticAiBlock: {
          text: "A synthetic summary.",
          references: [{ title: "Cited", link: "https://cited.example/page" }],
        },
        emptyBlock: [],
        credits: 1,
      }),
    );
  });
});
let serper: ConnectorSpec;
const flaky: ConnectorSpec = {
  name: "flaky",
  description: "Test connector.",
  variables: [],
  command: process.execPath,
  args: [join(import.meta.dirname, "fixtures/crashing-mcp.ts")],
};
const broken: ConnectorSpec = { ...flaky, name: "broken", args: ["-e", "process.exit(3)"] };

beforeAll(async () => {
  await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
  const { port } = fake.address() as AddressInfo;
  const real = CONNECTORS.find((c) => c.name === "serper");
  if (!real) throw new Error("serper connector missing");
  serper = { ...real, env: { SERPER_API_URL: `http://127.0.0.1:${String(port)}` } };
});
afterAll(() => fake.close());

const clients: Mcp[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((m) => m.close()));
  seen.length = 0;
});

function setup(scope: string[] = ["site-a"]) {
  const settings = new Settings(openDatabase(":memory:"), randomBytes(32), {});
  settings.saveVariable({ name: "SERPER_API_KEY", value: KEY, scope, shell: false });
  const catalog = [serper, flaky, broken];
  const mcp = new Mcp(catalog, (a, n) => settings.value(a, n));
  clients.push(mcp);
  return { settings, mcp, connectors: catalog };
}

const calls =
  (...steps: { name: string; input: object }[]): Script =>
  (_, i) => {
    const call = steps[i];
    return call ? { calls: [call] } : { text: "done" };
  };
const search = { name: "mcp__serper__search", input: { q: "synthetic query", gl: "br" } };
const toolNames = (tools: unknown) => (tools as { name: string }[]).map((t) => t.name);

describe("C5: MCP tools are namespaced, and a failing connector never stops the agent", () => {
  it("exposes a connector's tools as mcp__<server>__<tool>, only to agents that list it", async () => {
    const { mcp, connectors, settings } = setup();
    const site = agent("site-a", { mcp: ["serper"] });
    const h = harness({ script: calls(search), agents: [site], mcp, connectors, settings });
    await h.turn("rank?");

    expect(toolNames(h.model.requests[0]?.tools)).toContain("mcp__serper__search");
    const result = h.events.find((e) => e.type === "tool.finished");
    expect(result?.type === "tool.finished" && result.content).toContain("Synthetic result");
    // Every block on the page is named, and the unknown ones summarized, short.
    const answer = JSON.parse(result?.type === "tool.finished" ? result.content : "{}") as {
      sections: string[];
      other: Record<string, unknown>;
    };
    expect(answer.sections).toEqual(["organic", "videos", "syntheticAiBlock", "emptyBlock"]);
    expect(answer.other["videos"]).toHaveLength(5);
    expect((answer.other["videos"] as unknown[])[0]).toEqual({
      title: "Synthetic video 0",
      link: "https://video.example/0",
      channel: "Synthetic channel",
    });
    expect(answer.other["syntheticAiBlock"]).toEqual({
      fields: ["text", "references"],
      links: ["https://cited.example/page"],
    });
    expect(answer.other).not.toHaveProperty("emptyBlock");
    expect(answer.other).not.toHaveProperty("searchParameters");
    expect(seen).toEqual([
      expect.objectContaining({ path: "/search", body: { q: "synthetic query", gl: "br" } }),
    ]);
    expect(seen[0]?.headers["x-api-key"]).toBe(KEY);

    const other = harness({ script: calls(), agents: [agent("site-a")], mcp, connectors });
    await other.turn("hi");
    expect(toolNames(other.model.requests[0]?.tools)).not.toContain("mcp__serper__search");
  });

  it("keeps the connector's key out of the model, the trace and the UI (C16)", async () => {
    const { mcp, connectors, settings } = setup();
    const site = agent("site-a", { mcp: ["serper"] });
    const h = harness({ script: calls(search), agents: [site], mcp, connectors, settings });
    await h.turn("rank?");
    expect(seen).toHaveLength(1);
    const visible = JSON.stringify([h.model.requests, h.traces, h.events, h.history()]);
    expect(visible).not.toContain(KEY);
  });

  it("gives a connector none of the server's environment (C16)", async () => {
    process.env["JABUTI_C5_SERVER_SECRET"] = "synthetic-server-secret";
    try {
      const { mcp, connectors, settings } = setup();
      const site = agent("site-a", { mcp: ["flaky"] });
      const h = harness({
        script: calls({ name: "mcp__flaky__env", input: {} }),
        agents: [site],
        mcp,
        connectors,
        settings,
      });
      await h.turn("env?");
      const result = h.events.find((e) => e.type === "tool.finished");
      expect(result?.type === "tool.finished" && result.content).toContain("PATH");
      const content = result?.type === "tool.finished" ? result.content : "";
      expect(content).not.toContain("synthetic-server-secret");
      // Nor another connector's key, though site-a has it in scope.
      expect(content).not.toContain(KEY);
    } finally {
      delete process.env["JABUTI_C5_SERVER_SECRET"];
    }
  });

  it("starts nothing for an agent outside the key's scope, and says what to do", async () => {
    const { mcp, connectors, settings } = setup(["site-a"]);
    const outsider = agent("site-b", { mcp: ["serper"] });
    const h = harness({ script: calls(), agents: [outsider], mcp, connectors, settings });
    const end = await h.turn("rank?");
    expect(end.reason).toBe("done");
    expect(toolNames(h.model.requests[0]?.tools)).not.toContain("mcp__serper__search");
    const notice = h.events.find((e) => e.type === "notice");
    expect(notice?.type === "notice" && notice.problem.nextStep).toContain("Settings → Variables");
    expect(seen).toEqual([]);
  });

  it("drops a connector that fails to start; the agent keeps its other tools", async () => {
    const { mcp, connectors } = setup();
    const site = agent("site-a", { mcp: ["broken", "flaky"] });
    const h = harness({ script: calls(), agents: [site], mcp, connectors });
    const end = await h.turn("hi");
    expect(end.reason).toBe("done");
    const names = toolNames(h.model.requests[0]?.tools);
    expect(names).toContain("shell");
    expect(names).toContain("mcp__flaky__ping");
    expect(names.some((n) => n.startsWith("mcp__broken__"))).toBe(false);
    expect(h.events.some((e) => e.type === "notice")).toBe(true);
  });

  it("turns a crash mid-call into one tool result, and restarts on the next turn", async () => {
    const { mcp, connectors } = setup();
    const site = agent("site-a", { mcp: ["flaky"] });
    const script: Script = (request, i) => {
      const last = request.messages.at(-1);
      const text = last?.parts.find((p) => p.type === "text");
      if (text?.type === "text" && text.text === "crash" && i === 0) {
        return { calls: [{ name: "mcp__flaky__crash", input: {} }] };
      }
      if (text?.type === "text" && text.text === "ping") {
        return { calls: [{ name: "mcp__flaky__ping", input: {} }] };
      }
      return { text: "done" };
    };
    const h = harness({ script, agents: [site], mcp, connectors });
    await h.turn("crash");
    const crashed = h.events.filter((e) => e.type === "tool.finished");
    expect(crashed).toHaveLength(1);
    expect(crashed[0]?.isError).toBe(true);
    expect(crashed[0]?.content).toMatch(/restarts on the next message/);

    await h.turn("ping");
    const results = h.events.filter((e) => e.type === "tool.finished");
    expect(results.at(-1)?.content).toBe("pong");
  });

  it("saves a file it returns in the agent's workspace, under a plain name, and gives the model the path", async () => {
    const { mcp, connectors } = setup();
    const site = agent("site-a", { mcp: ["flaky"] });
    const h = harness({
      script: calls({ name: "mcp__flaky__file", input: {} }),
      agents: [site],
      mcp,
      connectors,
    });
    await h.turn("get the file");
    expect(h.sandbox.files).toEqual([
      { workspace: "site-a", path: "mcp/flaky/Weird-name-rm--rf.csv", content: "a,b\n1,2\n" },
    ]);
    const result = h.events.find((e) => e.type === "tool.finished");
    expect(result?.isError).toBe(false);
    expect(result?.content).toContain("Here is the file.");
    expect(result?.content).toContain("Saved mcp/flaky/Weird-name-rm--rf.csv");
    expect(result?.content).toContain("2 lines");
    expect(result?.content).not.toContain("1,2");
  });

  it("uses a replaced key from the next turn on, without a restart (C16)", async () => {
    const { mcp, connectors, settings } = setup();
    const site = agent("site-a", { mcp: ["serper"] });
    // A search for each user message; a tool result also arrives as a user message.
    const script: Script = (request) =>
      request.messages.at(-1)?.parts.some((p) => p.type === "text")
        ? { calls: [search] }
        : { text: "done" };
    const h = harness({ script, agents: [site], mcp, connectors, settings });
    await h.turn("one");
    const id = settings.variablesFor("site-a").find((v) => v.name === "SERPER_API_KEY")?.id;
    settings.saveVariable({
      ...(id ? { id } : {}),
      name: "SERPER_API_KEY",
      value: "synthetic-replaced-key",
      scope: ["site-a"],
      shell: false,
    });
    expect(settings.value("site-a", "SERPER_API_KEY")).toBe("synthetic-replaced-key");
    await h.turn("two");
    expect(seen.map((s) => s.headers["x-api-key"])).toEqual([KEY, "synthetic-replaced-key"]);
  });
});
