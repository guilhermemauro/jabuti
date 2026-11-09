// MCP server for Wikipedia's public metrics (stdio): what people read, as a free
// signal of interest for keyword research. Wikimedia's Pageviews API for the counts,
// each wiki's own API for titles, redirects, links and categories. No key, but
// Wikimedia asks every client to name itself with a contact in the User-Agent: with
// one it allows 200 requests a minute, without one 10. WIKIMEDIA_CONTACT is that
// contact (the owner's e-mail or site), and this server keeps under the limit.
//
// Page views are not search volume: they say whether interest rises or falls, when
// in the year it peaks, and which of two topics is larger.
//
// WIKI_TEST_URL sends every request to a fake, for tests: the Pageviews API under
// /rest_v1 and each wiki under /<domain>/w/api.php.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const TEST = process.env["WIKI_TEST_URL"];
const REST = TEST ? `${TEST}/rest_v1` : "https://wikimedia.org/api/rest_v1";
const CONTACT = (process.env["WIKIMEDIA_CONTACT"] ?? "").replace(/[^\w@.:/+-]/g, "");
const USER_AGENT = `JabutiBot/0.1 (${CONTACT || "no contact given"}) self-hosted SEO agent`;
const TIMEOUT_MS = 20_000;
/** Wikimedia asks for 3 or fewer requests at once. */
const PARALLEL = 3;
/** Under Wikimedia's 200 a minute, leaving room for the owner's other tools. */
const PER_MINUTE = 150;
/** Related candidates whose views are looked up, most likely first. */
const MAX_CANDIDATES = 40;
/** Answers kept for an hour: the same question twice costs no request. */
const CACHE_MS = 3_600_000;

const Language = z
  .string()
  .regex(/^[a-z]{2,3}(-[a-z]+)?$/)
  .optional()
  .describe("Wikipedia's language code: pt (default), en, es…");

const server = new McpServer({ name: "wikipedia", version: "0.1.0" });

// --- trending ---

const TopAnswer = z.object({
  items: z.array(
    z.object({
      articles: z.array(
        z.object({
          article: z.string(),
          views: z.number().optional(),
          views_ceil: z.number().optional(),
          project: z.string().optional(),
        }),
      ),
    }),
  ),
});

server.registerTool(
  "trending",
  {
    description:
      "The most read Wikipedia articles of a day or a month, without the main page and " +
      "system pages: what people are curious about now, often before keyword tools show " +
      "it. Free. Expect news, celebrities and sports at the top; look for the topics that " +
      "fit the site. Data arrives a day or two late.",
    inputSchema: {
      language: Language,
      date: z
        .string()
        .regex(/^\d{4}-\d{2}(-\d{2})?$/)
        .optional()
        .describe("YYYY-MM-DD for a day, YYYY-MM for a whole month. Default: the latest day."),
      country: z
        .string()
        .regex(/^[A-Z]{2}$/)
        .optional()
        .describe(
          "Only readers in this country (BR, PT, US…), daily only; counts rounded up to 100.",
        ),
      limit: z.number().int().min(1).max(300).optional().describe("Default 50."),
    },
  },
  async (input) => {
    const language = input.language ?? "pt";
    const project = `${language}.wikipedia`;
    const limit = input.limit ?? 50;
    const monthly = input.date?.length === 7;
    if (monthly && input.country) {
      return failure("Wikimedia has countries by day only: give a YYYY-MM-DD date.");
    }
    const hidden = await systemPages(language);
    // The latest day may not be loaded yet: step back a few days.
    const days = input.date ? [input.date] : recentDays(4);
    let found:
      { date: string; articles: z.infer<typeof TopAnswer>["items"][0]["articles"] } | undefined;
    let problem = "";
    for (const date of days) {
      // "2026-11-05" → "2026/11/05"; a month → "2026/10/all-days".
      const when =
        date.length === 7 ? `${date.replace("-", "/")}/all-days` : date.replaceAll("-", "/");
      const path = input.country
        ? `metrics/pageviews/top-per-country/${input.country}/all-access/${when}`
        : `metrics/pageviews/top/${project}.org/all-access/${when}`;
      const answer = await get(`${REST}/${path}`, TopAnswer);
      if ("problem" in answer) {
        problem = answer.problem;
        continue;
      }
      found = { date, articles: answer.data.items[0]?.articles ?? [] };
      break;
    }
    if (!found) return failure(`Wikimedia has no list for that date yet: ${problem}`);
    const rows = found.articles
      .filter((a) => !input.country || a.project === project)
      .filter((a) => !hidden(a.article))
      .slice(0, limit);
    const lines = rows.map(
      (a, i) => `${String(i + 1)}. ${title(a.article)}: ${count(a.views ?? a.views_ceil ?? 0)}`,
    );
    return text(
      [
        `Most read on ${project}${input.country ? ` from ${input.country}` : ""}, ${monthly ? "month" : "day"} ${found.date} (${input.country ? "views rounded up to 100" : "views"}):`,
        ...lines,
        "",
        "Use history for a topic's trend and season, related for the topics around it.",
      ].join("\n"),
    );
  },
);

// --- history ---

const PerArticle = z.object({
  items: z.array(z.object({ timestamp: z.string(), views: z.number() })),
});

server.registerTool(
  "history",
  {
    description:
      "How many people read Wikipedia articles over time, by month or day: the topic's " +
      "trend, its peak and its season (the months it is read most), to compare topics and " +
      "to time a post. Titles are resolved (redirects followed, case fixed). Free. Views " +
      "through other names of the article (its redirects) are not included.",
    inputSchema: {
      articles: z
        .array(z.string().min(1).max(250))
        .min(1)
        .max(10)
        .describe("Article titles as on Wikipedia, such as Amigo secreto."),
      language: Language,
      granularity: z.enum(["monthly", "daily"]).optional().describe("Default monthly."),
      months: z
        .number()
        .int()
        .min(1)
        .max(120)
        .optional()
        .describe("How far back, in full months. Default 24 (monthly) or 3 (daily)."),
    },
  },
  async (input) => {
    const language = input.language ?? "pt";
    const daily = input.granularity === "daily";
    const months = input.months ?? (daily ? 3 : 24);
    const resolved = await resolve(language, input.articles);
    if ("problem" in resolved) return failure(resolved.problem);
    const { start, end } = range(months, daily);
    const blocks = await inParallel(resolved.titles, async (t) => {
      if (!t.title) {
        return `${t.asked}: no such article.${t.suggestions.length > 0 ? ` Did you mean: ${t.suggestions.join("; ")}?` : ""}`;
      }
      const path = `metrics/pageviews/per-article/${language}.wikipedia.org/all-access/user/${encodeURIComponent(t.title.replaceAll(" ", "_"))}/${daily ? "daily" : "monthly"}/${start}/${end}`;
      const answer = await get(`${REST}/${path}`, PerArticle);
      const name = t.asked === t.title ? t.title : `${t.asked} → ${t.title}`;
      if ("problem" in answer) return `${name}: no views recorded (${answer.problem}).`;
      return describe(name, answer.data.items, daily);
    });
    return text(blocks.join("\n\n"));
  },
);

/** Total, peak, trend, season, then the series. */
function describe(name: string, items: { timestamp: string; views: number }[], daily: boolean) {
  const series = items.map((i) => ({
    when: daily
      ? `${i.timestamp.slice(0, 4)}-${i.timestamp.slice(4, 6)}-${i.timestamp.slice(6, 8)}`
      : `${i.timestamp.slice(0, 4)}-${i.timestamp.slice(4, 6)}`,
    views: i.views,
  }));
  if (series.length === 0) return `${name}: no views recorded in this period.`;
  const total = series.reduce((sum, s) => sum + s.views, 0);
  const peak = series.reduce((a, b) => (b.views > a.views ? b : a));
  const low = series.reduce((a, b) => (b.views < a.views ? b : a));
  const lines = [
    `${name}: ${count(total)} views in ${String(series.length)} ${daily ? "days" : "months"}, ${count(Math.round(total / series.length))} a ${daily ? "day" : "month"} on average.`,
    `Peak ${peak.when} (${count(peak.views)}), lowest ${low.when} (${count(low.views)}).`,
  ];
  if (!daily && series.length >= 15) {
    // The last 3 months against the same 3 a year before.
    const last = series.slice(-3);
    const before = last.flatMap((s) => {
      const views = series.find((p) => p.when === yearBefore(s.when))?.views;
      return views === undefined ? [] : [views];
    });
    if (before.length === last.length) {
      const now = last.reduce((sum, s) => sum + s.views, 0);
      const then = before.reduce((sum, v) => sum + v, 0);
      if (then > 0) {
        lines.push(
          `Last 3 months against the same months a year before: ${percent((now - then) / then)}.`,
        );
      }
    }
    // Average by calendar month: the season.
    const byMonth = new Map<string, number[]>();
    for (const s of series)
      byMonth.set(s.when.slice(5), [...(byMonth.get(s.when.slice(5)) ?? []), s.views]);
    const average = [...byMonth].map(([month, v]) => ({
      month,
      views: v.reduce((a, b) => a + b, 0) / v.length,
    }));
    const mean = average.reduce((sum, a) => sum + a.views, 0) / average.length;
    const strong = average
      .filter((a) => a.views > mean * 1.25)
      .sort((a, b) => b.views - a.views)
      .slice(0, 4)
      .map((a) => `${MONTHS[Number(a.month) - 1] ?? a.month} (${percent(a.views / mean - 1)})`);
    lines.push(
      strong.length > 0
        ? `Strongest months on average: ${strong.join(", ")}. Publish or update a few weeks before.`
        : "No strong season: read about the same all year.",
    );
  }
  lines.push(`Series: ${series.map((s) => `${s.when} ${count(s.views)}`).join("; ")}`);
  return lines.join("\n");
}

// --- related ---

const Query = z.object({
  query: z
    .object({
      redirects: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
      normalized: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
      pages: z
        .array(
          z
            .object({
              title: z.string(),
              missing: z.boolean().optional(),
              invalid: z.boolean().optional(),
              categories: z.array(z.object({ title: z.string() })).optional(),
            })
            .loose(),
        )
        .optional(),
      search: z.array(z.object({ title: z.string() })).optional(),
      categorymembers: z.array(z.object({ title: z.string() })).optional(),
    })
    .loose()
    .optional(),
});

server.registerTool(
  "related",
  {
    description:
      "The topics around a Wikipedia article, ranked by how many read them last month: " +
      "articles it links to, articles in its categories and similar articles. For topic " +
      "clusters and new keyword ideas. Free; takes some seconds.",
    inputSchema: {
      article: z.string().min(1).max(250).describe("The article's title, such as Natal."),
      language: Language,
      limit: z.number().int().min(1).max(60).optional().describe("Default 30."),
    },
  },
  async (input) => {
    const language = input.language ?? "pt";
    const resolved = await resolve(language, [input.article]);
    if ("problem" in resolved) return failure(resolved.problem);
    const found = resolved.titles[0];
    if (!found?.title) {
      return failure(
        `No article "${input.article}".${found && found.suggestions.length > 0 ? ` Did you mean: ${found.suggestions.join("; ")}?` : ""}`,
      );
    }
    const page = found.title;
    const info = await wiki(language, {
      titles: page,
      prop: "categories",
      clshow: "!hidden",
      cllimit: "max",
    });
    if ("problem" in info) return failure(info.problem);
    // The links of the introduction: the closest topics, fewer than the whole article's.
    const intro = await get(api(language, { page, prop: "links", section: "0" }, "parse"), Parsed);
    const similar = await wiki(language, {
      list: "search",
      srsearch: `morelike:${page}`,
      srlimit: "15",
      srprop: "",
    });
    const first = info.data.query?.pages?.[0];
    const categories = (first?.categories ?? []).map((c) => c.title);
    const members = await inParallel(categories.slice(0, 3), async (category) => {
      const answer = await wiki(language, {
        list: "categorymembers",
        cmtitle: category,
        cmnamespace: "0",
        cmlimit: "20",
      });
      return "problem" in answer
        ? []
        : (answer.data.query?.categorymembers ?? []).map((m) => m.title);
    });
    const sources = new Map<string, Set<string>>();
    const add = (titles: string[], source: string) => {
      for (const t of titles) {
        if (t === page) continue;
        sources.set(t, (sources.get(t) ?? new Set()).add(source));
      }
    };
    const linked =
      "problem" in intro
        ? []
        : intro.data.parse.links
            .filter((l) => l.ns === 0 && l.exists !== false)
            .map((l) => l.title);
    add(linked, "linked from its introduction");
    add(members.flat(), "same category");
    add(
      "problem" in similar ? [] : (similar.data.query?.search ?? []).map((s) => s.title),
      "similar",
    );
    // Found in more ways first; then one of each source in turn, since each list
    // comes alphabetical and the first of one would crowd out the others.
    const turns = new Map<string, number>();
    const rank = new Map<string, number>();
    for (const [t, from] of sources) {
      const source = [...from][0] ?? "";
      const turn = turns.get(source) ?? 0;
      turns.set(source, turn + 1);
      rank.set(t, turn);
    }
    const candidates = [...sources]
      .sort((a, b) => b[1].size - a[1].size || (rank.get(a[0]) ?? 0) - (rank.get(b[0]) ?? 0))
      .slice(0, MAX_CANDIDATES);
    const { start, end } = range(1, false);
    const views = await inParallel(candidates, async ([t, from]) => {
      const answer = await get(
        `${REST}/metrics/pageviews/per-article/${language}.wikipedia.org/all-access/user/${encodeURIComponent(t.replaceAll(" ", "_"))}/monthly/${start}/${end}`,
        PerArticle,
      );
      return {
        title: t,
        from: [...from],
        views: "problem" in answer ? 0 : (answer.data.items[0]?.views ?? 0),
      };
    });
    const ranked = views.filter((v) => v.views > 0).sort((a, b) => b.views - a.views);
    const limit = input.limit ?? 30;
    const ownViews = await get(
      `${REST}/metrics/pageviews/per-article/${language}.wikipedia.org/all-access/user/${encodeURIComponent(page.replaceAll(" ", "_"))}/monthly/${start}/${end}`,
      PerArticle,
    );
    const own = "problem" in ownViews ? undefined : ownViews.data.items[0]?.views;
    return text(
      [
        `Around "${page}"${found.asked === page ? "" : ` (asked: ${found.asked})`}, by views in ${start.slice(0, 4)}-${start.slice(4, 6)}${own === undefined ? "" : `; the article itself: ${count(own)}`}:`,
        ...ranked
          .slice(0, limit)
          .map((r, i) => `${String(i + 1)}. ${r.title}: ${count(r.views)} (${r.from.join(", ")})`),
        "",
        `Categories: ${categories.map((c) => c.replace(/^[^:]+:/, "")).join("; ") || "none"}.`,
        `Looked up ${String(candidates.length)} of ${String(sources.size)} related articles.`,
      ].join("\n"),
    );
  },
);

// --- helpers ---

interface Resolved {
  asked: string;
  title: string | undefined;
  suggestions: string[];
}

/** The real titles: normalized, redirects followed; for a missing one, close matches. */
async function resolve(
  language: string,
  asked: string[],
): Promise<{ titles: Resolved[] } | { problem: string }> {
  const answer = await wiki(language, { titles: asked.join("|"), redirects: "1" });
  if ("problem" in answer) return answer;
  const q = answer.data.query;
  const normalized = new Map((q?.normalized ?? []).map((n) => [n.from, n.to]));
  const redirected = new Map((q?.redirects ?? []).map((r) => [r.from, r.to]));
  const pages = new Map((q?.pages ?? []).map((p) => [p.title, p]));
  const titles = await inParallel(asked, async (a): Promise<Resolved> => {
    const n = normalized.get(a) ?? a;
    const t = redirected.get(n) ?? n;
    const page = pages.get(t);
    if (page && !page.missing && !page.invalid) return { asked: a, title: t, suggestions: [] };
    const search = await wiki(language, { list: "search", srsearch: a, srlimit: "3", srprop: "" });
    return {
      asked: a,
      title: undefined,
      suggestions: "problem" in search ? [] : (search.data.query?.search ?? []).map((s) => s.title),
    };
  });
  return { titles };
}

const Parsed = z.object({
  parse: z.object({
    links: z.array(z.object({ ns: z.number(), title: z.string(), exists: z.boolean().optional() })),
  }),
});

const SiteInfo = z.object({
  query: z.object({
    general: z.object({ mainpage: z.string() }).loose(),
    namespaces: z.record(
      z.string(),
      z.object({ id: z.number(), name: z.string(), canonical: z.string().optional() }).loose(),
    ),
    namespacealiases: z.array(z.object({ id: z.number(), alias: z.string() })).optional(),
  }),
});
const known = new Map<string, (article: string) => boolean>();

/** Tells the main page and pages outside the articles (Special:, Wikipedia:, File:…). */
async function systemPages(language: string): Promise<(article: string) => boolean> {
  const cached = known.get(language);
  if (cached) return cached;
  const answer = await get(
    api(language, { meta: "siteinfo", siprop: "general|namespaces|namespacealiases" }),
    SiteInfo,
  );
  // Without the wiki's names, the English ones and "-" still catch the most.
  const names = new Set([
    "special",
    "wikipedia",
    "file",
    "user",
    "talk",
    "category",
    "portal",
    "help",
    "template",
  ]);
  let main = "Main_Page";
  if (!("problem" in answer)) {
    main = answer.data.query.general.mainpage.replaceAll(" ", "_");
    for (const ns of Object.values(answer.data.query.namespaces)) {
      if (ns.id === 0) continue;
      names.add(ns.name.toLowerCase().replaceAll(" ", "_"));
      if (ns.canonical) names.add(ns.canonical.toLowerCase().replaceAll(" ", "_"));
    }
    for (const a of answer.data.query.namespacealiases ?? [])
      names.add(a.alias.toLowerCase().replaceAll(" ", "_"));
  }
  const test = (article: string) => {
    if (article === main || article === "Main_Page" || article === "-") return true;
    const colon = article.indexOf(":");
    return colon > 0 && names.has(article.slice(0, colon).toLowerCase());
  };
  if (!("problem" in answer)) known.set(language, test);
  return test;
}

function api(language: string, params: Record<string, string>, action = "query"): string {
  const base = TEST ? `${TEST}/${language}.wikipedia.org` : `https://${language}.wikipedia.org`;
  const query = new URLSearchParams({ action, format: "json", formatversion: "2", ...params });
  return `${base}/w/api.php?${query.toString()}`;
}

function wiki(language: string, params: Record<string, string>) {
  return get(api(language, params), Query);
}

const cache = new Map<string, { at: number; body: unknown; status: number }>();
/** When each of the last requests left, for the per-minute limit. */
const sent: number[] = [];

async function get<T>(
  url: string,
  schema: z.ZodType<T>,
): Promise<{ data: T } | { problem: string }> {
  const answer = await fetchCached(url);
  if ("problem" in answer) return answer;
  if (answer.status < 200 || answer.status >= 300) {
    const detail = z.object({ detail: z.string() }).safeParse(answer.body);
    return { problem: detail.success ? detail.data.detail : `HTTP ${String(answer.status)}` };
  }
  // The Action API reports some failures, such as ratelimited, with status 200.
  const error = z.object({ error: z.object({ info: z.string() }) }).safeParse(answer.body);
  if (error.success) return { problem: error.data.error.info };
  const parsed = schema.safeParse(answer.body);
  return parsed.success
    ? { data: parsed.data }
    : { problem: "an answer this connector cannot read" };
}

async function fetchCached(
  url: string,
): Promise<{ body: unknown; status: number } | { problem: string }> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  for (let attempt = 0; ; attempt++) {
    await slot();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "user-agent": USER_AGENT,
          "api-user-agent": USER_AGENT,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      return { problem: `Wikimedia did not answer (${String(error)})` };
    }
    if ((res.status === 429 || res.status === 503) && attempt < 2) {
      // Wikimedia says how long to wait; at least five seconds when it does not.
      const header = Number(res.headers.get("retry-after") ?? Number.NaN);
      const wait = Math.min(60, Number.isFinite(header) ? header : 5 * (attempt + 1));
      await new Promise((done) => setTimeout(done, wait * 1000));
      continue;
    }
    if (res.status === 429) {
      return {
        problem:
          "Wikimedia is limiting requests from this server. Wait a minute and ask for less" +
          (CONTACT
            ? "."
            : "; WIKIMEDIA_CONTACT is not set, which lowers the limit to 10 a minute."),
      };
    }
    const body: unknown = await res.json().catch(() => undefined);
    const answer = { at: Date.now(), body, status: res.status };
    // Not found is an answer too (an article without views); errors are not kept.
    if (res.ok || res.status === 404) cache.set(url, answer);
    return answer;
  }
}

/** Waits until a request fits in the per-minute limit. */
async function slot(): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (sent.length > 0 && now - (sent[0] ?? 0) > 60_000) sent.shift();
    if (sent.length < PER_MINUTE) {
      sent.push(now);
      return;
    }
    await new Promise((done) => setTimeout(done, 60_000 - (now - (sent[0] ?? now)) + 50));
  }
}

async function inParallel<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  return out;
}

/** YYYYMMDD bounds: the last `months` full months, or for daily up to yesterday. */
function range(months: number, daily: boolean): { start: string; end: string } {
  const now = new Date();
  const firstOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
  const end = daily
    ? new Date(now.getTime() - 86_400_000)
    : new Date(firstOfMonth.getTime() - 86_400_000);
  return { start: ymd(start), end: ymd(end) };
}

function recentDays(n: number): string[] {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) =>
    new Date(now - (i + 1) * 86_400_000).toISOString().slice(0, 10),
  );
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

function yearBefore(month: string): string {
  return `${String(Number(month.slice(0, 4)) - 1)}${month.slice(4)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function title(article: string): string {
  return article.replaceAll("_", " ");
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

function percent(x: number): string {
  return `${x >= 0 ? "+" : ""}${String(Math.round(x * 100))}%`;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function failure(value: string) {
  return { content: [{ type: "text" as const, text: value }], isError: true };
}

await server.connect(new StdioServerTransport());
