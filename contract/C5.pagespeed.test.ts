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

// C5 for the PageSpeed Insights connector, against a fake Google. The answer is a
// synthetic, trimmed Lighthouse result in the API's shape.
const KEY = "synthetic-pagespeed-key-c5";
const PAGE = "https://synthetic.example/blog";

const audit = (title: string, score: number | null, displayValue: string, extra = {}) => ({
  title,
  score,
  scoreDisplayMode: "numeric",
  displayValue,
  ...extra,
});

const ANSWER = {
  loadingExperience: {
    id: PAGE,
    origin_fallback: true,
    metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 9999, category: "SLOW" } },
  },
  originLoadingExperience: {
    id: "https://synthetic.example",
    overall_category: "AVERAGE",
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2600, category: "AVERAGE" },
      INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: "FAST" },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 12, category: "AVERAGE" },
    },
  },
  lighthouseResult: {
    finalUrl: PAGE,
    fetchTime: "2026-11-05T12:00:00.000Z",
    lighthouseVersion: "12.0.0",
    runWarnings: [],
    categories: {
      performance: {
        title: "Performance",
        score: 0.72,
        auditRefs: [
          { id: "largest-contentful-paint" },
          { id: "cumulative-layout-shift" },
          { id: "render-blocking-resources" },
          { id: "unused-javascript" },
          { id: "uses-long-cache-ttl" },
          { id: "font-display" },
          { id: "diagnostics-only" },
        ],
      },
      seo: { title: "SEO", score: 1 },
    },
    audits: {
      "largest-contentful-paint": audit("Largest Contentful Paint", 0.4, "4.1 s"),
      "cumulative-layout-shift": audit("Cumulative Layout Shift", 0.95, "0.02"),
      "render-blocking-resources": audit("Eliminate render-blocking resources", 0.3, "", {
        details: { type: "opportunity", overallSavingsMs: 450 },
      }),
      "unused-javascript": audit("Reduce unused JavaScript", 0.5, "Est savings of 120 KiB", {
        details: { type: "opportunity", overallSavingsMs: 900 },
      }),
      // Its savings are a layout-shift score, not time: listed, but last.
      "font-display": audit("Ensure text remains visible", 0.5, "", {
        metricSavings: { CLS: 0.3 },
      }),
      // Passing: not a suggestion.
      "uses-long-cache-ttl": audit("Serve static assets with a long cache", 0.95, ""),
      "diagnostics-only": { title: "Main-thread work", score: 0, scoreDisplayMode: "informative" },
    },
  },
};

const seen: URL[] = [];
let respond: (url: URL) => { status: number; body: object } = () => ({ status: 200, body: ANSWER });
const fake = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fake");
  seen.push(url);
  const { status, body } = respond(url);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});

let pagespeed: ConnectorSpec;
beforeAll(async () => {
  await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
  const real = CONNECTORS.find((c) => c.name === "pagespeed");
  if (!real) throw new Error("pagespeed connector missing");
  const port = String((fake.address() as AddressInfo).port);
  pagespeed = { ...real, env: { PAGESPEED_API_URL: `http://127.0.0.1:${port}/runPagespeed` } };
});
afterAll(() => fake.close());

const clients: Mcp[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((m) => m.close()));
  seen.length = 0;
  respond = () => ({ status: 200, body: ANSWER });
});

function run(input: object, profile = agent("site-a", { mcp: ["pagespeed"] })) {
  const settings = new Settings(openDatabase(":memory:"), randomBytes(32), {});
  settings.saveVariable({ name: "PAGESPEED_API_KEY", value: KEY, scope: ["site-a"], shell: false });
  const mcp = new Mcp([pagespeed], (a, n) => settings.value(a, n));
  clients.push(mcp);
  const script: Script = (_, i) =>
    i === 0 ? { calls: [{ name: "mcp__pagespeed__test", input }] } : { text: "done" };
  return harness({ script, agents: [profile], mcp, connectors: [pagespeed], settings });
}

const result = (h: ReturnType<typeof run>) =>
  h.events.flatMap((e) => (e.type === "tool.finished" ? [e] : []))[0];

describe("C5: the PageSpeed Insights connector", () => {
  it("tests with the agent's key and reports scores, metrics and suggestions, never the key", async () => {
    const h = run({ url: PAGE, categories: ["performance", "seo"] });
    await h.turn("how fast is it?");

    const query = seen[0]?.searchParams;
    expect(query?.get("url")).toBe(PAGE);
    expect(query?.get("strategy")).toBe("mobile");
    expect(query?.get("key")).toBe(KEY);
    expect(query?.getAll("category")).toEqual(["PERFORMANCE", "SEO"]);

    const text = result(h)?.content ?? "";
    expect(result(h)?.isError).toBe(false);
    expect(text).toContain("Scores (0-100): Performance 72, SEO 100");
    expect(text).toContain("- Largest Contentful Paint: 4.1 s (poor)");
    expect(text).toContain("- Cumulative Layout Shift: 0.02 (good)");
    // The page has too few visits: the whole site's field data, CLS divided by 100.
    expect(text).toContain("the whole site");
    expect(text).toContain("- LCP: 2600 ms (AVERAGE)");
    expect(text).toContain("- CLS: 0.12 (AVERAGE)");
    expect(text).not.toContain("9999");
    // Largest saving first; passing and informative audits left out.
    const suggestions = text.slice(text.indexOf("Suggestions"));
    expect(suggestions.indexOf("unused-javascript")).toBeLessThan(
      suggestions.indexOf("render-blocking-resources"),
    );
    expect(suggestions.indexOf("render-blocking-resources")).toBeLessThan(
      suggestions.indexOf("font-display"),
    );
    expect(suggestions).toContain("(saves ~900 ms)");
    expect(suggestions).toContain("- Ensure text remains visible [font-display]");
    expect(suggestions).not.toContain("uses-long-cache-ttl");
    expect(suggestions).not.toContain("diagnostics-only");

    expect(JSON.stringify(h.model.requests)).not.toContain(KEY);
  });

  it("says when there is no field data, and tests desktop when asked", async () => {
    respond = () => ({
      status: 200,
      body: { ...ANSWER, loadingExperience: {}, originLoadingExperience: {} },
    });
    const h = run({ url: PAGE, strategy: "desktop" });
    await h.turn("go");
    expect(seen[0]?.searchParams.get("strategy")).toBe("desktop");
    expect(seen[0]?.searchParams.getAll("category")).toEqual(["PERFORMANCE"]);
    expect(result(h)?.content).toContain("none, too few visits");
  });

  it("explains a refused key and a page Lighthouse could not load", async () => {
    respond = () => ({ status: 403, body: { error: { message: "API key not valid." } } });
    const refused = run({ url: PAGE });
    await refused.turn("go");
    expect(result(refused)).toMatchObject({ isError: true });
    expect(result(refused)?.content).toContain("PageSpeed Insights API is enabled");

    respond = () => ({
      status: 400,
      body: { error: { message: "Lighthouse returned error: FAILED_DOCUMENT_REQUEST." } },
    });
    const failed = run({ url: PAGE });
    await failed.turn("go");
    expect(result(failed)).toMatchObject({ isError: true });
    expect(result(failed)?.content).toMatch(/FAILED_DOCUMENT_REQUEST$/);
  });

  it("refuses an address that is not a web page, before calling Google", async () => {
    const h = run({ url: "file:///etc/passwd" });
    await h.turn("go");
    expect(seen).toEqual([]);
    expect(result(h)?.isError).toBe(true);
  });
});
