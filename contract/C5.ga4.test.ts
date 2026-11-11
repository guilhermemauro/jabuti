import { createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../packages/server/src/db/index.ts";
import { CONNECTORS, type ConnectorSpec } from "../packages/server/src/mcp/catalog.ts";
import { Mcp } from "../packages/server/src/mcp/index.ts";
import { Settings } from "../packages/server/src/settings/index.ts";
import type { Script } from "./fake-model/index.ts";
import { agent, harness } from "./harness.ts";

// C5 for the Google Analytics 4 connector, against a fake Google that checks the signed
// JWT like the real one. The service account and property are synthetic.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const EMAIL = "synthetic@synthetic-project.iam.gserviceaccount.com";
const KEY = JSON.stringify({ type: "service_account", client_email: EMAIL, private_key: PEM });
const TOKEN = "synthetic-access-token";
const PROPERTY = "123456";
/** Rows the fake has for each report. */
const ROWS = 5;

const seen: { path: string; body: Record<string, unknown> }[] = [];
const claims: Record<string, unknown>[] = [];

const fake = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
  req.on("end", () => {
    const path = req.url ?? "";
    const send = (status: number, body: object) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "/token") {
      const jwt = new URLSearchParams(raw).get("assertion") ?? "";
      const [header = "", payload = "", signature = ""] = jwt.split(".");
      const valid = createVerify("RSA-SHA256")
        .update(`${header}.${payload}`)
        .verify(publicKey, signature, "base64url");
      if (!valid) {
        send(400, { error: "invalid_grant" });
        return;
      }
      claims.push(JSON.parse(Buffer.from(payload, "base64url").toString()) as never);
      send(200, { access_token: TOKEN, expires_in: 3600 });
      return;
    }
    const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
    seen.push({ path, body });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      send(401, { error: {} });
      return;
    }
    if (path.startsWith("/v1beta/accountSummaries")) {
      send(200, {
        accountSummaries: [
          {
            displayName: "Synthetic account",
            propertySummaries: [
              { property: `properties/${PROPERTY}`, displayName: "Synthetic site" },
            ],
          },
        ],
      });
      return;
    }
    if (!path.startsWith(`/v1beta/properties/${PROPERTY}`)) {
      send(403, { error: { message: "User does not have sufficient permissions." } });
      return;
    }
    if (path.endsWith(":runReport")) {
      const offset = Number(body["offset"]);
      const count = Math.max(0, Math.min(Number(body["limit"]), ROWS - offset));
      const rows = Array.from({ length: count }, (_, i) => ({
        dimensionValues: [
          { value: i + offset === 0 ? "/blog/a, b" : `/blog/post-${String(i + offset)}` },
          { value: (i + offset) % 2 === 0 ? "range0" : "range1" },
        ],
        metricValues: [{ value: "10" }, { value: "199.9" }],
      }));
      send(200, {
        dimensionHeaders: [{ name: "landingPage" }, { name: "dateRange" }],
        metricHeaders: [
          { name: "sessions", type: "TYPE_INTEGER" },
          { name: "purchaseRevenue", type: "TYPE_CURRENCY" },
        ],
        rows,
        rowCount: ROWS,
        totals: [
          {
            dimensionValues: [{ value: "RESERVED_TOTAL" }, { value: "range0" }],
            metricValues: [{ value: "30" }, { value: "599.7" }],
          },
        ],
        metadata: {
          currencyCode: "BRL",
          timeZone: "America/Sao_Paulo",
          subjectToThresholding: true,
        },
      });
      return;
    }
    send(404, { error: { message: "not in the fake" } });
  });
});

let ga4: ConnectorSpec;
beforeAll(async () => {
  await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${String((fake.address() as AddressInfo).port)}`;
  const real = CONNECTORS.find((c) => c.name === "ga4");
  if (!real) throw new Error("ga4 connector missing");
  ga4 = {
    ...real,
    env: {
      GA4_ADMIN_URL: url,
      GA4_DATA_URL: url,
      GA4_TOKEN_URL: `${url}/token`,
      GA4_PAGE_ROWS: "2",
    },
  };
});
afterAll(() => fake.close());

const clients: Mcp[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((m) => m.close()));
  seen.length = 0;
  claims.length = 0;
});

function run(...steps: { name: string; input: object }[]) {
  const settings = new Settings(openDatabase(":memory:"), randomBytes(32), {});
  settings.saveVariable({
    name: "GA4_SERVICE_ACCOUNT",
    value: KEY,
    scope: ["site-a"],
    shell: false,
  });
  const mcp = new Mcp([ga4], (a, n) => settings.value(a, n));
  clients.push(mcp);
  const script: Script = (_, i) => {
    const call = steps[i];
    return call ? { calls: [call] } : { text: "done" };
  };
  return harness({
    script,
    agents: [agent("site-a", { mcp: ["ga4"] })],
    mcp,
    connectors: [ga4],
    settings,
  });
}

const results = (h: ReturnType<typeof run>) =>
  h.events.flatMap((e) => (e.type === "tool.finished" ? [e] : []));

describe("C5: the Google Analytics 4 connector", () => {
  it("runs any report read-only with the agent's service account and saves every row as a CSV file", async () => {
    const h = run(
      { name: "mcp__ga4__properties", input: {} },
      {
        name: "mcp__ga4__report",
        input: {
          property: `properties/${PROPERTY}`,
          dimensions: ["landingPage"],
          metrics: ["sessions", "purchaseRevenue"],
          date_ranges: [
            { start: "2026-08-01", end: "2026-10-29" },
            { start: "2026-05-03", end: "2026-07-31" },
          ],
          filter: {
            conditions: [
              { field: "landingPage", op: "begins_with", value: "/blog/" },
              { field: "sessionSourceMedium", op: "contains", value: "organic" },
              { field: "purchaseRevenue", op: ">", value: 0 },
            ],
          },
        },
      },
    );
    await h.turn("sales by blog post");

    expect(claims[0]).toMatchObject({
      iss: EMAIL,
      scope: "https://www.googleapis.com/auth/analytics.readonly",
    });
    const [properties, report] = results(h);
    expect(properties?.content).toContain(`"id":"${PROPERTY}"`);

    // Dimension conditions go to dimensionFilter, metric ones to metricFilter.
    const query = seen.find((s) => s.path.endsWith(":runReport"))?.body;
    expect(query).toMatchObject({
      dimensionFilter: {
        andGroup: {
          expressions: [
            {
              filter: {
                fieldName: "landingPage",
                stringFilter: { matchType: "BEGINS_WITH", value: "/blog/" },
              },
            },
            {
              filter: { fieldName: "sessionSourceMedium", stringFilter: { matchType: "CONTAINS" } },
            },
          ],
        },
      },
      metricFilter: {
        filter: {
          fieldName: "purchaseRevenue",
          numericFilter: { operation: "GREATER_THAN", value: { int64Value: "0" } },
        },
      },
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    });
    // Pages of 2 here: every row arrives.
    const reports = seen.filter((s) => s.path.endsWith(":runReport"));
    expect(reports.map((s) => [s.body["offset"], s.body["limit"]])).toEqual([
      [0, 2],
      [2, 2],
      [4, 2],
    ]);

    const [file] = h.sandbox.files;
    expect(h.sandbox.files).toHaveLength(1);
    expect(file?.path).toMatch(/^mcp\/ga4\/landingPage_2026-08-01_2026-10-29_[0-9a-f]{6}\.csv$/);
    const lines = String(file?.content ?? "")
      .trimEnd()
      .split("\n");
    expect(lines).toHaveLength(ROWS + 1);
    expect(lines[0]).toBe("landingPage,dateRange,sessions,purchaseRevenue");
    // Periods by their dates, not Google's range0.
    expect(lines[1]).toBe('"/blog/a, b",2026-08-01 to 2026-10-29,10,199.9');
    expect(lines[2]).toBe("/blog/post-1,2026-05-03 to 2026-07-31,10,199.9");

    // The model reads totals, warnings and a few rows; never the key.
    expect(report?.isError).toBe(false);
    expect(report?.content).toContain("5 of 5 rows");
    expect(report?.content).toContain("Totals: 2026-08-01 to 2026-10-29: sessions 30");
    expect(report?.content).toContain("Thresholding applied");
    expect(report?.content).toContain("Currency BRL");
    expect(report?.content).toContain(file?.path);
    const visible = JSON.stringify([h.model.requests, h.traces, h.events]);
    expect(visible).not.toContain("PRIVATE KEY");
    expect(visible).not.toContain(TOKEN);
  });

  it("says how to give access when the property is not shared with the service account", async () => {
    const h = run({
      name: "mcp__ga4__report",
      input: { property: "999", metrics: ["sessions"] },
    });
    await h.turn("analyze");
    const [result] = results(h);
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain(`add ${EMAIL} as a Viewer`);
    expect(h.sandbox.files).toHaveLength(0);
  });

  it("offers only reading tools", async () => {
    const h = run();
    await h.turn("hi");
    const names = (h.model.requests[0]?.tools as { name: string }[]).map((t) => t.name);
    expect(names.filter((n) => n.startsWith("mcp__ga4__")).sort()).toEqual([
      "mcp__ga4__metadata",
      "mcp__ga4__properties",
      "mcp__ga4__report",
    ]);
  });
});
