// MCP server for DataForSEO (stdio): Google results page by page, Google Images,
// keyword research, and mentions in AI answers. Jabuti starts one per agent that uses it, with that
// agent's DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD; they never reach the model (C5,
// C16). Every call is paid: each answer ends with what it cost, as DataForSEO reports.
//
// DATAFORSEO_API_URL overrides the endpoint, for tests against a fake.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const LOGIN = process.env["DATAFORSEO_LOGIN"] ?? "";
const PASSWORD = process.env["DATAFORSEO_PASSWORD"] ?? "";
const API = (process.env["DATAFORSEO_API_URL"] ?? "https://api.dataforseo.com").replace(/\/$/, "");
// Live LLM Mentions may take up to 120 s, by DataForSEO's documentation.
const TIMEOUT_MS = 130_000;
/** The longest AI overview or answer text shown; the agent gets the gist and the sources. */
const MAX_TEXT = 1_500;
const MAX_ELEMENTS = 6;

const Location = {
  location_code: z
    .number()
    .int()
    .describe("DataForSEO location code: 2076 Brazil, 2840 United States, 2620 Portugal."),
  language_code: z.string().min(2).max(5).describe("Language code, such as pt or en."),
};

// Only what is read below; DataForSEO's answers are large and loosely shaped.
const Task = z.object({
  status_code: z.number(),
  status_message: z.string().optional(),
  cost: z.number().optional(),
  result: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
});
const Envelope = z.object({
  status_code: z.number(),
  status_message: z.string().optional(),
  cost: z.number().optional(),
  tasks: z.array(Task).optional(),
});
type Result = Record<string, unknown>;

/** One task, posted; its first result, or why there is none. */
async function call(
  path: string,
  task: object,
): Promise<{ result: Result; cost: number } | string> {
  if (!LOGIN || !PASSWORD)
    return "DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD are not set for this agent.";
  let res: globalThis.Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${LOGIN}:${PASSWORD}`).toString("base64")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify([task]),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return `DataForSEO did not answer: ${error instanceof Error ? error.message : "error"}.`;
  }
  if (res.status === 401) {
    return "DataForSEO refused the login: check DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD (the API password, not the account's) in Settings → Variables.";
  }
  const parsed = Envelope.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success)
    return `DataForSEO answered HTTP ${String(res.status)} in a shape this server does not understand.`;
  const envelope = parsed.data;
  const first = envelope.tasks?.[0];
  const status = first?.status_code ?? envelope.status_code;
  if (status !== 20000) {
    const message = first?.status_message ?? envelope.status_message ?? "no message";
    // 402xx: the account has no funds or the plan does not include this API.
    const hint =
      status >= 40200 && status < 40300 ? " Check the balance in the DataForSEO dashboard." : "";
    return `DataForSEO: ${message} (${String(status)}).${hint}`;
  }
  const result = first?.result?.[0];
  if (!result) return "DataForSEO found nothing for this request.";
  return { result, cost: first.cost ?? envelope.cost ?? 0 };
}

// --- reading loose objects -------------------------------------------------

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj) : []);
const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const usd = (cost: number) => `Cost: US$ ${cost.toFixed(4)}`;

/** A domain without www, lowercased, so a site matches however it is written. */
function bare(domain: string): string {
  return domain
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}
const mine = (domain: string | undefined, site: string | undefined) =>
  site !== undefined &&
  domain !== undefined &&
  (bare(domain) === site || bare(domain).endsWith(`.${site}`));

/** Every reference an AI overview cites, at any depth: its sources. */
function references(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 5 || typeof value !== "object" || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((v) => references(v, depth + 1));
  const record = value as Record<string, unknown>;
  const own = Array.isArray(record["references"]) ? arr(record["references"]) : [];
  const nested = Object.entries(record)
    .filter(([k]) => k !== "references")
    .flatMap(([, v]) => references(v, depth + 1));
  return [...own, ...nested];
}

/** The AI overview's text: its own, or its elements' in order. */
function overviewText(item: Record<string, unknown>): string {
  const own = str(item["markdown"]) ?? str(item["text"]);
  if (own) return own;
  return arr(item["items"])
    .map((e) => str(e["markdown"]) ?? str(e["text"]) ?? str(e["title"]) ?? "")
    .filter(Boolean)
    .join("\n");
}

const server = new McpServer({ name: "dataforseo", version: "0.1.0" });

// --- serp ------------------------------------------------------------------

server.registerTool(
  "serp",
  {
    description:
      "One Google results page as a user in that place and device sees it, block by block " +
      "in order: AI overview (its text and the sources it cites), People Also Ask, videos and " +
      "short videos, forums, top stories, local pack and the organic results. With site, " +
      "it says where that site appears, organic or cited by the AI overview. Costs about " +
      "US$ 0.002 per page, plus US$ 0.002 with ai_overview; each answer gives its cost.",
    inputSchema: {
      keyword: z.string().min(1).max(700).describe("The query, as typed into Google."),
      ...Location,
      device: z
        .enum(["mobile", "desktop"])
        .default("mobile")
        .describe("Results differ by device; most Brazilian searches are on mobile."),
      depth: z
        .number()
        .int()
        .min(10)
        .max(50)
        .default(10)
        .describe("Results to read, 10 per page billed."),
      ai_overview: z
        .boolean()
        .default(true)
        .describe("Wait for an AI overview Google loads late. Adds about US$ 0.002."),
      site: z.string().optional().describe("A domain to find on the page, such as example.com."),
    },
  },
  async ({ keyword, location_code, language_code, device, depth, ai_overview, site }) => {
    const answer = await call("/v3/serp/google/organic/live/advanced", {
      keyword,
      location_code,
      language_code,
      device,
      depth,
      load_async_ai_overview: ai_overview,
    });
    if (typeof answer === "string") return failure(answer);
    return text(
      serpReport(answer.result, keyword, device, site ? bare(site) : undefined, answer.cost),
    );
  },
);

function serpReport(
  result: Result,
  keyword: string,
  device: string,
  site: string | undefined,
  cost: number,
): string {
  const items = arr(result["items"]);
  const lines = [
    `Google · "${keyword}" · ${device} · location ${String(num(result["location_code"]) ?? "?")}, ${str(result["language_code"]) ?? "?"}`,
  ];
  const total = num(result["se_results_count"]);
  if (total !== undefined) lines.push(`About ${String(total)} results.`);
  const order = items.map((i) => str(i["type"]) ?? "?");
  lines.push(`Blocks, top to bottom: ${collapse(order).join(", ") || "none"}`);

  const found: string[] = [];
  for (const item of items) {
    const type = str(item["type"]) ?? "?";
    const rank = num(item["rank_absolute"]);
    const at = rank === undefined ? "" : `#${String(rank)} `;
    lines.push("");
    if (type === "organic") {
      const domain = str(item["domain"]);
      const position = num(item["rank_group"]);
      if (mine(domain, site))
        found.push(`organic #${String(position ?? "?")} (${str(item["url"]) ?? ""})`);
      lines.push(
        `${at}organic ${String(position ?? "?")}: ${str(item["title"]) ?? ""}${mine(domain, site) ? "  ← your site" : ""}`,
        `  ${str(item["url"]) ?? ""}`,
      );
      const description = str(item["description"]);
      if (description) lines.push(`  ${clip(oneLine(description), 200)}`);
      continue;
    }
    if (type === "ai_overview") {
      // Each source once: the same one is often cited by the overview and by an element.
      const refs = [...new Map(references(item).map((r) => [str(r["url"]) ?? "", r])).values()];
      const cited = refs.filter((r) => mine(str(r["domain"]), site));
      if (cited.length > 0) found.push(`cited by the AI overview (${String(cited.length)}×)`);
      lines.push(`${at}AI overview:`, indent(clip(overviewText(item), MAX_TEXT)));
      lines.push(`  Sources (${String(refs.length)}):`);
      for (const r of refs) {
        const mark = mine(str(r["domain"]), site) ? "  ← your site" : "";
        lines.push(
          `  - ${str(r["domain"]) ?? str(r["source"]) ?? "?"}: ${str(r["title"]) ?? ""} ${str(r["url"]) ?? ""}${mark}`,
        );
      }
      continue;
    }
    if (type === "people_also_ask") {
      lines.push(`${at}People Also Ask:`);
      for (const q of arr(item["items"]).slice(0, MAX_ELEMENTS)) {
        const expanded = obj(arr(q["expanded_element"])[0] ?? q["expanded_element"]);
        const domain = str(expanded["domain"]);
        lines.push(
          `  - ${str(q["title"]) ?? "?"}${domain ? ` (answered by ${domain}${mine(domain, site) ? " ← your site" : ""})` : ""}`,
        );
      }
      continue;
    }
    const elements = arr(item["items"]);
    const title = str(item["title"]);
    lines.push(`${at}${type}${title ? `: ${title}` : ""}`);
    for (const e of elements.slice(0, MAX_ELEMENTS)) {
      const domain = str(e["domain"]) ?? str(e["source"]);
      const what = str(e["title"]) ?? str(e["text"]) ?? str(e["description"]) ?? "";
      const url = str(e["url"]) ?? "";
      lines.push(`  - ${domain ? `${domain}: ` : ""}${clip(oneLine(what), 140)} ${url}`.trimEnd());
    }
    if (elements.length > MAX_ELEMENTS)
      lines.push(`  - … and ${String(elements.length - MAX_ELEMENTS)} more`);
  }
  if (site) {
    lines.push("", `${site}: ${found.length > 0 ? found.join("; ") : "not on this page"}.`);
  }
  lines.push("", usd(cost));
  return lines.join("\n");
}

/** organic, organic, organic → organic ×3: the page's shape at a glance. */
function collapse(types: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < types.length) {
    let j = i;
    while (j < types.length && types[j] === types[i]) j++;
    out.push(j - i > 1 ? `${types[i] ?? ""} ×${String(j - i)}` : (types[i] ?? ""));
    i = j;
  }
  return out;
}

const indent = (text: string) =>
  text
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");

// --- keywords --------------------------------------------------------------

const MODES = {
  ideas: "/v3/dataforseo_labs/google/keyword_ideas/live",
  suggestions: "/v3/dataforseo_labs/google/keyword_suggestions/live",
  overview: "/v3/dataforseo_labs/google/keyword_overview/live",
} as const;

server.registerTool(
  "keywords",
  {
    description:
      "Keyword research from Google data: monthly volume, keyword difficulty (0-100), CPC, " +
      "main intent and the blocks on its results page. ideas: keywords on the seeds' topics; " +
      "suggestions: longer queries containing one seed (the long tail); overview: exactly " +
      "the keywords given. Volumes are estimates for that location and language. Each " +
      "answer gives its cost (about US$ 0.01 per call plus a fraction of a cent per row).",
    inputSchema: {
      mode: z.enum(["ideas", "suggestions", "overview"]),
      keywords: z
        .array(z.string().min(1).max(80))
        .min(1)
        .max(200)
        .describe("Seeds for ideas, one seed for suggestions, the keywords for overview."),
      ...Location,
      limit: z.number().int().min(1).max(200).default(50).describe("Rows, largest volume first."),
    },
  },
  async ({ mode, keywords, location_code, language_code, limit }) => {
    const base = { location_code, language_code, include_serp_info: true };
    const task =
      mode === "suggestions"
        ? { ...base, keyword: keywords[0], limit, order_by: ["keyword_info.search_volume,desc"] }
        : mode === "ideas"
          ? { ...base, keywords, limit, order_by: ["keyword_info.search_volume,desc"] }
          : { ...base, keywords };
    const answer = await call(MODES[mode], task);
    if (typeof answer === "string") return failure(answer);
    const rows = arr(answer.result["items"]).slice(0, limit).map(keywordRow);
    rows.sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1));
    const lines = [
      `${mode} · ${keywords.slice(0, 5).join(", ")}${keywords.length > 5 ? "…" : ""} · location ${String(location_code)}, ${language_code}`,
      "keyword | volume/month | difficulty | CPC US$ | intent | results page",
      ...rows.map(
        (r) =>
          `${r.keyword} | ${String(r.volume ?? "?")} | ${String(r.difficulty ?? "?")} | ${r.cpc === undefined ? "?" : r.cpc.toFixed(2)} | ${r.intent ?? "?"} | ${r.serp.join(", ") || "?"}`,
      ),
    ];
    if (rows.length === 0) lines.push("No keywords found.");
    lines.push("", usd(answer.cost));
    return text(lines.join("\n"));
  },
);

function keywordRow(item: Record<string, unknown>) {
  // keyword_suggestions and keyword_ideas nest the same fields; overview too.
  const info = obj(item["keyword_info"]);
  return {
    keyword: str(item["keyword"]) ?? "?",
    volume: num(info["search_volume"]),
    cpc: num(info["cpc"]),
    difficulty: num(obj(item["keyword_properties"])["keyword_difficulty"]),
    intent: str(obj(item["search_intent_info"])["main_intent"]),
    serp: (Array.isArray(obj(item["serp_info"])["serp_item_types"])
      ? (obj(item["serp_info"])["serp_item_types"] as unknown[])
      : []
    ).filter((t): t is string => typeof t === "string"),
  };
}

// --- ai_mentions -----------------------------------------------------------

server.registerTool(
  "ai_mentions",
  {
    description:
      "Questions answered by Google's AI overviews or ChatGPT that cite a domain or mention " +
      "a topic, with each answer's sources and its estimated monthly volume: to see whether " +
      "and where AI answers cite a site, and who they cite instead. ChatGPT data exists only " +
      "for the United States in English; Google's for more places. Can take up to two " +
      "minutes, and costs more than a search (each answer gives its cost).",
    inputSchema: {
      domain: z.string().optional().describe("Cited as a source: example.com, no https or www."),
      topic: z.string().max(250).optional().describe("Words in the question or the answer."),
      platform: z.enum(["google", "chat_gpt"]).default("google"),
      ...Location,
      limit: z.number().int().min(1).max(50).default(20),
    },
  },
  async ({ domain, topic, platform, location_code, language_code, limit }) => {
    if (!domain && !topic) return failure("Give a domain, a topic, or both.");
    const target = [
      ...(domain ? [{ domain: bare(domain), search_filter: "include" }] : []),
      ...(topic ? [{ keyword: topic, search_filter: "include" }] : []),
    ];
    const answer = await call("/v3/ai_optimization/llm_mentions/search_mentions/live", {
      target,
      platform,
      location_code,
      language_code,
      limit,
      order_by: ["ai_search_volume,desc"],
    });
    if (typeof answer === "string") return failure(answer);
    const items = arr(answer.result["items"]);
    const site = domain ? bare(domain) : undefined;
    const lines = [
      `AI answers (${platform}) · ${[domain, topic].filter(Boolean).join(" + ")} · location ${String(location_code)}, ${language_code}`,
      `${String(num(answer.result["total_count"]) ?? items.length)} answers found; showing ${String(items.length)}, by volume.`,
    ];
    for (const item of items) {
      const sources = arr(item["sources"]);
      lines.push(
        "",
        `Q: ${str(item["question"]) ?? "?"} (about ${String(num(item["ai_search_volume"]) ?? "?")}/month)`,
        `  A: ${clip(oneLine(str(item["answer"]) ?? ""), 300)}`,
        `  Sources: ${
          sources
            .slice(0, 8)
            .map(
              (s) => `${str(s["domain"]) ?? "?"}${mine(str(s["domain"]), site) ? " ← cited" : ""}`,
            )
            .join(", ") || "none"
        }`,
      );
    }
    if (items.length === 0) lines.push("No AI answers found for this.");
    lines.push("", usd(answer.cost));
    return text(lines.join("\n"));
  },
);

// --- images ----------------------------------------------------------------

/** Words too common to tell anything about what images show or say. */
const STOP = new Set(
  (
    "a o as os e de da do das dos em no na nos nas um uma uns umas para por com sem que " +
    "como se ou ao aos the and of to in for with on at by an is are from your you how what"
  ).split(" "),
);

/** The most frequent words of some texts, with how many texts use each. */
function recurring(texts: string[], top = 12): string {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const words = new Set(
      text
        .toLowerCase()
        .normalize("NFC")
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)),
    );
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const ranked = [...counts.entries()]
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top);
  return ranked.length > 0
    ? ranked.map(([w, n]) => `${w} (${String(n)})`).join(", ")
    : "none repeat";
}

/** The image's file name and type, from its address. */
function file(url: string | undefined): { name: string; ext: string } | undefined {
  if (!url) return undefined;
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
    const match = /^(.*?)(?:\.([a-z0-9]{2,5}))?$/i.exec(last);
    if (!match?.[1]) return undefined;
    return { name: match[1], ext: (match[2] ?? "").toLowerCase() };
  } catch {
    return undefined;
  }
}

function host(url: string | undefined): string | undefined {
  try {
    return url ? bare(new URL(url).hostname) : undefined;
  } catch {
    return undefined;
  }
}

/** "a (3), b (1)": each value and how often it appears, most frequent first. */
function tally(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([v, n]) => `${v} (${String(n)})`)
    .join(", ");
}

server.registerTool(
  "images",
  {
    description:
      "What Google Images shows for a query (desktop): each image's title, alt text, " +
      "site and file name, and the patterns across them: recurring words in alt texts, " +
      "titles and file names, file types, images without alt, the sites that rank and " +
      "the refinements Google offers. Ends with thumbnail addresses to pass to " +
      "view_images, to see what the images have in common before writing a prompt. " +
      "Costs about US$ 0.002 per 100 images.",
    inputSchema: {
      keyword: z.string().min(1).max(700).describe("The query, as typed into Google."),
      ...Location,
      depth: z
        .number()
        .int()
        .min(10)
        .max(100)
        .default(40)
        .describe("Images to read; up to 100 cost the same."),
      thumbnails: z
        .number()
        .int()
        .min(0)
        .max(16)
        .default(12)
        .describe("Thumbnail addresses to list for view_images, from the top."),
    },
  },
  async ({ keyword, location_code, language_code, depth, thumbnails }) => {
    const answer = await call("/v3/serp/google/images/live/advanced", {
      keyword,
      location_code,
      language_code,
      depth,
    });
    if (typeof answer === "string") return failure(answer);
    const items = arr(answer.result["items"]);
    const images = items.filter((i) => i["type"] === "images_search");
    const refinements = items
      .filter((i) => i["type"] === "carousel" || i["type"] === "related_searches")
      .flatMap((i) => arr(i["items"]).map((e) => str(e["title"]) ?? ""))
      .concat(
        items
          .filter((i) => i["type"] === "related_searches")
          .flatMap((i) =>
            (Array.isArray(i["items"]) ? i["items"] : []).filter(
              (e): e is string => typeof e === "string",
            ),
          ),
      )
      .filter((t) => t !== "");
    const alts = images.map((i) => oneLine(str(i["alt"]) ?? ""));
    const titles = images.map((i) => oneLine(str(i["title"]) ?? ""));
    const files = images.map((i) => file(str(i["source_url"])));
    const lines = [
      `Google Images for "${keyword}" (desktop): ${String(images.length)} images.`,
      "",
      "Patterns:",
      `- Words in alt texts: ${recurring(alts.filter((a) => a !== ""))}`,
      `- Words in titles: ${recurring(titles.filter((t) => t !== ""))}`,
      `- Words in file names: ${recurring(files.flatMap((f) => (f ? [f.name.replace(/[-_.+]+/g, " ")] : [])))}`,
      `- File types: ${tally(files.flatMap((f) => (f?.ext ? [f.ext] : []))) || "unknown"}`,
      `- Without alt text: ${String(alts.filter((a) => a === "").length)} of ${String(images.length)}`,
      `- Sites: ${
        tally(images.flatMap((i) => host(str(i["url"])) ?? []))
          .split(", ")
          .slice(0, 10)
          .join(", ") || "none"
      }`,
      ...(refinements.length > 0
        ? [`- Google's refinements: ${[...new Set(refinements)].slice(0, 15).join(", ")}`]
        : []),
      "",
      "Images, in rank order:",
    ];
    images.forEach((i, n) => {
      const f = files[n];
      lines.push(
        `${String(n + 1)}. ${clip(titles[n] ?? "", 120) || "(no title)"} | alt: ${alts[n] ? `"${clip(alts[n] ?? "", 160)}"` : "none"} | ${host(str(i["url"])) ?? "?"}${f ? ` | ${f.name}${f.ext ? `.${f.ext}` : ""}` : ""}`,
      );
    });
    const shown = images
      .slice(0, thumbnails)
      .map((i) => str(i["encoded_url"]) ?? str(i["source_url"]))
      .filter((u): u is string => u !== undefined);
    if (shown.length > 0) {
      lines.push("", `For view_images (the top ${String(shown.length)}, in order):`, ...shown);
    }
    lines.push("", usd(answer.cost));
    return text(lines.join("\n"));
  },
);

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function failure(value: string) {
  return { content: [{ type: "text" as const, text: value }], isError: true };
}

await server.connect(new StdioServerTransport());
