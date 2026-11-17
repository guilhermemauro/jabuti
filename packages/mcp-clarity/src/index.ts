// MCP server for Microsoft Clarity (stdio), read-only. Jabuti starts one per agent that
// uses it, with that agent's CLARITY_API_TOKEN in its environment; the token never
// reaches the model (C5, C16). A token is a project's Data Export token and reads only
// that project.
//
// It calls the API behind Microsoft's own Clarity MCP server (clarity.microsoft.com/mcp),
// not the Data Export endpoint: that one answers only for the last 3 days, 10 requests a
// day, while this one reads months back and adds AI Visibility (where AI answers cite the
// site). Microsoft's server is not run here: it is third-party code, and its sign-in
// needs a browser on the same machine and an OS keychain. Its README deprecates the token
// in favour of that sign-in; the API still takes it (2026-11-16). If it stops, the token
// error below says so, and the way forward is an OAuth sign-in made by Jabuti.
//
// The dashboard takes a question in plain language, which Clarity turns into a query
// itself: its reading of the question comes back and is shown first, since columns and
// row counts follow it. Rows go back as CSV files, which Jabuti saves in the agent's
// workspace for its shell (C5).
//
// Bot Activity (AI crawlers) is left out: it needs the site's CDN logs connected to
// Clarity, and without them every number is zero.
//
// CLARITY_API_URL overrides the endpoint, for tests against a fake.
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const TOKEN = process.env["CLARITY_API_TOKEN"] ?? "";
const API = process.env["CLARITY_API_URL"] ?? "https://clarity.microsoft.com/mcp";
const TIMEOUT_MS = 90_000;
const PREVIEW_ROWS = 8;
/** An answer this short is shown whole instead of saved. */
const INLINE_CHARS = 4_000;
/** Clarity's dashboard returns this many rows unless the question asks for more. */
const DEFAULT_ROWS = 10;

class ClarityError extends Error {}

async function call(path: string, body: object): Promise<unknown> {
  if (!TOKEN) throw new ClarityError("CLARITY_API_TOKEN is not set for this agent.");
  let res: globalThis.Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ClarityError("Clarity did not answer in time. Try again in a minute.");
  }
  if (res.status === 401 || res.status === 403) {
    throw new ClarityError(
      `Clarity refused the token (HTTP ${String(res.status)}). Check CLARITY_API_TOKEN in ` +
        "Settings → Variables: a project admin generates one in Clarity → Settings → Data " +
        "Export, and a deleted token stops working at once. If a new token is refused too, " +
        "Clarity may have ended token access to this API: tell the owner.",
    );
  }
  if (res.status === 429) {
    throw new ClarityError("Clarity is limiting requests for this project. Try again later.");
  }
  if (!res.ok) {
    // The body is Clarity's, not ours: only a short, plain excerpt is quoted.
    const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    throw new ClarityError(
      `Clarity answered HTTP ${String(res.status)}${detail ? `: ${detail}` : ""}.`,
    );
  }
  const answer: unknown = await res.json().catch(() => undefined);
  if (answer === undefined) throw new ClarityError("Clarity sent a response that is not JSON.");
  return answer;
}

// --- Tools ---

const server = new McpServer({ name: "clarity", version: "0.1.0" });

const Row = z.record(z.string(), z.unknown());
const Dashboard = z.object({
  query: z.string().optional(),
  data: z.array(Row).nullable().optional(),
  dataErrorType: z.number().optional(),
});

server.registerTool(
  "dashboard",
  {
    description:
      "Microsoft Clarity's dashboard, for the project of this agent's token: what visitors " +
      "do on the site (sessions, users, pages, scroll depth, engagement time, quickbacks, " +
      "dead and rage clicks, script errors, devices, sources, countries…), months back. " +
      'Ask one plain-language question with an explicit period, such as "daily sessions, ' +
      "average scroll depth and quickback clicks for https://example.com/page/ from " +
      '2026-10-01 to 2026-10-28, all rows". Clarity turns it into a query itself and ' +
      'returns 10 rows unless asked for more ("top 100", "all rows"). The rows go to a ' +
      "CSV file; the summary starts with how Clarity read the question: check it before " +
      "using the numbers.",
    inputSchema: {
      question: z.string().min(10).max(1_000),
      timezone: z
        .string()
        .min(1)
        .default("UTC")
        .describe("IANA time zone for days and periods, such as America/Sao_Paulo."),
    },
    annotations: { readOnlyHint: true },
  },
  ({ question, timezone }) =>
    run(async () => {
      const parsed = Dashboard.safeParse(
        await call("/dashboard/query", { query: question, timezone }),
      );
      if (!parsed.success)
        throw new ClarityError("Clarity sent a dashboard answer this server does not understand.");
      const { query: reading, data, dataErrorType } = parsed.data;
      const rows = data ?? [];
      const head = reading
        ? `Clarity read the question as: "${reading}"`
        : "Clarity sent no reading of the question.";
      if (rows.length === 0) {
        const why = dataErrorType ? ` (Clarity's error type ${String(dataErrorType)})` : "";
        return text(
          `${head}\nNo rows${why}. Ask one simpler question, with an explicit period and the ` +
            "metrics named; or the period has no sessions.",
        );
      }
      const notes = [
        rows.length === DEFAULT_ROWS
          ? `Exactly ${String(DEFAULT_ROWS)} rows, Clarity's default: there may be more. Ask for "all rows" or "top N" if you need them.`
          : "",
      ];
      return table(head, notes, rows, `clarity_dashboard_${stamp()}_${hash(question)}.csv`);
    }),
);

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const REPORTS = {
  overview: "/citations/overview",
  pages: "/citations/pages",
  queries: "/citations/queries",
  topics: "/citations/topics",
  citations_trend: "/citations/trends/metrics",
  share_trend: "/citations/trends/metrics",
  page_trend: "/citations/trends/items",
  query_trend: "/citations/trends/items",
} as const;
type Report = keyof typeof REPORTS;

server.registerTool(
  "ai_visibility",
  {
    description:
      "Where AI answers (Copilot, ChatGPT, Perplexity, Gemini…) cite the site, from " +
      "Microsoft Clarity's AI Visibility, for the project of this agent's token. Reports: " +
      "overview (citations, share of authority against other cited sites, branded and " +
      "non-branded shares, AI-referred traffic, data freshness); pages, queries and topics " +
      "(the most cited, as a CSV file); citations_trend and share_trend (the project over " +
      "time); page_trend and query_trend (up to 5 exact pages or queries from those lists, " +
      "over time). The period defaults to the last 7 days.",
    inputSchema: {
      report: z.enum(Object.keys(REPORTS) as [Report, ...Report[]]),
      from: Day.optional(),
      to: Day.optional(),
      query_type: z.enum(["all", "branded", "nonbranded"]).default("all"),
      pages: z
        .array(z.string().min(1))
        .max(20)
        .optional()
        .describe("Only cited pages whose URL contains one of these."),
      queries: z
        .array(z.string().min(1))
        .max(20)
        .optional()
        .describe("Only AI queries containing one of these."),
      topic: z.string().min(1).optional().describe("Only this exact query topic."),
      values: z
        .array(z.string().min(1))
        .min(1)
        .max(5)
        .optional()
        .describe("For page_trend and query_trend: exact URLs or queries the lists returned."),
      limit: z.number().int().min(1).max(100).default(100).describe("Rows for the lists."),
    },
    annotations: { readOnlyHint: true },
  },
  (input) =>
    run(async () => {
      if ((input.from === undefined) !== (input.to === undefined)) {
        throw new ClarityError("Give both from and to, or neither for the last 7 days.");
      }
      const trendOfItems = input.report === "page_trend" || input.report === "query_trend";
      if (trendOfItems && !input.values) {
        throw new ClarityError(
          `${input.report} needs values: exact ${input.report === "page_trend" ? "URLs from the pages" : "queries from the queries"} report.`,
        );
      }
      const filters = {
        ...(input.from && input.to
          ? { date: { start: `${input.from}T00:00:00.000Z`, end: `${input.to}T23:59:59.999Z` } }
          : {}),
        queryType: input.query_type,
        ...(input.pages
          ? { citedPages: input.pages.map((value) => ({ operator: "Contains", value })) }
          : {}),
        ...(input.queries
          ? { queries: input.queries.map((value) => ({ operator: "Contains", value })) }
          : {}),
        ...(input.topic ? { queryTopic: input.topic } : {}),
      };
      const body: Record<string, unknown> = { filters };
      if (["pages", "queries", "topics"].includes(input.report)) {
        body["skip"] = 0;
        body["limit"] = input.limit;
      }
      if (input.report === "citations_trend") body["dimension"] = "citations";
      if (input.report === "share_trend") body["dimension"] = "shareOfAuthority";
      if (trendOfItems) {
        body["dimension"] = input.report === "page_trend" ? "page" : "query";
        body["values"] = input.values;
      }
      const answer = await call(REPORTS[input.report], body);
      const period = input.from ? `${input.from} to ${input.to ?? ""}` : "the last 7 days";
      const head = `AI Visibility, ${input.report.replace("_", " ")}, ${period}.`;
      const rows = z.array(Row).safeParse(answer);
      if (rows.success) {
        if (rows.data.length === 0)
          return text(`${head}\nNo rows: no citations matched in that period.`);
        return table(head, [], rows.data, `clarity_ai-${input.report}_${stamp()}.csv`);
      }
      // An overview or a trend: an object, small enough to read as it is, else saved.
      const json = JSON.stringify(answer, null, 1);
      if (json.length <= INLINE_CHARS) return text(`${head}\n${json}`);
      return file(
        `${head}\nSaved as JSON: ${String(json.length)} characters.`,
        `clarity://ai/clarity_ai-${input.report}_${stamp()}.json`,
        json,
        "application/json",
      );
    }),
);

// --- Helpers ---

/** Rows as a CSV file: columns in the order Clarity sent them, nested values as JSON. */
function table(head: string, notes: string[], rows: Record<string, unknown>[], name: string) {
  const columns: string[] = [];
  for (const row of rows)
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  const line = (row: Record<string, unknown>) => columns.map((c) => cell(row[c])).join(",");
  const csv = `${[columns.map(cell).join(","), ...rows.map(line)].join("\n")}\n`;
  const preview = [columns.map(cell).join(","), ...rows.slice(0, PREVIEW_ROWS).map(line)];
  const summary = [
    head,
    `${String(rows.length)} rows.`,
    ...notes.filter(Boolean),
    `First rows:\n${preview.join("\n")}`,
  ].join("\n");
  return file(summary, `clarity://${name}`, csv, "text/csv");
}

/** RFC 4180: quoted when it holds a comma, quote or line break; quotes doubled. */
function cell(value: unknown): string {
  const s =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : value === null || value === undefined
          ? ""
          : JSON.stringify(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** The time of a call, for file names: two calls the same day keep both files. */
function stamp(): string {
  return new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 6);
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function file(summary: string, uri: string, content: string, mimeType: string) {
  return {
    content: [
      { type: "text" as const, text: summary },
      { type: "resource" as const, resource: { uri, mimeType, text: content } },
    ],
  };
}

async function run<T>(work: () => Promise<T>) {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof ClarityError)) throw error;
    return { content: [{ type: "text" as const, text: error.message }], isError: true };
  }
}

await server.connect(new StdioServerTransport());
