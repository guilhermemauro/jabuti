// MCP server for Google Analytics 4 (stdio), read-only. Jabuti starts one per agent that
// uses it, with that agent's GA4_SERVICE_ACCOUNT (the service account's JSON key) in its
// environment; the key never reaches the model (C5, C16).
//
// Flexible by design: no fixed reports. `properties` finds the property, `metadata` lists
// every dimension and metric it has (custom events, key events and custom dimensions
// included), and `report` runs the Data API's runReport with any of them, filters and
// several periods. Rows go back as a CSV file, which Jabuti saves in the agent's
// workspace for its shell (C5); the model reads a summary, totals and a few rows.
//
// GA4_ADMIN_URL, GA4_DATA_URL and GA4_TOKEN_URL override Google's endpoints, for tests
// against a fake, and GA4_PAGE_ROWS the rows per request.
import { createHash } from "node:crypto";
import { GoogleError, ServiceAccountAuth } from "@jabuti/google-auth";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const ADMIN = `${process.env["GA4_ADMIN_URL"] ?? "https://analyticsadmin.googleapis.com"}/v1beta`;
const DATA = `${process.env["GA4_DATA_URL"] ?? "https://analyticsdata.googleapis.com"}/v1beta`;
/** Google's maximum per request; more rows take more requests. GA4_PAGE_ROWS: tests. */
const PAGE_ROWS = Number(process.env["GA4_PAGE_ROWS"] ?? 100_000);
const PREVIEW_ROWS = 10;

const auth = new ServiceAccountAuth({
  variable: "GA4_SERVICE_ACCOUNT",
  raw: process.env["GA4_SERVICE_ACCOUNT"] ?? "",
  scope: "https://www.googleapis.com/auth/analytics.readonly",
  tokenUrl: process.env["GA4_TOKEN_URL"] ?? "https://oauth2.googleapis.com/token",
  api: "the Google Analytics Data API (and the Admin API, for properties)",
  timeoutMs: 60_000,
});

// --- Calls ---

async function call(url: string, what: string, body?: object): Promise<unknown> {
  const res = await auth.request(url, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${await auth.token()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json: unknown = await res.json().catch(() => undefined);
  if (res.ok) return json;
  const detail = (json as { error?: { message?: string } } | undefined)?.error?.message ?? "";
  if (res.status === 401 || res.status === 403) {
    throw new GoogleError(
      `No access to ${what}: ${detail} If the API is enabled, add ${auth.email()} as a ` +
        "Viewer in Google Analytics → Admin → Property access management, or list the " +
        "properties it can read with the properties tool.",
    );
  }
  if (res.status === 429) {
    throw new GoogleError(
      `Google Analytics quota exceeded: ${detail} Wait an hour; ask for fewer dimensions ` +
        "or a shorter period.",
    );
  }
  // 400: an unknown field or an incompatible mix; Google's message says which.
  throw new GoogleError(`Google Analytics answered HTTP ${String(res.status)}: ${detail}`);
}

/** "123456" or "properties/123456" → "properties/123456". */
function propertyName(property: string): string {
  const id = property.trim().replace(/^properties\//, "");
  if (!/^\d+$/.test(id)) {
    throw new GoogleError(
      `"${property}" is not a property id: use the number the properties tool lists.`,
    );
  }
  return `properties/${id}`;
}

// --- Tools ---

const server = new McpServer({ name: "ga4", version: "0.1.0" });

const Property = z
  .string()
  .min(1)
  .describe("The GA4 property id, as the properties tool lists it: 123456789.");

server.registerTool(
  "properties",
  {
    description: "The Google Analytics 4 properties this agent's service account can read.",
    inputSchema: {},
  },
  () =>
    run(async () => {
      const summaries: AccountSummary[] = [];
      let pageToken = "";
      do {
        const query = new URLSearchParams({ pageSize: "200", ...(pageToken ? { pageToken } : {}) });
        const body = (await call(
          `${ADMIN}/accountSummaries?${query.toString()}`,
          "the accounts",
        )) as {
          accountSummaries?: AccountSummary[];
          nextPageToken?: string;
        };
        summaries.push(...(body.accountSummaries ?? []));
        pageToken = body.nextPageToken ?? "";
      } while (pageToken);
      const properties = summaries.flatMap((a) =>
        (a.propertySummaries ?? []).map((p) => ({
          id: p.property.replace(/^properties\//, ""),
          name: p.displayName,
          account: a.displayName,
        })),
      );
      if (properties.length === 0) {
        return text(
          `No properties yet. Add ${auth.email()} as a Viewer in Google Analytics → Admin → ` +
            "Property access management.",
        );
      }
      return text(JSON.stringify(properties));
    }),
);

server.registerTool(
  "metadata",
  {
    description:
      "The dimensions and metrics a property has, by API name, including its custom " +
      "dimensions, custom metrics and key events (metrics such as keyEvents:purchase). " +
      "Without search: every name, by category. With search: matching ones with their " +
      "descriptions. Use it before report to find the exact names.",
    inputSchema: {
      property: Property,
      search: z
        .string()
        .optional()
        .describe("Words to find in a name or description, such as purchase, landing or source."),
    },
  },
  ({ property, search }) =>
    run(async () => {
      const name = propertyName(property);
      const body = (await call(`${DATA}/${name}/metadata`, name)) as {
        dimensions?: Field[];
        metrics?: Field[];
      };
      const fields = [
        ...(body.dimensions ?? []).map((f) => ({ ...f, kind: "dimension" })),
        ...(body.metrics ?? []).map((f) => ({ ...f, kind: "metric" })),
      ];
      const words = (search ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length > 0) {
        const found = fields.filter((f) => {
          const hay = `${f.apiName} ${f.uiName ?? ""} ${f.description ?? ""}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        });
        if (found.length === 0) return text(`Nothing in ${name} matches "${search ?? ""}".`);
        return text(
          found
            .map(
              (f) =>
                `${f.kind} ${f.apiName}${f.type ? ` (${f.type})` : ""}${f.customDefinition ? " custom" : ""}: ` +
                `${f.uiName ?? ""}. ${f.description ?? ""}`.trim(),
            )
            .join("\n"),
        );
      }
      const byCategory = new Map<string, string[]>();
      for (const f of fields) {
        const key = `${f.kind}s · ${f.category ?? "Other"}`;
        byCategory.set(key, [...(byCategory.get(key) ?? []), f.apiName]);
      }
      return text(
        [...byCategory].map(([category, names]) => `${category}: ${names.join(", ")}`).join("\n"),
      );
    }),
);

const DateValue = z
  .string()
  .regex(
    /^(\d{4}-\d{2}-\d{2}|today|yesterday|\d+daysAgo)$/,
    "Use YYYY-MM-DD, today, yesterday or NdaysAgo.",
  );

const Condition = z.object({
  field: z.string().min(1).describe("A dimension or metric API name from the request."),
  op: z
    .enum([
      "equals",
      "contains",
      "begins_with",
      "ends_with",
      "regex",
      "partial_regex",
      "in_list",
      "empty",
      "=",
      ">",
      ">=",
      "<",
      "<=",
      "between",
    ])
    .describe(
      "Text: equals, contains, begins_with, ends_with, regex (whole value, RE2), " +
        "partial_regex, in_list (values), empty. Numbers: =, >, >=, <, <=, between (value, to).",
    ),
  value: z.union([z.string(), z.number()]).optional(),
  to: z.number().optional().describe("For between: the upper bound."),
  values: z.array(z.string()).optional().describe("For in_list."),
  not: z.boolean().default(false).describe("Negates the condition."),
  case_sensitive: z.boolean().default(false),
});
type Condition = z.infer<typeof Condition>;

const Filter = z
  .object({
    match: z.enum(["all", "any"]).default("all").describe("Whether all or any conditions hold."),
    conditions: z.array(Condition).min(1),
  })
  .optional();

server.registerTool(
  "report",
  {
    description:
      "Any Google Analytics 4 report: dimensions and metrics by API name (see metadata), " +
      "one or more periods, filters and order. The rows are saved as a CSV file in your " +
      "workspace (columns: the dimensions in order, dateRange when there are several " +
      "periods, then the metrics); analyze it with the shell. The answer gives the totals, " +
      "the first rows, and warnings: sampling, thresholding (rows hidden for privacy) and " +
      "the (other) row when the data was too varied. Dates are in the property's time " +
      "zone; today's data is incomplete. Example, revenue by blog landing page: dimensions " +
      "[landingPage, sessionSourceMedium], metrics [sessions, keyEvents, purchaseRevenue], " +
      "filter landingPage begins_with /blog/.",
    inputSchema: {
      property: Property,
      dimensions: z.array(z.string()).max(9).default([]).describe("Group by these, in order."),
      metrics: z.array(z.string()).min(1).max(10),
      date_ranges: z
        .array(z.object({ start: DateValue, end: DateValue }))
        .min(1)
        .max(4)
        .default([{ start: "28daysAgo", end: "yesterday" }])
        .describe("Up to 4 periods, compared row by row in the dateRange column."),
      filter: Filter.describe(
        "Conditions on dimensions and metrics; a metric condition filters the grouped rows.",
      ),
      order_by: z
        .array(z.object({ field: z.string(), desc: z.boolean().default(true) }))
        .default([])
        .describe("Default: the first metric, highest first."),
      max_rows: z
        .number()
        .int()
        .min(1)
        .max(250_000)
        .default(10_000)
        .describe("Stop after this many rows."),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .optional()
        .describe("ISO 4217, such as BRL. Default: the property's."),
    },
  },
  (input) =>
    run(async () => {
      const name = propertyName(input.property);
      const isMetric = new Set(input.metrics);
      const conditions = input.filter?.conditions ?? [];
      // GA4 filters on a dimension not requested, but orders only by requested fields.
      const unordered = input.order_by.find(
        (o) => !isMetric.has(o.field) && !input.dimensions.includes(o.field),
      );
      if (unordered) {
        throw new GoogleError(
          `Order by ${unordered.field}: add it to dimensions or metrics first.`,
        );
      }
      const group = (list: Condition[]) => {
        if (list.length === 0) return undefined;
        const expressions = list.map(expression);
        if (expressions.length === 1) return expressions[0];
        return input.filter?.match === "any"
          ? { orGroup: { expressions } }
          : { andGroup: { expressions } };
      };
      const dimensionConditions = conditions.filter((c) => !isMetric.has(c.field));
      const metricConditions = conditions.filter((c) => isMetric.has(c.field));
      if (
        input.filter?.match === "any" &&
        dimensionConditions.length > 0 &&
        metricConditions.length > 0
      ) {
        throw new GoogleError(
          'Google Analytics cannot combine dimension and metric conditions with "any": ' +
            "split them into two reports, or use all.",
        );
      }
      const orderBys = (
        input.order_by.length > 0 ? input.order_by : [{ field: input.metrics[0] ?? "", desc: true }]
      ).map((o) =>
        isMetric.has(o.field)
          ? { metric: { metricName: o.field }, desc: o.desc }
          : { dimension: { dimensionName: o.field }, desc: o.desc },
      );
      const query = {
        dimensions: input.dimensions.map((d) => ({ name: d })),
        metrics: input.metrics.map((m) => ({ name: m })),
        dateRanges: input.date_ranges.map((r, i) => ({
          startDate: r.start,
          endDate: r.end,
          name: `range${String(i)}`,
        })),
        ...(group(dimensionConditions) ? { dimensionFilter: group(dimensionConditions) } : {}),
        ...(group(metricConditions) ? { metricFilter: group(metricConditions) } : {}),
        orderBys,
        metricAggregations: ["TOTAL"],
        ...(input.currency ? { currencyCode: input.currency } : {}),
      };
      const rows: Row[] = [];
      let first: ReportResponse | undefined;
      let rowCount = 0;
      while (rows.length < input.max_rows) {
        const limit = Math.min(PAGE_ROWS, input.max_rows - rows.length);
        const body = (await call(`${DATA}/${name}:runReport`, name, {
          ...query,
          limit,
          offset: rows.length,
          returnPropertyQuota: first === undefined,
        })) as ReportResponse;
        first ??= body;
        rowCount = body.rowCount ?? 0;
        const page = body.rows ?? [];
        rows.push(...page);
        if (page.length < limit || rows.length >= rowCount) break;
      }
      const head = first ?? {};
      const dimensionNames = (head.dimensionHeaders ?? []).map((h) => h.name);
      const metricNames = (head.metricHeaders ?? []).map((h) => h.name);
      const periods = input.date_ranges.map((r) => `${r.start} to ${r.end}`);
      const label = (value: string) => {
        const match = /^range(\d)$/.exec(value);
        return match ? (periods[Number(match[1])] ?? value) : value;
      };
      if (rows.length === 0) {
        return text(`No data in ${name} for ${periods.join("; ")} with these fields and filters.`);
      }
      const columns = [...dimensionNames, ...metricNames];
      const dateRangeAt = dimensionNames.indexOf("dateRange");
      const csv =
        [
          columns.join(","),
          ...rows.map((r) =>
            [
              ...(r.dimensionValues ?? []).map((v, i) =>
                i === dateRangeAt ? label(v.value ?? "") : (v.value ?? ""),
              ),
              ...(r.metricValues ?? []).map((v) => v.value ?? ""),
            ]
              .map(csvCell)
              .join(","),
          ),
        ].join("\n") + "\n";
      const id = createHash("sha256")
        .update(JSON.stringify([name, query]))
        .digest("hex");
      const file = [
        input.dimensions.join("-") || "totals",
        input.date_ranges[0]?.start ?? "",
        input.date_ranges[0]?.end ?? "",
        id.slice(0, 6),
      ].join("_");
      const totals = (head.totals ?? []).map((t) => {
        const range = t.dimensionValues?.find((v) => /^range\d$/.test(v.value ?? ""))?.value;
        const values = (t.metricValues ?? []).map(
          (v, i) => `${metricNames[i] ?? "?"} ${v.value ?? ""}`,
        );
        return `${range ? `${label(range)}: ` : ""}${values.join(", ")}`;
      });
      const meta = head.metadata ?? {};
      const warnings = [
        ...(meta.subjectToThresholding
          ? [
              "Thresholding applied: Google hid rows with few users, so sums of rows are lower than the totals.",
            ]
          : []),
        ...((meta.samplingMetadatas ?? []).length > 0
          ? [
              "Sampled: these numbers are estimates from part of the data. Shorter periods are unsampled.",
            ]
          : []),
        ...(meta.dataLossFromOtherRow
          ? [
              'Some rows were grouped into "(other)": too many distinct values. Filter or use fewer dimensions.',
            ]
          : []),
      ];
      const quota = head.propertyQuota?.tokensPerDay;
      const summary = [
        `${name}, ${periods.join("; ")}${input.dimensions.length > 0 ? `, by ${input.dimensions.join(", ")}` : ""}: ` +
          `${String(rows.length)} of ${String(rowCount)} rows${rows.length < rowCount ? " (stopped at max_rows)" : ""}.`,
        ...(totals.length > 0 ? [`Totals: ${totals.join(" | ")}.`] : []),
        ...(meta.currencyCode || meta.timeZone
          ? [`Currency ${meta.currencyCode ?? "?"}, time zone ${meta.timeZone ?? "?"}.`]
          : []),
        ...warnings,
        ...(quota
          ? [
              `Quota today: ${String(quota.remaining)} of ${String(quota.consumed + quota.remaining)} tokens left.`,
            ]
          : []),
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
            resource: { uri: `ga4://report/${file}.csv`, mimeType: "text/csv", text: csv },
          },
        ],
      };
    }),
);

/** One condition as the Data API's FilterExpression. */
function expression(c: Condition): object {
  const text = (matchType: string) => ({
    stringFilter: { matchType, value: String(c.value ?? ""), caseSensitive: c.case_sensitive },
  });
  const number = (v: string | number | undefined) => {
    const n = Number(v);
    if (v === undefined || Number.isNaN(n)) {
      throw new GoogleError(`The condition on ${c.field} needs a number.`);
    }
    return Number.isInteger(n) ? { int64Value: String(n) } : { doubleValue: n };
  };
  const numeric = (operation: string) => ({
    numericFilter: { operation, value: number(c.value) },
  });
  const filters: Record<Condition["op"], () => object> = {
    equals: () => text("EXACT"),
    contains: () => text("CONTAINS"),
    begins_with: () => text("BEGINS_WITH"),
    ends_with: () => text("ENDS_WITH"),
    regex: () => text("FULL_REGEXP"),
    partial_regex: () => text("PARTIAL_REGEXP"),
    in_list: () => ({ inListFilter: { values: c.values ?? [], caseSensitive: c.case_sensitive } }),
    empty: () => ({ emptyFilter: {} }),
    "=": () => numeric("EQUAL"),
    ">": () => numeric("GREATER_THAN"),
    ">=": () => numeric("GREATER_THAN_OR_EQUAL"),
    "<": () => numeric("LESS_THAN"),
    "<=": () => numeric("LESS_THAN_OR_EQUAL"),
    between: () => ({ betweenFilter: { fromValue: number(c.value), toValue: number(c.to) } }),
  };
  const filter = { filter: { fieldName: c.field, ...filters[c.op]() } };
  return c.not ? { notExpression: filter } : filter;
}

// --- Output ---

interface AccountSummary {
  displayName: string;
  propertySummaries?: { property: string; displayName: string }[];
}
interface Field {
  apiName: string;
  uiName?: string;
  description?: string;
  category?: string;
  type?: string;
  customDefinition?: boolean;
}
interface Row {
  dimensionValues?: { value?: string }[];
  metricValues?: { value?: string }[];
}
interface ReportResponse {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string }[];
  rows?: Row[];
  totals?: Row[];
  rowCount?: number;
  metadata?: {
    currencyCode?: string;
    timeZone?: string;
    subjectToThresholding?: boolean;
    dataLossFromOtherRow?: boolean;
    samplingMetadatas?: unknown[];
  };
  propertyQuota?: { tokensPerDay?: { consumed: number; remaining: number } };
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
    if (!(error instanceof GoogleError)) throw error;
    return { content: [{ type: "text" as const, text: error.message }], isError: true };
  }
}

await server.connect(new StdioServerTransport());
