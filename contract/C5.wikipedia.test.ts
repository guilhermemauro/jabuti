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

// C5 for the Wikipedia connector, against a fake Wikimedia: the Pageviews API under
// /rest_v1, the wiki's API under /pt.wikipedia.org/w/api.php. Synthetic counts.
const CONTACT = "owner@synthetic.example";

/** 24 months up to last month: about 100 a month, ten times that in December. */
function months() {
  const now = new Date();
  return Array.from({ length: 24 }, (_, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 24 + i, 1));
    const views = d.getUTCMonth() === 11 ? 1_000 : 100;
    return { timestamp: `${d.toISOString().slice(0, 10).replaceAll("-", "")}00`, views };
  });
}

const VIEWS: Record<string, number> = { Ceia_de_Natal: 900, Papai_Noel: 3_000, Advento: 50 };

function wiki(q: URLSearchParams): object {
  if (q.get("meta") === "siteinfo") {
    return {
      query: {
        general: { mainpage: "Wikipédia:Página principal" },
        namespaces: {
          "-1": { id: -1, name: "Especial", canonical: "Special" },
          "0": { id: 0, name: "" },
          "4": { id: 4, name: "Wikipédia", canonical: "Project" },
        },
        namespacealiases: [{ id: 4, alias: "WP" }],
      },
    };
  }
  if (q.get("action") === "parse") {
    return {
      parse: {
        links: [
          { ns: 0, title: "Advento", exists: true },
          { ns: 0, title: "Ceia de Natal", exists: true },
          { ns: 0, title: "Página que falta", exists: false },
        ],
      },
    };
  }
  if (q.get("list") === "search") {
    return q.get("srsearch")?.startsWith("morelike:")
      ? { query: { search: [{ title: "Papai Noel" }] } }
      : { query: { search: [{ title: "Amigo secreto" }] } };
  }
  if (q.get("list") === "categorymembers") {
    return { query: { categorymembers: [{ title: "Ceia de Natal" }, { title: "Natal" }] } };
  }
  if (q.get("prop") === "categories") {
    return {
      query: {
        pages: [{ title: "Natal", categories: [{ title: "Categoria:Festas de dezembro" }] }],
      },
    };
  }
  // Resolving titles.
  return {
    query: {
      normalized: [{ from: "amigo oculto", to: "Amigo oculto" }],
      redirects: [{ from: "Amigo oculto", to: "Amigo secreto" }],
      pages: [{ title: "Amigo secreto" }, { title: "Natal" }, { title: "Xyz nada", missing: true }],
    },
  };
}

const seen: { url: URL; agent: string }[] = [];
let limited = 0;
const fake = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fake");
  seen.push({ url, agent: req.headers["user-agent"] ?? "" });
  const send = (status: number, body: object, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  if (limited > 0) {
    limited--;
    send(429, { detail: "Too many requests" }, { "retry-after": "0" });
    return;
  }
  const path = url.pathname;
  if (path.endsWith("/w/api.php")) {
    send(200, wiki(url.searchParams));
  } else if (path.includes("/pageviews/top/")) {
    send(200, {
      items: [
        {
          articles: [
            { article: "Wikipédia:Página_principal", views: 90_000 },
            { article: "Especial:Pesquisar", views: 20_000 },
            { article: "Star_Wars:_Episódio_I", views: 8_000 },
            { article: "Black_Friday", views: 5_000 },
          ],
        },
      ],
    });
  } else if (path.includes("/per-article/")) {
    const article = decodeURIComponent(path.split("/")[8] ?? "");
    if (article === "Amigo_secreto") send(200, { items: months() });
    else if (VIEWS[article]) send(200, { items: [{ timestamp: "x", views: VIEWS[article] }] });
    else send(404, { detail: "The date(s) you used are valid, but we either do not have data" });
  } else {
    send(404, { detail: "unknown" });
  }
});

let connector: ConnectorSpec;
beforeAll(async () => {
  await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
  const real = CONNECTORS.find((c) => c.name === "wikipedia");
  if (!real) throw new Error("wikipedia connector missing");
  const port = String((fake.address() as AddressInfo).port);
  connector = { ...real, env: { WIKI_TEST_URL: `http://127.0.0.1:${port}` } };
});
afterAll(() => fake.close());

const clients: Mcp[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((m) => m.close()));
  seen.length = 0;
  limited = 0;
});

function run(tool: string, input: object) {
  const settings = new Settings(openDatabase(":memory:"), randomBytes(32), {});
  settings.saveVariable({ name: "WIKIMEDIA_CONTACT", value: CONTACT, scope: "all", shell: false });
  const mcp = new Mcp([connector], (a, n) => settings.value(a, n));
  clients.push(mcp);
  const script: Script = (_, i) =>
    i === 0 ? { calls: [{ name: `mcp__wikipedia__${tool}`, input }] } : { text: "done" };
  const profile = agent("blog", { mcp: ["wikipedia"] });
  return harness({ script, agents: [profile], mcp, connectors: [connector], settings });
}

const result = async (tool: string, input: object) => {
  const h = run(tool, input);
  await h.turn("go");
  return h.events.flatMap((e) => (e.type === "tool.finished" ? [e] : []))[0];
};

describe("C5: the Wikipedia connector", () => {
  it("lists a month's most read articles without the main and system pages", async () => {
    const r = await result("trending", { date: "2026-10" });
    expect(r?.isError).toBe(false);
    expect(seen.map((s) => s.url.pathname)).toContain(
      "/rest_v1/metrics/pageviews/top/pt.wikipedia.org/all-access/2026/10/all-days",
    );
    expect(r?.content).toContain("1. Star Wars: Episódio I: 8,000\n2. Black Friday: 5,000");
    expect(r?.content).not.toContain("Pesquisar");
    expect(r?.content).not.toContain("Página principal");
    // Wikimedia's rule: a User-Agent with the owner's contact.
    expect(seen.every((s) => s.agent.includes(`(${CONTACT})`))).toBe(true);
  });

  it("follows redirects and finds the season, and suggests a title for a missing one", async () => {
    const r = await result("history", { articles: ["amigo oculto", "Xyz nada"] });
    const text = r?.content ?? "";
    expect(text).toContain("amigo oculto → Amigo secreto: 4,200 views in 24 months");
    expect(text).toContain("Strongest months on average: Dec (+");
    expect(text).toContain("Last 3 months against the same months a year before: +0%");
    expect(text).toContain("Xyz nada: no such article. Did you mean: Amigo secreto?");
  });

  it("ranks the topics around an article by readers, naming where each came from", async () => {
    const r = await result("related", { article: "Natal" });
    const text = r?.content ?? "";
    expect(text).toContain("1. Papai Noel: 3,000 (similar)");
    expect(text).toContain("2. Ceia de Natal: 900 (linked from its introduction, same category)");
    expect(text).toContain("3. Advento: 50 (linked from its introduction)");
    expect(text).not.toContain("Página que falta");
    expect(text).toContain("Categories: Festas de dezembro.");
  });

  it("waits and retries when Wikimedia asks it to slow down", async () => {
    limited = 2;
    const r = await result("trending", { date: "2026-10" });
    expect(r?.isError).toBe(false);
    expect(r?.content).toContain("Black Friday");
  });
});
