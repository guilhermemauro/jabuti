// MCP server for Bing Webmaster Tools (stdio), read-only. Jabuti starts one per agent
// that uses it, with that agent's BING_WEBMASTER_API_KEY in its environment; the key
// never reaches the model (C5, C16). The key belongs to a Bing user and covers every
// site that user verified.
//
// Rows go back as CSV files, which Jabuti saves in the agent's workspace for its shell
// (C5); the model reads a summary and a few rows.
//
// Bing's AI Performance report (Copilot citations, grounding queries, Topics) has no
// API yet: the tool descriptions tell the agent to ask the owner for its CSV export.
//
// BING_API_URL overrides Bing's endpoint, for tests against a fake.
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const KEY = process.env["BING_WEBMASTER_API_KEY"] ?? "";
const API = process.env["BING_API_URL"] ?? "https://ssl.bing.com/webmaster/api.svc/json";
const TIMEOUT_MS = 60_000;
const PREVIEW_ROWS = 10;

const AI_PERFORMANCE =
  "Bing's AI Performance report (citations of the site in Copilot and Bing AI answers, " +
  "cited pages, grounding queries, intents, citation share, Topics Portfolio) has no " +
  "API yet. Ask the owner to export it as CSV in Bing Webmaster Tools → AI Performance " +
  "(Citations & Pages: list by Grounding Queries or by Pages, then Download; Topics " +
  "Portfolio when shown) and attach the files to the conversation.";

class BingError extends Error {}

// --- Calls ---

/** Bing's JSON dates: "/Date(1316156400000-0700)/", milliseconds since the epoch in UTC. */
const BingDate = z.string().transform((value, ctx) => {
  const ms = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value)?.[1];
  if (ms === undefined) {
    ctx.addIssue({ code: "custom", message: `Not a Bing date: ${value}` });
    return z.NEVER;
  }
  // Bing's days start at midnight Pacific, 07:00 or 08:00 UTC: the UTC date is the day.
  return new Date(Number(ms)).toISOString().slice(0, 10);
});
const Num = z.number().default(0);

const Envelope = z.object({ d: z.unknown() });
const ApiError = z.object({ ErrorCode: z.number().optional(), Message: z.string().optional() });

async function call<T>(
  method: string,
  params: Record<string, string>,
  schema: z.ZodType<T>,
): Promise<T> {
  if (!KEY) throw new BingError("BING_WEBMASTER_API_KEY is not set for this agent.");
  const query = new URLSearchParams({ ...params, apikey: KEY });
  let res: globalThis.Response;
  try {
    res = await fetch(`${API}/${method}?${query.toString()}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // The error may carry the URL, and the URL carries the key: not quoted.
    throw new BingError("Bing Webmaster Tools did not answer in time. Try again in a minute.");
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const error = ApiError.safeParse(body).data;
    const reason = error?.Message ?? `HTTP ${String(res.status)}`;
    if (/InvalidApiKey/i.test(reason) || res.status === 401) {
      throw new BingError(
        `Bing refused the key (${reason}). Check BING_WEBMASTER_API_KEY in Settings → ` +
          "Variables: Bing Webmaster Tools → Settings → API access shows the current one.",
      );
    }
    // Bing documents only InvalidApiKey; these names come from its ApiErrorCode enum.
    if (/NotAuthorized|NotFound/i.test(reason) && params["siteUrl"]) {
      throw new BingError(
        `Bing has no access to ${params["siteUrl"]} for this key (${reason}). List the ` +
          "sites it reads with the sites tool; the site must be verified by the key's user.",
      );
    }
    if (/Throttl|Quota/i.test(reason) || res.status === 429) {
      throw new BingError(`Bing's quota is exhausted (${reason}). Wait and try again later.`);
    }
    throw new BingError(`Bing Webmaster Tools answered ${reason}.`);
  }
  const parsed = Envelope.safeParse(body);
  const data = parsed.success ? schema.safeParse(parsed.data.d) : undefined;
  if (!data?.success) {
    throw new BingError(`Bing sent a ${method} response this server does not understand.`);
  }
  return data.data;
}

/** A query, page or url parameter: Bing's JSON samples send them as JSON strings. */
const quoted = (value: string) => JSON.stringify(value);

// --- Tools ---

const server = new McpServer({ name: "bing", version: "0.1.0" });

const Site = z
  .string()
  .min(1)
  .describe("The site as the sites tool lists it, such as https://example.com/.");
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

server.registerTool(
  "sites",
  {
    description:
      "The sites in Bing Webmaster Tools that this agent's key reads, and whether each is " +
      `verified. ${AI_PERFORMANCE}`,
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  () =>
    run(async () => {
      const sites = await call(
        "GetUserSites",
        {},
        z.array(z.object({ Url: z.string(), IsVerified: z.boolean().optional() })),
      );
      if (sites.length === 0) {
        return text("No sites. Add and verify one in Bing Webmaster Tools first.");
      }
      return text(
        JSON.stringify(sites.map((s) => ({ site: s.Url, verified: s.IsVerified ?? false }))),
      );
    }),
);

const QueryStats = z.array(
  z.object({
    Date: BingDate,
    Query: z.string(),
    Clicks: Num,
    Impressions: Num,
    AvgClickPosition: Num,
    AvgImpressionPosition: Num,
  }),
);
const Traffic = z.array(z.object({ Date: BingDate, Clicks: Num, Impressions: Num }));
const Detail = z.array(z.object({ Date: BingDate, Clicks: Num, Impressions: Num, Position: Num }));

const REPORTS = {
  queries: "top queries, weekly rows",
  pages: "top pages, weekly rows",
  page_queries: "the queries of one page (page), weekly rows",
  query_pages: "the pages of one query (query), weekly rows",
  query_page: "one query on one page (query and page), weekly rows",
  daily: "the whole site per day, all verticals (web, chat, news, images, videos)",
  query_daily: "one top query (query) per day",
} as const;
type Report = keyof typeof REPORTS;

interface Table {
  columns: string[];
  rows: { date: string; values: (string | number)[]; clicks: number; impressions: number }[];
}

async function table(report: Report, site: string, query?: string, page?: string) {
  const need = (value: string | undefined, name: string) => {
    if (!value) throw new BingError(`The ${report} report needs ${name}.`);
    return quoted(value);
  };
  const siteUrl = site;
  if (report === "daily" || report === "query_daily") {
    const rows =
      report === "daily"
        ? await call("GetRankAndTrafficStats", { siteUrl }, Traffic)
        : await call("GetQueryTrafficStats", { siteUrl, query: need(query, "query") }, Traffic);
    return {
      columns: ["date", "clicks", "impressions"],
      rows: rows.map((r) => ({
        date: r.Date,
        values: [r.Date, r.Clicks, r.Impressions],
        ...lc(r),
      })),
    } satisfies Table;
  }
  if (report === "query_page") {
    const rows = await call(
      "GetQueryPageDetailStats",
      { siteUrl, query: need(query, "query"), page: need(page, "page") },
      Detail,
    );
    return {
      columns: ["date", "clicks", "impressions", "position"],
      rows: rows.map((r) => ({
        date: r.Date,
        values: [r.Date, r.Clicks, r.Impressions, r.Position],
        ...lc(r),
      })),
    } satisfies Table;
  }
  const [method, params, key] =
    report === "queries"
      ? (["GetQueryStats", { siteUrl }, "query"] as const)
      : report === "pages"
        ? (["GetPageStats", { siteUrl }, "page"] as const)
        : report === "page_queries"
          ? (["GetPageQueryStats", { siteUrl, page: need(page, "page") }, "query"] as const)
          : (["GetQueryPageStats", { siteUrl, query: need(query, "query") }, "page"] as const);
  const rows = await call(method, params, QueryStats);
  return {
    columns: [
      "date",
      key,
      "clicks",
      "impressions",
      "avg_click_position",
      "avg_impression_position",
    ],
    rows: rows.map((r) => ({
      date: r.Date,
      values: [
        r.Date,
        r.Query,
        r.Clicks,
        r.Impressions,
        r.AvgClickPosition,
        r.AvgImpressionPosition,
      ],
      ...lc(r),
    })),
  } satisfies Table;
}

const lc = (r: { Clicks: number; Impressions: number }) => ({
  clicks: r.Clicks,
  impressions: r.Impressions,
});

server.registerTool(
  "search_performance",
  {
    description:
      "Clicks, impressions and position of the site in Bing search, as Bing Webmaster " +
      "Tools shows them. Reports: " +
      Object.entries(REPORTS)
        .map(([k, v]) => `${k} (${v})`)
        .join("; ") +
      ". Bing returns its whole history (about six months) and has no date parameter: " +
      "startDate and endDate only trim the rows. Weekly reports are updated once a week, " +
      "daily ones every day. The rows are saved as a CSV file in your workspace (the " +
      "summary names its columns); analyze it with the shell. " +
      AI_PERFORMANCE,
    inputSchema: {
      site: Site,
      report: z.enum(Object.keys(REPORTS) as [Report, ...Report[]]),
      query: z.string().min(1).max(1000).optional().describe("The query, for query reports."),
      page: z.url().optional().describe("The page's full URL, for page reports."),
      startDate: Day.optional().describe("Keep rows from this day on, YYYY-MM-DD."),
      endDate: Day.optional().describe("Keep rows up to this day, YYYY-MM-DD."),
    },
    annotations: { readOnlyHint: true },
  },
  (input) =>
    run(async () => {
      if (input.startDate && input.endDate && input.startDate > input.endDate) {
        throw new BingError("startDate is after endDate.");
      }
      const all = await table(input.report, input.site, input.query, input.page);
      const rows = all.rows.filter(
        (r) =>
          (!input.startDate || r.date >= input.startDate) &&
          (!input.endDate || r.date <= input.endDate),
      );
      const subject = [input.query, input.page].filter(Boolean).join(" on ");
      const label = `${input.site}, ${input.report}${subject ? ` (${subject})` : ""}`;
      if (rows.length === 0) {
        return text(
          all.rows.length === 0
            ? `No data for ${label}: Bing has none yet, or the query or page is not among its top ones.`
            : `No rows for ${label} between ${input.startDate ?? "the start"} and ${input.endDate ?? "today"}; Bing has ${String(all.rows.length)} rows outside that period.`,
        );
      }
      const dates = rows.map((r) => r.date).sort();
      const daily = input.report === "daily" || input.report === "query_daily";
      // Weekly reports read best by clicks; daily ones in date order.
      const ordered = daily
        ? [...rows].sort((a, b) => a.date.localeCompare(b.date))
        : [...rows].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
      const csv =
        [all.columns.join(","), ...ordered.map((r) => r.values.map(cell).join(","))].join("\n") +
        "\n";
      const id = createHash("sha256")
        .update(JSON.stringify([input.site, input.report, input.query, input.page]))
        .digest("hex");
      const name = [input.report, dates[0], dates.at(-1), id.slice(0, 6)].join("_");
      const clicks = rows.reduce((n, r) => n + r.clicks, 0);
      const impressions = rows.reduce((n, r) => n + r.impressions, 0);
      const summary = [
        `${label}: ${String(rows.length)} rows, ${dates[0] ?? ""} to ${dates.at(-1) ?? ""}.`,
        `Sum of rows: ${String(clicks)} clicks, ${String(impressions)} impressions.`,
        `Columns: ${all.columns.join(", ")}. ${daily ? "First" : "Top"} ${String(Math.min(PREVIEW_ROWS, rows.length))} rows${daily ? "" : " by clicks"}:`,
        csv
          .split("\n")
          .slice(1, PREVIEW_ROWS + 1)
          .join("\n"),
      ].join("\n");
      return file(summary, `bing://search-performance/${name}.csv`, csv);
    }),
);

const UrlInfo = z.object({
  Url: z.string().optional(),
  HttpStatus: z.number().optional(),
  IsPage: z.boolean().optional(),
  DiscoveryDate: BingDate.optional(),
  LastCrawledDate: BingDate.optional(),
  DocumentSize: z.number().optional(),
  AnchorCount: z.number().optional(),
  TotalChildUrlCount: z.number().optional(),
});
const UrlTraffic = z.object({ Clicks: Num, Impressions: Num });

server.registerTool(
  "url_info",
  {
    description:
      "What Bing knows of one URL of the site: when it found and last crawled it, the " +
      "HTTP status it got, size, links pointing to it, and its clicks and impressions. " +
      "Use domain:example.com for the whole domain.",
    inputSchema: {
      site: Site,
      url: z.string().min(1).max(2048).describe("A full URL in the site, or domain:example.com."),
    },
    annotations: { readOnlyHint: true },
  },
  ({ site, url }) =>
    run(async () => {
      const params = { siteUrl: site, url: quoted(url) };
      const [info, traffic] = await Promise.all([
        call("GetUrlInfo", params, UrlInfo),
        call("GetUrlTrafficInfo", params, UrlTraffic),
      ]);
      return text(
        JSON.stringify({
          url: info.Url ?? url,
          httpStatus: info.HttpStatus,
          isPage: info.IsPage,
          discovered: info.DiscoveryDate,
          lastCrawled: info.LastCrawledDate,
          sizeBytes: info.DocumentSize,
          inboundLinks: info.AnchorCount,
          childUrls: info.TotalChildUrlCount,
          clicks: traffic.Clicks,
          impressions: traffic.Impressions,
        }),
      );
    }),
);

const CRAWL_STATS = [
  ["CrawledPages", "crawled_pages"],
  ["InIndex", "in_index"],
  ["CrawlErrors", "crawl_errors"],
  ["Code2xx", "code_2xx"],
  ["Code301", "code_301"],
  ["Code302", "code_302"],
  ["Code4xx", "code_4xx"],
  ["Code5xx", "code_5xx"],
  ["AllOtherCodes", "other_codes"],
  ["BlockedByRobotsTxt", "blocked_by_robots_txt"],
  ["ConnectionTimeout", "connection_timeout"],
  ["DnsFailures", "dns_failures"],
  ["ContainsMalware", "contains_malware"],
  ["InLinks", "inbound_links"],
] as const;
const CrawlStats = z.array(
  z
    .object({ Date: BingDate })
    .extend(Object.fromEntries(CRAWL_STATS.map(([k]) => [k, Num])) as Record<string, typeof Num>),
);
const CrawlIssues = z.array(
  z.object({
    Url: z.string(),
    HttpCode: z.number().optional(),
    Issues: z.union([z.string(), z.number()]).optional(),
    InLinks: z.number().optional(),
  }),
);

server.registerTool(
  "crawl",
  {
    description:
      "How Bingbot crawls the site, as a CSV file in your workspace. stats: per day for " +
      "the last six months, pages crawled and in the index, HTTP codes, robots.txt blocks, " +
      "timeouts, DNS failures. issues: the URLs with crawl problems; fixed ones may take " +
      "days to leave the list.",
    inputSchema: { site: Site, report: z.enum(["stats", "issues"]) },
    annotations: { readOnlyHint: true },
  },
  ({ site, report }) =>
    run(async () => {
      const id = createHash("sha256").update(site).digest("hex").slice(0, 6);
      if (report === "stats") {
        const rows = (await call("GetCrawlStats", { siteUrl: site }, CrawlStats)).sort((a, b) =>
          String(a["Date"]).localeCompare(String(b["Date"])),
        );
        if (rows.length === 0) return text(`No crawl statistics for ${site} yet.`);
        const columns = ["date", ...CRAWL_STATS.map(([, c]) => c)];
        const csv = [
          columns.join(","),
          ...rows.map((r) =>
            [String(r["Date"]), ...CRAWL_STATS.map(([k]) => String(r[k] ?? 0))].join(","),
          ),
        ].join("\n");
        const last = csv.split("\n").at(-1) ?? "";
        return file(
          `${site}, crawl stats: ${String(rows.length)} days. Columns: ${columns.join(", ")}. Last day:\n${last}`,
          `bing://crawl/stats_${id}.csv`,
          csv + "\n",
        );
      }
      const rows = await call("GetCrawlIssues", { siteUrl: site }, CrawlIssues);
      if (rows.length === 0) return text(`Bing lists no crawl issues for ${site}.`);
      const columns = ["url", "http_code", "issues", "inbound_links"];
      const csv = [
        columns.join(","),
        ...rows.map((r) =>
          [r.Url, String(r.HttpCode ?? ""), String(r.Issues ?? ""), String(r.InLinks ?? "")]
            .map(cell)
            .join(","),
        ),
      ].join("\n");
      return file(
        `${site}, crawl issues: ${String(rows.length)} URLs. Columns: ${columns.join(", ")}. First ${String(Math.min(PREVIEW_ROWS, rows.length))}:\n` +
          csv
            .split("\n")
            .slice(1, PREVIEW_ROWS + 1)
            .join("\n"),
        `bing://crawl/issues_${id}.csv`,
        csv + "\n",
      );
    }),
);

server.registerTool(
  "sitemaps",
  {
    description:
      "The sitemaps and feeds submitted to Bing for the site: status, URLs found, when " +
      "Bing last read them.",
    inputSchema: { site: Site },
    annotations: { readOnlyHint: true },
  },
  ({ site }) =>
    run(async () => {
      const feeds = await call(
        "GetFeeds",
        { siteUrl: site },
        z.array(
          z.object({
            Url: z.string(),
            Type: z.string().optional(),
            Status: z.string().optional(),
            UrlCount: z.number().optional(),
            Submitted: BingDate.optional(),
            LastCrawled: BingDate.optional(),
          }),
        ),
      );
      return text(
        feeds.length === 0
          ? `No sitemaps submitted to Bing for ${site}.`
          : JSON.stringify(
              feeds.map((f) => ({
                url: f.Url,
                type: f.Type,
                status: f.Status,
                urls: f.UrlCount,
                submitted: f.Submitted,
                lastRead: f.LastCrawled,
              })),
            ),
      );
    }),
);

// --- Output ---

/** RFC 4180: quoted when it holds a comma, quote or line break; quotes doubled. */
function cell(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function file(summary: string, uri: string, csv: string) {
  return {
    content: [
      { type: "text" as const, text: summary },
      { type: "resource" as const, resource: { uri, mimeType: "text/csv", text: csv } },
    ],
  };
}

async function run<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof BingError)) throw error;
    return { content: [{ type: "text" as const, text: error.message }], isError: true };
  }
}

await server.connect(new StdioServerTransport());
