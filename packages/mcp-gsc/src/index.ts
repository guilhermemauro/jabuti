// MCP server for Google Search Console (stdio), read-only. Jabuti starts one per agent
// that uses it, with that agent's GSC_SERVICE_ACCOUNT (the service account's JSON key)
// in its environment; the key never reaches the model (C5, C16). The token comes from
// a JWT signed here with node:crypto, so no Google library is needed.
//
// Search analytics rows go back as a CSV file, which Jabuti saves in the agent's
// workspace for its shell (C5); the model reads a summary and a few rows.
//
// GSC_API_URL and GSC_TOKEN_URL override Google's endpoints, for tests against a fake.
import { createHash, createSign } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const RAW_KEY = process.env["GSC_SERVICE_ACCOUNT"] ?? "";
const API = process.env["GSC_API_URL"];
const WEBMASTERS = `${API ?? "https://www.googleapis.com"}/webmasters/v3`;
const INSPECTION = `${API ?? "https://searchconsole.googleapis.com"}/v1`;
const TOKEN_URL = process.env["GSC_TOKEN_URL"] ?? "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const TIMEOUT_MS = 60_000;
/** Google's maximum per request; more rows take more requests. */
const PAGE_ROWS = 25_000;
const PREVIEW_ROWS = 10;

const ServiceAccount = z.object({ client_email: z.string(), private_key: z.string() });

class GscError extends Error {}

// --- Auth ---

let cached: { token: string; until: number } | undefined;

function account(): z.infer<typeof ServiceAccount> {
  if (!RAW_KEY) throw new GscError("GSC_SERVICE_ACCOUNT is not set for this agent.");
  let json: unknown;
  try {
    json = JSON.parse(RAW_KEY);
  } catch {
    throw new GscError(
      "GSC_SERVICE_ACCOUNT is not JSON. Paste the whole key file in Settings → Variables.",
    );
  }
  const parsed = ServiceAccount.safeParse(json);
  if (!parsed.success) {
    throw new GscError(
      "GSC_SERVICE_ACCOUNT has no client_email or private_key: use a service account's JSON key.",
    );
  }
  return parsed.data;
}

async function token(): Promise<string> {
  if (cached && Date.now() < cached.until) return cached.token;
  const { client_email, private_key } = account();
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 };
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}`;
  let signature: string;
  try {
    signature = createSign("RSA-SHA256").update(unsigned).sign(private_key, "base64url");
  } catch {
    throw new GscError("The private_key in GSC_SERVICE_ACCOUNT is not a valid key.");
  }
  const res = await request(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!res.ok || !body.access_token) {
    throw new GscError(
      `Google refused the service account (HTTP ${String(res.status)}). Check that the key is ` +
        "current and the Search Console API is enabled in its Google Cloud project.",
    );
  }
  // A minute early, so a token never expires mid-request.
  cached = {
    token: body.access_token,
    until: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000,
  };
  return cached.token;
}

// --- Calls ---

async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new GscError(
      `Google did not answer: ${error instanceof Error ? error.message : "error"}.`,
    );
  }
}

async function call(url: string, site: string, body?: object): Promise<unknown> {
  const res = await request(url, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${await token()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json: unknown = await res.json().catch(() => undefined);
  if (res.ok) return json;
  const detail = (json as { error?: { message?: string } } | undefined)?.error?.message ?? "";
  if (res.status === 401 || res.status === 403) {
    throw new GscError(
      `No access to ${site}: ${detail} Add ${account().client_email} as a user of the ` +
        "property in Search Console → Settings → Users and permissions, or list the sites " +
        "it can read with the sites tool.",
    );
  }
  if (res.status === 429) {
    throw new GscError(
      `Search Console quota exceeded: ${detail} Wait 15 minutes; group by fewer of page and ` +
        "query, or use a shorter period.",
    );
  }
  throw new GscError(`Search Console answered HTTP ${String(res.status)}: ${detail}`);
}

const site = (s: string) => encodeURIComponent(s);

// --- Tools ---

const server = new McpServer({ name: "gsc", version: "0.1.0" });

const Site = z
  .string()
  .min(1)
  .describe(
    "The property, as the sites tool lists it: sc-domain:example.com or https://example.com/.",
  );
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");

server.registerTool(
  "sites",
  {
    description: "The Search Console properties this agent's service account can read.",
    inputSchema: {},
  },
  () =>
    run(async () => {
      const body = (await call(`${WEBMASTERS}/sites`, "the sites list")) as {
        siteEntry?: { siteUrl: string; permissionLevel: string }[];
      };
      const sites = body.siteEntry ?? [];
      if (sites.length === 0) {
        return text(
          `No properties yet. Add ${account().client_email} as a user in Search Console → ` +
            "Settings → Users and permissions.",
        );
      }
      return text(JSON.stringify(sites));
    }),
);

const DIMENSIONS = [
  "date",
  "hour",
  "query",
  "page",
  "country",
  "device",
  "searchAppearance",
] as const;
const FILTER_DIMENSIONS = ["query", "page", "country", "device", "searchAppearance"] as const;

server.registerTool(
  "search_analytics",
  {
    description:
      "Clicks, impressions, CTR and average position from Google Search, grouped by the " +
      "dimensions given. The rows are saved as a CSV file in your workspace (columns: the " +
      "dimensions in order, then clicks, impressions, ctr, position); analyze it with the " +
      "shell. Dates are Pacific Time; final data lags 2 to 3 days. Rows come sorted by " +
      "clicks. Grouping by page and query together over months is the most expensive query " +
      "for the quota: ask for what the analysis needs. Totals without dimensions are exact; " +
      "sums of rows grouped by query are lower, because Google hides rare queries.",
    inputSchema: {
      site: Site,
      startDate: Day.describe("First day, YYYY-MM-DD."),
      endDate: Day.describe("Last day, YYYY-MM-DD, at most 2 to 3 days ago for final data."),
      dimensions: z
        .array(z.enum(DIMENSIONS))
        .default([])
        .describe("Group by these, in order. None: one row of totals."),
      type: z
        .enum(["web", "image", "video", "news", "discover", "googleNews"])
        .default("web")
        .describe("Which results: web (default), image, video, news, discover or googleNews."),
      filters: z
        .array(
          z.object({
            dimension: z.enum(FILTER_DIMENSIONS),
            operator: z
              .enum([
                "equals",
                "notEquals",
                "contains",
                "notContains",
                "includingRegex",
                "excludingRegex",
              ])
              .default("equals"),
            expression: z
              .string()
              .min(1)
              .max(4096)
              .describe(
                "Country as ISO 3166-1 alpha-3 (bra); device as DESKTOP, MOBILE or TABLET; regex in RE2.",
              ),
          }),
        )
        .default([])
        .describe("All must match."),
      dataState: z
        .enum(["final", "all"])
        .default("final")
        .describe("all adds the last days, still incomplete."),
      aggregationType: z
        .enum(["auto", "byPage", "byProperty"])
        .default("auto")
        .describe("How results combine: by property (site) or by page."),
      maxRows: z
        .number()
        .int()
        .min(1)
        .max(200_000)
        .default(25_000)
        .describe("Stop after this many rows; more than 25,000 takes several requests."),
    },
  },
  (input) =>
    run(async () => {
      if (input.startDate > input.endDate) throw new GscError("startDate is after endDate.");
      const query = {
        startDate: input.startDate,
        endDate: input.endDate,
        dimensions: input.dimensions,
        type: input.type,
        dataState: input.dataState,
        aggregationType: input.aggregationType,
        ...(input.filters.length > 0
          ? { dimensionFilterGroups: [{ groupType: "and", filters: input.filters }] }
          : {}),
      };
      const rows: Row[] = [];
      let aggregation = "";
      let incomplete: string | undefined;
      while (rows.length < input.maxRows) {
        const rowLimit = Math.min(PAGE_ROWS, input.maxRows - rows.length);
        const body = (await call(
          `${WEBMASTERS}/sites/${site(input.site)}/searchAnalytics/query`,
          input.site,
          {
            ...query,
            rowLimit,
            startRow: rows.length,
          },
        )) as AnalyticsResponse;
        const page = body.rows ?? [];
        rows.push(...page);
        aggregation = body.responseAggregationType ?? aggregation;
        incomplete ??= body.metadata?.first_incomplete_date;
        if (page.length < rowLimit) break;
      }
      const period = `${input.startDate} to ${input.endDate}`;
      if (rows.length === 0) {
        return text(`No data for ${input.site}, ${period}, with these dimensions and filters.`);
      }
      const columns = [...input.dimensions, "clicks", "impressions", "ctr", "position"];
      const csv = [columns.join(","), ...rows.map((r) => csvRow(r))].join("\n") + "\n";
      const id = createHash("sha256")
        .update(JSON.stringify([input.site, query]))
        .digest("hex");
      const name = [
        input.dimensions.join("-") || "totals",
        input.startDate,
        input.endDate,
        ...(input.type === "web" ? [] : [input.type]),
        id.slice(0, 6),
      ].join("_");
      const clicks = rows.reduce((n, r) => n + r.clicks, 0);
      const impressions = rows.reduce((n, r) => n + r.impressions, 0);
      const summary = [
        `${input.site}, ${period}, ${input.type}${input.dimensions.length > 0 ? `, by ${input.dimensions.join(", ")}` : ""}: ` +
          `${String(rows.length)} rows${rows.length >= input.maxRows ? ` (stopped at maxRows; there may be more)` : ""}.`,
        `Sum of rows: ${String(clicks)} clicks, ${String(impressions)} impressions. Aggregated ${aggregation || "auto"}.`,
        ...(incomplete ? [`Data from ${incomplete} on is incomplete.`] : []),
        `Columns: ${columns.join(", ")}. First ${String(Math.min(PREVIEW_ROWS, rows.length))} rows:`,
        csv
          .split("\n")
          .slice(1, PREVIEW_ROWS + 1)
          .join("\n"),
      ].join("\n");
      return {
        content: [
          { type: "text" as const, text: summary },
          {
            type: "resource" as const,
            resource: {
              uri: `gsc://search-analytics/${name}.csv`,
              mimeType: "text/csv",
              text: csv,
            },
          },
        ],
      };
    }),
);

server.registerTool(
  "inspect_url",
  {
    description:
      "Google's index status of one URL: whether it is indexed, why not, the canonical " +
      "Google chose, last crawl, robots.txt, and rich results. Slow (several seconds) and " +
      "limited to 2,000 a day per property: inspect the pages that matter, not every page.",
    inputSchema: {
      site: Site,
      url: z.url().describe("The full URL, inside the property."),
      languageCode: z
        .string()
        .default("en-US")
        .describe("Language of the explanations, such as pt-BR."),
    },
  },
  ({ site: property, url, languageCode }) =>
    run(async () => {
      const body = (await call(`${INSPECTION}/urlInspection/index:inspect`, property, {
        inspectionUrl: url,
        siteUrl: property,
        languageCode,
      })) as { inspectionResult?: unknown };
      return text(JSON.stringify(body.inspectionResult ?? body));
    }),
);

server.registerTool(
  "sitemaps",
  {
    description:
      "The sitemaps submitted for a property: when Google last read them, errors, warnings " +
      "and URLs submitted.",
    inputSchema: { site: Site },
  },
  ({ site: property }) =>
    run(async () => {
      const body = (await call(`${WEBMASTERS}/sites/${site(property)}/sitemaps`, property)) as {
        sitemap?: unknown[];
      };
      return text(JSON.stringify(body.sitemap ?? []));
    }),
);

// --- Output ---

interface Row {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}
interface AnalyticsResponse {
  rows?: Row[];
  responseAggregationType?: string;
  metadata?: { first_incomplete_date?: string };
}

function csvRow(row: Row): string {
  const values = [
    ...(row.keys ?? []),
    String(row.clicks),
    String(row.impressions),
    row.ctr.toFixed(4),
    row.position.toFixed(2),
  ];
  return values.map(csvCell).join(",");
}

/** RFC 4180: quoted when it holds a comma, quote or line break; quotes doubled. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

async function run<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof GscError)) throw error;
    return { content: [{ type: "text" as const, text: error.message }], isError: true };
  }
}

await server.connect(new StdioServerTransport());
