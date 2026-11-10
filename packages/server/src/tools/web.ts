// Reading web pages (C20): three tools, each switched on per agent. web_read returns a
// page's main text, for research; page_structure its metadata, headings, calls to
// action and links, for SEO; site_crawl follows a site's internal links, writes them
// to the workspace as CSV and lists what to fix. All run a fixed script (page.py,
// crawl.py) in the agent's own sandbox, with its network and none of its variables,
// never in this server: a page the model picks cannot reach the server or the
// owner's network through them. No model reads the pages on the way: the agent gets
// what the script prints.
import { z } from "zod";
import type { Tool, ToolContext, ToolOutput } from "./types.ts";

/** Where the runner image installs page.py, crawl.py and their libraries. */
const PYTHON = "/opt/jabuti/venv/bin/python /opt/jabuti/page";
const TIMEOUT_SECONDS = 45;
const DEFAULT_CHARS = 12_000;
const MAX_CHARS = 40_000;
/** crawl.py stops fetching at 240 s and reports; this is the margin to write it. */
const CRAWL_TIMEOUT_SECONDS = 300;
const DEFAULT_PAGES = 300;
const MAX_PAGES = 2_000;

const Url = z.string().max(2_000).describe("The page's full address, http:// or https://.");
const MaxChars = z
  .number()
  .int()
  .min(1_000)
  .max(MAX_CHARS)
  .optional()
  .describe(`Cut the result here. Default ${String(DEFAULT_CHARS)}.`);
const Input = z.strictObject({ url: Url, max_chars: MaxChars });
type Input = z.infer<typeof Input>;

/** A web address page.py may fetch, or why not. Credentials in a URL would reach the page. */
export function check(raw: string): { url: string } | { problem: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { problem: `Not a web address: ${raw}. Give the full URL, with https://.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { problem: `Only http:// and https:// pages can be read, not ${url.protocol}` };
  }
  if (url.username || url.password) {
    return { problem: "The address carries a user name or password: remove them." };
  }
  return { url: url.href };
}

/** One argument for sh, whatever it contains. */
export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface Run {
  script: "page.py read" | "page.py structure" | "crawl.py";
  url: string;
  /** After the URL: crawl.py's page limit. */
  extra?: string;
  timeoutSeconds: number;
  maxChars: number;
}

async function run(job: Run, ctx: ToolContext): Promise<ToolOutput> {
  const permission = ctx.shellPermission();
  if (permission === "deny") {
    return {
      content: "The shell is disabled for this agent: it cannot read pages.",
      isError: true,
    };
  }
  const checked = check(job.url);
  if ("problem" in checked) return { content: checked.problem, isError: true };
  const command = `${PYTHON}/${job.script} ${quote(checked.url)}${job.extra ? ` ${job.extra}` : ""}`;
  // A command in the agent's sandbox like any other: in ask mode, the owner sees it first.
  if (permission === "ask") {
    const approved = await ctx.requestApproval({ kind: "shell", command });
    if (!approved) return { content: "The user denied this command.", isError: true };
  }
  if (ctx.signal.aborted) return { content: "Cancelled by the user.", isError: true };
  let result;
  try {
    result = await ctx.sandbox.exec(ctx.workspace, command, {
      timeoutSeconds: job.timeoutSeconds,
      env: {},
      signal: ctx.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { content: "Cancelled by the user.", isError: true };
    }
    return {
      content: `The sandbox could not read the page: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
  if (result.timedOut) {
    return {
      content: `${checked.url} took over ${String(job.timeoutSeconds)}s: try again later.`,
      isError: true,
    };
  }
  if (
    result.exitCode === 127 ||
    result.output.slice(0, 300).includes("No such file or directory")
  ) {
    return {
      content:
        `This sandbox has no ${job.script.split(" ")[0] ?? ""}: it needs the current runner image. ` +
        "Tell the owner to rebuild the runner (docker compose build runner).",
      isError: true,
    };
  }
  const output = result.output.trim();
  const limit = job.maxChars;
  const content =
    output.length <= limit
      ? output
      : `${output.slice(0, limit)}\n[cut at ${String(limit)} of ${String(output.length)} characters; ` +
        `max_chars up to ${String(MAX_CHARS)} shows more]`;
  return { content, isError: result.exitCode !== 0 };
}

export const webReadTool: Tool<Input> = {
  name: "web_read",
  description: () =>
    "Read a web page's main text as Markdown, without menus, ads or scripts, with its " +
    "title and description: to research a topic, or to learn what a site, product or " +
    "competitor offers. Its links are kept inline. It does not run JavaScript; a page " +
    "built only in the browser comes back nearly empty. For calls to action, links and " +
    "headings, use page_structure. Figures a page reports are its source's: say whose, " +
    "from when and where, before applying them to another site or market.",
  input: Input,
  execute: (input, ctx) => run(page("read", input), ctx),
};

export const pageStructureTool: Tool<Input> = {
  name: "page_structure",
  description: () =>
    "Read how a web page is built: title, meta description, canonical, robots, Open " +
    "Graph, images without alt text, the H1 to H3 outline, its calls to action (buttons " +
    "and links styled as buttons) and its internal and external links, each with its " +
    "text, where it points and the region it is in (header, nav, main, footer). For " +
    "SEO, internal linking and finding a site's CTAs. It does not run JavaScript.",
  input: Input,
  execute: (input, ctx) => run(page("structure", input), ctx),
};

function page(mode: "read" | "structure", input: Input): Run {
  return {
    script: `page.py ${mode}`,
    url: input.url,
    timeoutSeconds: TIMEOUT_SECONDS,
    maxChars: input.max_chars ?? DEFAULT_CHARS,
  };
}

const CrawlInput = z.strictObject({
  url: Url.describe("Where the crawl starts, usually the home page: its full address."),
  max_pages: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGES)
    .optional()
    .describe(`Stop after this many pages. Default ${String(DEFAULT_PAGES)}.`),
});
type CrawlInput = z.infer<typeof CrawlInput>;

export const siteCrawlTool: Tool<CrawlInput> = {
  name: "site_crawl",
  description: () =>
    "Crawl a site's internal links from a start page, plus the pages only its sitemap " +
    "lists, within robots.txt, for internal linking. Writes crawl/<host>/pages.csv (status, " +
    "redirect, clicks from the start, links in and out, title, H1, words, canonical, " +
    "noindex) and links.csv (source, target, anchor, region) in your workspace, and lists " +
    "what to fix: broken links, links through redirects, orphans, pages linked only from " +
    "menus, deep pages, generic anchors, one anchor for several pages, duplicate titles, " +
    "pages kept out of the index. Analyze the CSVs with the shell for the rest, such as " +
    "topic clusters and which posts should link to a new one. Up to 4 minutes; it does " +
    "not run JavaScript.",
  input: CrawlInput,
  execute: (input, ctx) =>
    run(
      {
        script: "crawl.py",
        url: input.url,
        extra: String(input.max_pages ?? DEFAULT_PAGES),
        timeoutSeconds: CRAWL_TIMEOUT_SECONDS,
        maxChars: MAX_CHARS,
      },
      ctx,
    ),
};
