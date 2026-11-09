// MCP server for Google results through serper.dev (stdio). Jabuti starts one per
// agent that uses it, with that agent's SERPER_API_KEY in its environment; the key
// never reaches the model (C5, C16).
//
// SERPER_API_URL overrides the endpoint, for tests against a fake.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const KEY = process.env["SERPER_API_KEY"] ?? "";
const URL = process.env["SERPER_API_URL"] ?? "https://google.serper.dev";
const TIMEOUT_MS = 30_000;

/** What the model gets back: the fields useful to read a results page, nothing else. */
const Organic = z.object({
  position: z.number().optional(),
  title: z.string().optional(),
  link: z.string().optional(),
  snippet: z.string().optional(),
  date: z.string().optional(),
});
const Response = z.object({
  answerBox: z.record(z.string(), z.unknown()).optional(),
  knowledgeGraph: z.record(z.string(), z.unknown()).optional(),
  organic: z.array(Organic).optional(),
  news: z.array(Organic.extend({ source: z.string().optional() })).optional(),
  peopleAlsoAsk: z
    .array(z.object({ question: z.string().optional(), link: z.string().optional() }))
    .optional(),
  relatedSearches: z.array(z.object({ query: z.string().optional() })).optional(),
  credits: z.number().optional(),
});

/** Parsed above, or bookkeeping: not listed among the other sections. */
const KNOWN = new Set([...Object.keys(Response.shape), "searchParameters"]);
const MAX_ITEMS = 5;

/**
 * Every other block Google showed (videos, top stories, an AI overview…), whatever
 * Serper names it: a list is cut to its first items' title, link and source; anything
 * else to its field names and the links it cites. The page's layout is what competes
 * with the organic results, so the agent sees it without this server knowing each block.
 */
function others(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null) return {};
  const found: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (KNOWN.has(name) || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      found[name] = value.slice(0, MAX_ITEMS).map((item: unknown) => pick(item));
      continue;
    }
    if (typeof value === "object") {
      found[name] = { fields: Object.keys(value), links: links(value).slice(0, MAX_ITEMS) };
      continue;
    }
    found[name] = value;
  }
  return found;
}

function pick(item: unknown): unknown {
  if (typeof item !== "object" || item === null) return item;
  const record = item as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const key of ["title", "link", "source", "channel", "date", "snippet"]) {
    if (typeof record[key] === "string") kept[key] = record[key];
  }
  return Object.keys(kept).length > 0 ? kept : { fields: Object.keys(record) };
}

/** The URLs a block cites, at any depth. */
function links(value: unknown, depth = 0): string[] {
  if (depth > 4 || typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, v]) =>
    key === "link" && typeof v === "string" ? [v] : links(v, depth + 1),
  );
}

const server = new McpServer({ name: "serper", version: "0.1.0" });

server.registerTool(
  "search",
  {
    description:
      "Google results for a query, as a user in the given country and language would see " +
      "them: organic results with their positions, answer box, People Also Ask and related " +
      "searches. Use it to check rankings, competitors and search intent. `sections` lists " +
      "every block on the page, and `other` summarizes the ones beyond those (such as " +
      "videos, top stories or an AI overview): what competes with the organic results " +
      "for the click. Each call spends one of the user's Serper credits.",
    inputSchema: {
      q: z.string().min(1).describe("The query, as typed into Google."),
      type: z.enum(["search", "news"]).default("search").describe("Web results or Google News."),
      gl: z.string().length(2).optional().describe("Country code, such as br or us."),
      hl: z.string().optional().describe("Interface language, such as pt-br or en."),
      location: z.string().optional().describe("A city or region, such as São Paulo, Brazil."),
      num: z.number().int().min(10).max(100).optional().describe("Results per page, 10 to 100."),
      page: z.number().int().min(1).max(10).optional().describe("Results page, from 1."),
    },
  },
  async ({ type, ...query }) => {
    if (!KEY) return failure("SERPER_API_KEY is not set for this agent.");
    let res: globalThis.Response;
    try {
      res = await fetch(`${URL}/${type}`, {
        method: "POST",
        headers: { "X-API-KEY": KEY, "Content-Type": "application/json" },
        body: JSON.stringify(query),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      return failure(`Serper did not answer: ${error instanceof Error ? error.message : "error"}.`);
    }
    if (res.status === 401 || res.status === 403) {
      return failure("Serper refused the API key. Check SERPER_API_KEY in Settings → Variables.");
    }
    if (res.status === 429) return failure("Serper rate limit or credits exhausted. Try later.");
    if (!res.ok) return failure(`Serper answered HTTP ${String(res.status)}.`);
    const raw: unknown = await res.json().catch(() => undefined);
    const parsed = Response.safeParse(raw);
    if (!parsed.success) return failure("Serper sent a response this server does not understand.");
    const other = others(raw);
    const sections = Object.keys(raw as object).filter(
      (k) => k !== "searchParameters" && k !== "credits",
    );
    const text = JSON.stringify({ sections, ...parsed.data, other });
    return { content: [{ type: "text", text }] };
  },
);

function failure(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

await server.connect(new StdioServerTransport());
