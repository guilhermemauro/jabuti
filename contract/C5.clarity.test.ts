import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../packages/server/src/db/index.ts";
import { CONNECTORS, type ConnectorSpec } from "../packages/server/src/mcp/catalog.ts";
import { Mcp } from "../packages/server/src/mcp/index.ts";
import { Settings } from "../packages/server/src/settings/index.ts";
import type { Script } from "./fake-model/index.ts";
import { agent, harness } from "./harness.ts";

// C5 for the Microsoft Clarity connector, against a fake of the API behind Microsoft's
// Clarity MCP server (POST JSON, Bearer token, 403 for a token it refuses). Synthetic
// site and token.
const TOKEN = "synthetic-clarity-token-0123456789";

const seen: { path: string; body: Record<string, unknown> }[] = [];

const fake = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
  req.on("end", () => {
    const path = new URL(req.url ?? "", "http://fake").pathname;
    seen.push({ path, body: JSON.parse(raw || "{}") as Record<string, unknown> });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const send = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    if (path === "/mcp/dashboard/query") {
      send({
        query: "Top 10 visited URLs over the last 28 days with session count and quickbacks.",
        data: Array.from({ length: 10 }, (_, i) => ({
          VisitedUrl: `https://synthetic.example/page-${String(i)}/`,
          SessionCount: 100 - i,
          TotalQuickbackClicks: i,
          ...(i === 0 ? { Note: 'a, "quoted" value' } : {}),
        })),
        dataErrorType: 0,
      });
    } else if (path === "/mcp/citations/pages") {
      send([
        { pageUrl: "https://synthetic.example/blog/a/", totalCitationCount: 40 },
        { pageUrl: "https://synthetic.example/blog/b/", totalCitationCount: 3 },
      ]);
    } else if (path === "/mcp/citations/overview") {
      send({ pageCitationsCount: 43, shareOfAuthority: { percentage: 12.5 } });
    } else {
      res.writeHead(404).end("not in the fake");
    }
  });
});

let clarity: ConnectorSpec;
beforeAll(async () => {
  await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
  const real = CONNECTORS.find((c) => c.name === "clarity");
  if (!real) throw new Error("clarity connector missing");
  const port = String((fake.address() as AddressInfo).port);
  clarity = { ...real, env: { CLARITY_API_URL: `http://127.0.0.1:${port}/mcp` } };
});
afterAll(() => fake.close());

const clients: Mcp[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((m) => m.close()));
  seen.length = 0;
});

function run(token: string, ...steps: { name: string; input: object }[]) {
  const settings = new Settings(openDatabase(":memory:"), randomBytes(32), {});
  settings.saveVariable({
    name: "CLARITY_API_TOKEN",
    value: token,
    scope: ["site-a"],
    shell: false,
  });
  const mcp = new Mcp([clarity], (a, n) => settings.value(a, n));
  clients.push(mcp);
  const script: Script = (_, i) => {
    const call = steps[i];
    return call ? { calls: [call] } : { text: "done" };
  };
  return harness({
    script,
    agents: [agent("site-a", { mcp: ["clarity"] })],
    mcp,
    connectors: [clarity],
    settings,
  });
}

const results = (h: ReturnType<typeof run>) =>
  h.events.flatMap((e) => (e.type === "tool.finished" ? [e] : []));

describe("C5: the Microsoft Clarity connector", () => {
  it("asks the dashboard with the agent's token, shows Clarity's reading, and saves the rows as CSV", async () => {
    const h = run(TOKEN, {
      name: "mcp__clarity__dashboard",
      input: { question: "Top pages by sessions, last 28 days", timezone: "America/Sao_Paulo" },
    });
    await h.turn("analyze");

    const tools = (h.model.requests[0]?.tools as { name: string }[]).map((t) => t.name).sort();
    expect(tools.filter((t) => t.startsWith("mcp__clarity__"))).toEqual([
      "mcp__clarity__ai_visibility",
      "mcp__clarity__dashboard",
    ]);
    expect(seen).toEqual([
      {
        path: "/mcp/dashboard/query",
        body: { query: "Top pages by sessions, last 28 days", timezone: "America/Sao_Paulo" },
      },
    ]);
    const [file] = h.sandbox.files;
    expect(h.sandbox.files).toHaveLength(1);
    expect(file?.workspace).toBe("site-a");
    expect(file?.path).toMatch(/^mcp\/clarity\/clarity_dashboard_\d{8}-\d{4}_[0-9a-f]{6}\.csv$/);
    const lines = String(file?.content).trimEnd().split("\n");
    expect(lines).toHaveLength(11);
    // Columns in Clarity's order, one that only some rows have included; RFC 4180 quoting.
    expect(lines.slice(0, 3)).toEqual([
      "VisitedUrl,SessionCount,TotalQuickbackClicks,Note",
      'https://synthetic.example/page-0/,100,0,"a, ""quoted"" value"',
      "https://synthetic.example/page-1/,99,1,",
    ]);

    const [result] = results(h);
    expect(result?.isError).toBe(false);
    expect(result?.content).toContain('Clarity read the question as: "Top 10 visited URLs');
    expect(result?.content).toContain("Exactly 10 rows, Clarity's default");
    expect(result?.content).toContain(file?.path);
    expect(JSON.stringify([h.model.requests, h.traces, h.events])).not.toContain(TOKEN);
  });

  it("reads AI Visibility for a period and pages: lists as CSV, an overview as it is", async () => {
    const h = run(
      TOKEN,
      {
        name: "mcp__clarity__ai_visibility",
        input: {
          report: "pages",
          from: "2026-10-01",
          to: "2026-10-28",
          pages: ["/blog/"],
          limit: 50,
        },
      },
      { name: "mcp__clarity__ai_visibility", input: { report: "overview" } },
    );
    await h.turn("analyze");

    expect(seen.map((s) => s.path)).toEqual(["/mcp/citations/pages", "/mcp/citations/overview"]);
    expect(seen[0]?.body).toEqual({
      filters: {
        date: { start: "2026-10-01T00:00:00.000Z", end: "2026-10-28T23:59:59.999Z" },
        queryType: "all",
        citedPages: [{ operator: "Contains", value: "/blog/" }],
      },
      skip: 0,
      limit: 50,
    });
    expect(seen[1]?.body).toEqual({ filters: { queryType: "all" } });
    expect(String(h.sandbox.files[0]?.content).trimEnd().split("\n")).toEqual([
      "pageUrl,totalCitationCount",
      "https://synthetic.example/blog/a/,40",
      "https://synthetic.example/blog/b/,3",
    ]);
    const [pages, overview] = results(h);
    expect(pages?.content).toContain("2026-10-01 to 2026-10-28");
    expect(overview?.content).toContain('"pageCitationsCount": 43');
    expect(h.sandbox.files).toHaveLength(1);
  });

  it("names the next step when Clarity refuses the token, without the token", async () => {
    const h = run("deleted-token", {
      name: "mcp__clarity__dashboard",
      input: { question: "Sessions last 7 days" },
    });
    await h.turn("analyze");
    const [refused] = results(h);
    expect(refused?.isError).toBe(true);
    expect(refused?.content).toContain("Check CLARITY_API_TOKEN");
    expect(refused?.content).not.toContain("deleted-token");
    expect(h.sandbox.files).toHaveLength(0);
  });
});
