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

// C5 for the Bing Webmaster Tools connector, against a fake Bing answering in its JSON
// format ({"d": ...}, "/Date(ms-0700)/" dates, errors as HTTP 400). The key is synthetic.
const KEY = "synthetic-bing-key-0123456789";
const SITE = "https://synthetic.example/";

const seen: URL[] = [];
const date = (day: string) => `/Date(${String(Date.parse(`${day}T07:00:00Z`))}-0700)/`;

const fake = createServer((req, res) => {
  const url = new URL(req.url ?? "", "http://fake");
  seen.push(url);
  const send = (status: number, body: object) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  if (url.searchParams.get("apikey") !== KEY) {
    send(400, { ErrorCode: 3, Message: "InvalidApiKey" });
    return;
  }
  const method = url.pathname.split("/").at(-1);
  if (method === "GetUserSites") {
    send(200, {
      d: [{ __type: "Site:#Microsoft.Bing.Webmaster.Api", Url: SITE, IsVerified: true }],
    });
    return;
  }
  if (url.searchParams.get("siteUrl") !== SITE) {
    send(400, { ErrorCode: 14, Message: "NotAuthorized" });
    return;
  }
  if (method === "GetQueryStats") {
    const row = (day: string, query: string, clicks: number) => ({
      __type: "QueryStats:#Microsoft.Bing.Webmaster.Api",
      Date: date(day),
      Query: query,
      Clicks: clicks,
      Impressions: clicks * 10,
      AvgClickPosition: 3,
      AvgImpressionPosition: 4.5,
    });
    send(200, {
      d: [
        row("2026-09-01", "old query", 99),
        row("2026-10-06", "query a", 2),
        row("2026-10-13", 'synthetic, "quoted" query', 7),
      ],
    });
    return;
  }
  if (method === "GetQueryPageStats") send(200, { d: [] });
  else send(404, { Message: "not in the fake" });
});

let bing: ConnectorSpec;
beforeAll(async () => {
  await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
  const real = CONNECTORS.find((c) => c.name === "bing");
  if (!real) throw new Error("bing connector missing");
  const port = String((fake.address() as AddressInfo).port);
  bing = { ...real, env: { BING_API_URL: `http://127.0.0.1:${port}/webmaster/api.svc/json` } };
});
afterAll(() => fake.close());

const clients: Mcp[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((m) => m.close()));
  seen.length = 0;
});

function run(key: string, ...steps: { name: string; input: object }[]) {
  const settings = new Settings(openDatabase(":memory:"), randomBytes(32), {});
  settings.saveVariable({
    name: "BING_WEBMASTER_API_KEY",
    value: key,
    scope: ["site-a"],
    shell: false,
  });
  const mcp = new Mcp([bing], (a, n) => settings.value(a, n));
  clients.push(mcp);
  const script: Script = (_, i) => {
    const call = steps[i];
    return call ? { calls: [call] } : { text: "done" };
  };
  return harness({
    script,
    agents: [agent("site-a", { mcp: ["bing"] })],
    mcp,
    connectors: [bing],
    settings,
  });
}

const results = (h: ReturnType<typeof run>) =>
  h.events.flatMap((e) => (e.type === "tool.finished" ? [e] : []));

describe("C5: the Bing Webmaster Tools connector", () => {
  it("reads with the agent's key and saves the rows in the period as a CSV file", async () => {
    const h = run(KEY, {
      name: "mcp__bing__search_performance",
      input: { site: SITE, report: "queries", startDate: "2026-10-01" },
    });
    await h.turn("analyze");

    expect(seen.map((u) => [u.pathname.split("/").at(-1), u.searchParams.get("siteUrl")])).toEqual([
      ["GetQueryStats", SITE],
    ]);
    const [file] = h.sandbox.files;
    expect(h.sandbox.files).toHaveLength(1);
    expect(file?.workspace).toBe("site-a");
    expect(file?.path).toMatch(/^mcp\/bing\/queries_2026-10-06_2026-10-13_[0-9a-f]{6}\.csv$/);
    // Bing's dates become days; rows before startDate are trimmed; the most clicks first.
    expect(String(file?.content).trimEnd().split("\n")).toEqual([
      "date,query,clicks,impressions,avg_click_position,avg_impression_position",
      '2026-10-13,"synthetic, ""quoted"" query",7,70,3,4.5',
      "2026-10-06,query a,2,20,3,4.5",
    ]);

    const [result] = results(h);
    expect(result?.isError).toBe(false);
    expect(result?.content).toContain("2 rows, 2026-10-06 to 2026-10-13");
    expect(result?.content).toContain(file?.path);
    expect(JSON.stringify([h.model.requests, h.traces, h.events])).not.toContain(KEY);
  });

  it("tells the agent that AI Performance has no API and how the owner exports it", async () => {
    const h = run(KEY);
    await h.turn("hi");
    const tools = h.model.requests[0]?.tools as { name: string; description: string }[];
    expect(
      tools
        .filter((t) => t.name.startsWith("mcp__bing__"))
        .map((t) => t.name)
        .sort(),
    ).toEqual([
      "mcp__bing__crawl",
      "mcp__bing__search_performance",
      "mcp__bing__sitemaps",
      "mcp__bing__sites",
      "mcp__bing__url_info",
    ]);
    const performance = tools.find((t) => t.name === "mcp__bing__search_performance");
    expect(performance?.description).toContain("AI Performance report");
    expect(performance?.description).toContain("export it as CSV");
  });

  it("names the next step when Bing refuses the key or the site, without the key", async () => {
    const h = run("wrong-key", { name: "mcp__bing__sites", input: {} });
    await h.turn("list");
    const [refused] = results(h);
    expect(refused?.isError).toBe(true);
    expect(refused?.content).toContain("Check BING_WEBMASTER_API_KEY");
    expect(refused?.content).not.toContain("wrong-key");

    const other = run(KEY, {
      name: "mcp__bing__search_performance",
      input: { site: "https://other.example/", report: "queries" },
    });
    await other.turn("analyze");
    const [denied] = results(other);
    expect(denied?.isError).toBe(true);
    expect(denied?.content).toContain("List the sites it reads with the sites tool");
    expect(other.sandbox.files).toHaveLength(0);
  });
});
