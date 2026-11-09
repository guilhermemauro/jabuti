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

// C5 for the Search Console connector, against a fake Google that checks the signed
// JWT like the real one. The service account is synthetic, generated per run.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const EMAIL = "synthetic@synthetic-project.iam.gserviceaccount.com";
const KEY = JSON.stringify({ type: "service_account", client_email: EMAIL, private_key: PEM });
const TOKEN = "synthetic-access-token";
const SITE = "sc-domain:synthetic.example";

const seen: { path: string; body: Record<string, unknown>; auth?: string }[] = [];
const claims: Record<string, unknown>[] = [];
/** Rows the fake has for SITE, by query then page. */
const ROWS = 25_003;

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
    seen.push({
      path,
      body,
      ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
    });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      send(401, { error: {} });
      return;
    }
    if (!path.includes(encodeURIComponent(SITE)) && !path.startsWith("/v1/")) {
      send(403, { error: { message: "User does not have sufficient permission." } });
      return;
    }
    if (path.endsWith("/searchAnalytics/query")) {
      const start = Number(body["startRow"]);
      const count = Math.max(0, Math.min(Number(body["rowLimit"]), ROWS - start));
      const rows = Array.from({ length: count }, (_, i) => ({
        keys: [
          i + start === 0 ? 'synthetic, "quoted" query' : `query ${String(i + start)}`,
          "https://synthetic.example/",
        ],
        clicks: 1,
        impressions: 10,
        ctr: 0.1,
        position: 4.25,
      }));
      send(200, { rows, responseAggregationType: "byPage" });
      return;
    }
    send(404, { error: { message: "not in the fake" } });
  });
});

let gsc: ConnectorSpec;
beforeAll(async () => {
  await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${String((fake.address() as AddressInfo).port)}`;
  const real = CONNECTORS.find((c) => c.name === "gsc");
  if (!real) throw new Error("gsc connector missing");
  gsc = { ...real, env: { GSC_API_URL: url, GSC_TOKEN_URL: `${url}/token` } };
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
    name: "GSC_SERVICE_ACCOUNT",
    value: KEY,
    scope: ["site-a"],
    shell: false,
  });
  const mcp = new Mcp([gsc], (a, n) => settings.value(a, n));
  clients.push(mcp);
  const script: Script = (_, i) => {
    const call = steps[i];
    return call ? { calls: [call] } : { text: "done" };
  };
  return harness({
    script,
    agents: [agent("site-a", { mcp: ["gsc"] })],
    mcp,
    connectors: [gsc],
    settings,
  });
}

const results = (h: ReturnType<typeof run>) =>
  h.events.flatMap((e) => (e.type === "tool.finished" ? [e] : []));

describe("C5: the Search Console connector", () => {
  it("signs in read-only with the agent's service account and saves every row as a CSV file", async () => {
    const h = run({
      name: "mcp__gsc__search_analytics",
      input: {
        site: SITE,
        startDate: "2026-01-01",
        endDate: "2026-01-28",
        dimensions: ["query", "page"],
        maxRows: 30_000,
      },
    });
    await h.turn("analyze");

    expect(claims).toEqual([
      expect.objectContaining({
        iss: EMAIL,
        scope: "https://www.googleapis.com/auth/webmasters.readonly",
      }),
    ]);
    // Two pages: Google returns at most 25,000 rows per request.
    expect(seen.map((s) => [s.body["startRow"], s.body["rowLimit"]])).toEqual([
      [0, 25_000],
      [25_000, 5_000],
    ]);
    const [file] = h.sandbox.files;
    expect(h.sandbox.files).toHaveLength(1);
    expect(file?.workspace).toBe("site-a");
    expect(file?.path).toMatch(/^mcp\/gsc\/query-page_2026-01-01_2026-01-28_[0-9a-f]{6}\.csv$/);
    const lines = String(file?.content ?? "")
      .trimEnd()
      .split("\n");
    expect(lines).toHaveLength(ROWS + 1);
    expect(lines[0]).toBe("query,page,clicks,impressions,ctr,position");
    expect(lines[1]).toBe(
      '"synthetic, ""quoted"" query",https://synthetic.example/,1,10,0.1000,4.25',
    );

    // The model reads a summary and a few rows, never the whole file, nor the key.
    const [result] = results(h);
    expect(result?.isError).toBe(false);
    expect(result?.content).toContain(`${String(ROWS)} rows`);
    expect(result?.content).toContain(file?.path);
    expect(result?.content).not.toContain("query 500");
    const visible = JSON.stringify([h.model.requests, h.traces, h.events]);
    expect(visible).not.toContain("PRIVATE KEY");
    expect(visible).not.toContain(TOKEN);
  });

  it("says how to give access when the property is not shared with the service account", async () => {
    const h = run({
      name: "mcp__gsc__search_analytics",
      input: { site: "sc-domain:other.example", startDate: "2026-01-01", endDate: "2026-01-02" },
    });
    await h.turn("analyze");
    const [result] = results(h);
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain(`Add ${EMAIL} as a user`);
    expect(h.sandbox.files).toHaveLength(0);
  });

  it("offers only reading tools", async () => {
    const h = run();
    await h.turn("hi");
    const names = (h.model.requests[0]?.tools as { name: string }[]).map((t) => t.name);
    expect(names.filter((n) => n.startsWith("mcp__gsc__")).sort()).toEqual([
      "mcp__gsc__inspect_url",
      "mcp__gsc__search_analytics",
      "mcp__gsc__sitemaps",
      "mcp__gsc__sites",
    ]);
  });
});
