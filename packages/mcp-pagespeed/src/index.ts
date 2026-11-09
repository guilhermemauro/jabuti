// MCP server for Google PageSpeed Insights (stdio). Jabuti starts one per agent that
// uses it, with that agent's PAGESPEED_API_KEY in its environment; the key never
// reaches the model (C5, C16). Google runs Lighthouse on the page, so the page must
// be public: this server only reads what Google answers.
//
// PAGESPEED_API_URL overrides the endpoint, for tests against a fake.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const KEY = process.env["PAGESPEED_API_KEY"] ?? "";
const API =
  process.env["PAGESPEED_API_URL"] ?? "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
// Lighthouse often takes 20 to 60 seconds on Google's side.
const TIMEOUT_MS = 100_000;
/** The most suggestions listed; they come sorted by what they would save. */
const MAX_SUGGESTIONS = 10;

const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"] as const;

/** Lab metrics, in the order PageSpeed shows them. */
const LAB = [
  ["first-contentful-paint", "First Contentful Paint"],
  ["largest-contentful-paint", "Largest Contentful Paint"],
  ["total-blocking-time", "Total Blocking Time"],
  ["cumulative-layout-shift", "Cumulative Layout Shift"],
  ["speed-index", "Speed Index"],
] as const;

/** Field metrics (Chrome users, 28 days): the API's name, ours, and how to show it. */
const FIELD = [
  ["LARGEST_CONTENTFUL_PAINT_MS", "LCP", "ms"],
  ["INTERACTION_TO_NEXT_PAINT", "INP", "ms"],
  ["CUMULATIVE_LAYOUT_SHIFT_SCORE", "CLS", "cls"],
  ["FIRST_CONTENTFUL_PAINT_MS", "FCP", "ms"],
  ["EXPERIMENTAL_TIME_TO_FIRST_BYTE", "TTFB", "ms"],
] as const;

// Only the fields read below; the rest of Google's large answer is ignored.
const Audit = z.object({
  title: z.string().optional(),
  score: z.number().nullable().optional(),
  scoreDisplayMode: z.string().optional(),
  displayValue: z.string().optional(),
  metricSavings: z.record(z.string(), z.number()).optional(),
  details: z.object({ overallSavingsMs: z.number().optional() }).loose().optional(),
});
const Experience = z.object({
  id: z.string().optional(),
  origin_fallback: z.boolean().optional(),
  overall_category: z.string().optional(),
  metrics: z
    .record(
      z.string(),
      z.object({ percentile: z.number().optional(), category: z.string().optional() }),
    )
    .optional(),
});
const Result = z.object({
  loadingExperience: Experience.optional(),
  originLoadingExperience: Experience.optional(),
  lighthouseResult: z.object({
    finalUrl: z.string().optional(),
    fetchTime: z.string().optional(),
    lighthouseVersion: z.string().optional(),
    runWarnings: z.array(z.string()).optional(),
    runtimeError: z
      .object({ code: z.string().optional(), message: z.string().optional() })
      .optional(),
    categories: z.record(
      z.string(),
      z.object({
        title: z.string().optional(),
        score: z.number().nullable().optional(),
        auditRefs: z.array(z.object({ id: z.string(), group: z.string().optional() })).optional(),
      }),
    ),
    audits: z.record(z.string(), Audit),
  }),
});
type Result = z.infer<typeof Result>;
const ApiError = z.object({ error: z.object({ message: z.string().optional() }) });

const server = new McpServer({ name: "pagespeed", version: "0.1.0" });

server.registerTool(
  "test",
  {
    description:
      "Test a public page with Google PageSpeed Insights: Lighthouse scores, lab metrics " +
      "(LCP, CLS, TBT, FCP, Speed Index), field data from real Chrome users when Google " +
      "has enough of them, and the suggestions that would save the most time. One run, " +
      "mobile by default: lab numbers vary between runs, so compare like with like. " +
      "Takes up to a minute.",
    inputSchema: {
      url: z.url({ protocol: /^https?$/ }).describe("The page's full address, public."),
      strategy: z.enum(["mobile", "desktop"]).default("mobile"),
      categories: z
        .array(z.enum(CATEGORIES))
        .min(1)
        .default(["performance"])
        .describe("Lighthouse categories to score. Performance has the metrics."),
    },
  },
  async ({ url, strategy, categories }) => {
    if (!KEY) return failure("PAGESPEED_API_KEY is not set for this agent.");
    const query = new URLSearchParams({ url, strategy, key: KEY });
    for (const category of categories) query.append("category", category.toUpperCase());
    let res: globalThis.Response;
    try {
      res = await fetch(`${API}?${query.toString()}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      return failure(
        `PageSpeed did not answer in time: ${error instanceof Error ? error.message : "error"}. ` +
          "Try again; slow pages take longer.",
      );
    }
    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      // Google's messages end with a period; ours follow them.
      const message = (
        ApiError.safeParse(body).data?.error.message ?? `HTTP ${String(res.status)}`
      ).replace(/\.+$/, "");
      if (res.status === 403) {
        return failure(
          `Google refused the key: ${message}. Check PAGESPEED_API_KEY in Settings → ` +
            "Variables, and that the PageSpeed Insights API is enabled in its project.",
        );
      }
      if (res.status === 429) return failure(`PageSpeed quota exhausted: ${message}. Try later.`);
      // 400 and 500 carry Lighthouse's reason, such as a page it could not load.
      return failure(`PageSpeed could not test ${url}: ${message}`);
    }
    const parsed = Result.safeParse(body);
    if (!parsed.success)
      return failure("PageSpeed sent a response this server does not understand.");
    return { content: [{ type: "text", text: report(parsed.data, url, strategy) }] };
  },
);

function report(result: Result, url: string, strategy: string): string {
  const lh = result.lighthouseResult;
  const lines = [
    `PageSpeed Insights · ${strategy} · ${lh.finalUrl ?? url}`,
    `Run: ${lh.fetchTime ?? "?"}, Lighthouse ${lh.lighthouseVersion ?? "?"}`,
  ];
  if (lh.runtimeError?.code && lh.runtimeError.code !== "NO_ERROR") {
    lines.push(`Lighthouse error: ${lh.runtimeError.code} ${lh.runtimeError.message ?? ""}`.trim());
  }
  for (const warning of lh.runWarnings ?? []) lines.push(`Warning: ${warning}`);

  const scores = Object.entries(lh.categories).map(
    ([id, c]) => `${c.title ?? id} ${c.score == null ? "?" : String(Math.round(c.score * 100))}`,
  );
  lines.push(`Scores (0-100): ${scores.join(", ")}`);

  const lab = LAB.flatMap(([id, name]) => {
    const audit = lh.audits[id];
    return audit?.displayValue ? [`- ${name}: ${audit.displayValue}${rating(audit.score)}`] : [];
  });
  if (lab.length > 0) lines.push("", "Lab (one simulated run):", ...lab);

  lines.push("", ...field(result));

  const suggestions = suggestionsOf(result);
  if (suggestions.length > 0) {
    lines.push("", "Suggestions, by time saved:", ...suggestions);
  }
  return lines.join("\n");
}

/** The page's own field data, or its origin's when the page has too little traffic. */
function field(result: Result): string[] {
  const page = result.loadingExperience;
  const usable = (e: z.infer<typeof Experience> | undefined) =>
    e?.metrics && Object.keys(e.metrics).length > 0 ? e : undefined;
  const pageData = page?.origin_fallback ? undefined : usable(page);
  const data = pageData ?? usable(result.originLoadingExperience);
  if (!data?.metrics) {
    return ["Field (Chrome users, 28 days): none, too few visits for Google to report."];
  }
  const scope = pageData ? "this page" : "the whole site (this page has too few visits)";
  const lines = [
    `Field (Chrome users, 28 days, ${scope}): ${data.overall_category ?? "?"} overall, 75th percentile:`,
  ];
  for (const [key, name, unit] of FIELD) {
    const metric = data.metrics[key];
    if (metric?.percentile === undefined) continue;
    // The API sends CLS multiplied by 100.
    const value =
      unit === "cls" ? (metric.percentile / 100).toFixed(2) : `${String(metric.percentile)} ms`;
    lines.push(`- ${name}: ${value} (${metric.category ?? "?"})`);
  }
  return lines;
}

/** Failing audits of the performance category that would save time, largest first. */
function suggestionsOf(result: Result): string[] {
  const lh = result.lighthouseResult;
  const metrics = new Set<string>(LAB.map(([id]) => id));
  const refs = lh.categories["performance"]?.auditRefs ?? [];
  const ids = refs.length > 0 ? refs.map((r) => r.id) : Object.keys(lh.audits);
  const found = ids.flatMap((id) => {
    const audit = lh.audits[id];
    if (!audit || metrics.has(id) || audit.score == null || audit.score >= 0.9) return [];
    if (audit.scoreDisplayMode === "informative" || audit.scoreDisplayMode === "notApplicable") {
      return [];
    }
    const savings =
      audit.details?.overallSavingsMs ??
      // CLS savings are a layout-shift score, not time: left out.
      Math.max(0, ...["LCP", "FCP", "TBT"].map((m) => audit.metricSavings?.[m] ?? 0));
    return [{ id, audit, savings }];
  });
  found.sort((a, b) => b.savings - a.savings);
  return found.slice(0, MAX_SUGGESTIONS).map(({ id, audit, savings }) => {
    const value = audit.displayValue ? `: ${audit.displayValue}` : "";
    const saved = savings > 0 ? ` (saves ~${String(Math.round(savings))} ms)` : "";
    return `- ${audit.title ?? id}${value}${saved} [${id}]`;
  });
}

function rating(score: number | null | undefined): string {
  if (score == null) return "";
  return score >= 0.9 ? " (good)" : score >= 0.5 ? " (needs improvement)" : " (poor)";
}

function failure(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

await server.connect(new StdioServerTransport());
