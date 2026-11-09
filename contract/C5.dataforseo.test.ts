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

// C5 for the DataForSEO connector, against a fake API that checks the Basic login.
// The answers are synthetic, trimmed to the documented shapes.
const LOGIN = "synthetic-login@example.com";
const PASSWORD = "synthetic-api-password";
const AUTH = `Basic ${Buffer.from(`${LOGIN}:${PASSWORD}`).toString("base64")}`;

const ok = (result: object, cost = 0.004) => ({
  status_code: 20000,
  cost,
  tasks: [{ status_code: 20000, status_message: "Ok.", cost, result: [result] }],
});

const SERP = {
  keyword: "amigo secreto",
  location_code: 2076,
  language_code: "pt",
  se_results_count: 1000,
  items: [
    {
      type: "ai_overview",
      rank_absolute: 1,
      items: [
        {
          type: "ai_overview_element",
          text: "Amigo secreto is a synthetic gift exchange.",
          references: [
            { domain: "synthetic.example", url: "https://synthetic.example/guide", title: "Guide" },
            { domain: "other.example", url: "https://other.example/a", title: "Other" },
          ],
        },
      ],
      references: [
        { domain: "synthetic.example", url: "https://synthetic.example/guide", title: "Guide" },
      ],
    },
    {
      type: "people_also_ask",
      rank_absolute: 2,
      items: [
        {
          title: "How many people does it need?",
          expanded_element: [
            { domain: "www.synthetic.example", url: "https://synthetic.example/q" },
          ],
        },
      ],
    },
    {
      type: "organic",
      rank_absolute: 3,
      rank_group: 1,
      domain: "first.example",
      title: "First",
      url: "https://first.example/",
    },
    {
      type: "organic",
      rank_absolute: 4,
      rank_group: 2,
      domain: "www.synthetic.example",
      title: "Ours",
      url: "https://www.synthetic.example/",
    },
    {
      type: "video",
      rank_absolute: 5,
      items: [{ source: "YouTube", title: "Synthetic video", url: "https://video.example/1" }],
    },
    {
      type: "organic",
      rank_absolute: 6,
      rank_group: 3,
      domain: "third.example",
      title: "Third",
      url: "https://third.example/",
    },
  ],
};

const KEYWORDS = {
  items: [
    // Out of order: the table sorts by volume.
    {
      keyword: "como fazer amigo secreto pelo whatsapp com 5 pessoas",
      keyword_info: { search_volume: 90 },
      keyword_properties: {},
      search_intent_info: { main_intent: "informational" },
      serp_info: null,
    },
    {
      keyword: "amigo secreto online",
      keyword_info: { search_volume: 1900, cpc: 0.31 },
      keyword_properties: { keyword_difficulty: 22 },
      search_intent_info: { main_intent: "transactional" },
      serp_info: { serp_item_types: ["organic", "video"] },
    },
  ],
};

const MENTIONS = {
  total_count: 1,
  items: [
    {
      platform: "google",
      question: "what is amigo secreto",
      answer: "A synthetic answer.",
      ai_search_volume: 480,
      sources: [{ domain: "blog.synthetic.example" }, { domain: "wiki.example" }],
    },
  ],
};

const IMAGES = {
  keyword: "amigo secreto",
  items: [
    {
      type: "images_search",
      rank_absolute: 1,
      title: "Amigo secreto: como organizar",
      alt: "Amigos trocando presentes de amigo secreto",
      url: "https://www.synthetic.example/guia",
      source_url: "https://www.synthetic.example/img/amigo-secreto-presentes.jpg",
      encoded_url: "https://thumbs.example/1",
    },
    {
      type: "images_search",
      rank_absolute: 2,
      title: "Presentes para amigo secreto",
      alt: "Caixa de presentes de amigo secreto",
      url: "https://other.example/presentes",
      source_url: "https://other.example/up/presentes_amigo_secreto.webp",
      encoded_url: "https://thumbs.example/2",
    },
    {
      type: "images_search",
      rank_absolute: 3,
      title: "Sorteio online",
      alt: "",
      url: "https://other.example/sorteio",
      source_url: "https://other.example/up/sorteio.webp",
    },
    {
      type: "carousel",
      items: [
        { type: "carousel_element", title: "natal" },
        { type: "carousel_element", title: "empresa" },
      ],
    },
  ],
};

const seen: { path: string; body: unknown[]; auth?: string }[] = [];
let respond: (path: string) => { status: number; body: object } = (path) => ({
  status: 200,
  body: path.includes("/images/")
    ? ok(IMAGES, 0.002)
    : path.includes("/serp/")
      ? ok(SERP)
      : path.includes("llm_mentions")
        ? ok(MENTIONS, 0.103)
        : ok(KEYWORDS, 0.0103),
});
const fake = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
  req.on("end", () => {
    const path = req.url ?? "";
    seen.push({
      path,
      body: JSON.parse(raw || "[]") as unknown[],
      ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
    });
    const { status, body } =
      req.headers.authorization === AUTH
        ? respond(path)
        : { status: 401, body: { status_code: 40100, status_message: "Not authorized." } };
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
});

let connector: ConnectorSpec;
beforeAll(async () => {
  await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
  const real = CONNECTORS.find((c) => c.name === "dataforseo");
  if (!real) throw new Error("dataforseo connector missing");
  const port = String((fake.address() as AddressInfo).port);
  connector = { ...real, env: { DATAFORSEO_API_URL: `http://127.0.0.1:${port}` } };
});
afterAll(() => fake.close());

const clients: Mcp[] = [];
const original = respond;
afterEach(async () => {
  await Promise.all(clients.splice(0).map((m) => m.close()));
  seen.length = 0;
  respond = original;
});

function run(tool: string, input: object, password = PASSWORD) {
  const settings = new Settings(openDatabase(":memory:"), randomBytes(32), {});
  settings.saveVariable({
    name: "DATAFORSEO_LOGIN",
    value: LOGIN,
    scope: ["site-a"],
    shell: false,
  });
  settings.saveVariable({
    name: "DATAFORSEO_PASSWORD",
    value: password,
    scope: ["site-a"],
    shell: false,
  });
  const mcp = new Mcp([connector], (a, n) => settings.value(a, n));
  clients.push(mcp);
  const script: Script = (_, i) =>
    i === 0 ? { calls: [{ name: `mcp__dataforseo__${tool}`, input }] } : { text: "done" };
  return harness({
    script,
    agents: [agent("site-a", { mcp: ["dataforseo"] })],
    mcp,
    connectors: [connector],
    settings,
  });
}

const result = (h: ReturnType<typeof run>) =>
  h.events.flatMap((e) => (e.type === "tool.finished" ? [e] : []))[0];

const BR = { location_code: 2076, language_code: "pt" };

describe("C5: the DataForSEO connector", () => {
  it("reads a results page block by block, with the AI overview's sources and the site's places", async () => {
    const h = run("serp", {
      keyword: "amigo secreto",
      ...BR,
      site: "https://www.synthetic.example/",
    });
    await h.turn("what does Google show?");

    expect(seen[0]?.path).toBe("/v3/serp/google/organic/live/advanced");
    expect(seen[0]?.auth).toBe(AUTH);
    expect(seen[0]?.body).toEqual([
      {
        keyword: "amigo secreto",
        ...BR,
        device: "mobile",
        depth: 10,
        load_async_ai_overview: true,
      },
    ]);

    const text = result(h)?.content ?? "";
    expect(result(h)?.isError).toBe(false);
    expect(text).toContain(
      "Blocks, top to bottom: ai_overview, people_also_ask, organic ×2, video, organic",
    );
    expect(text).toContain("Amigo secreto is a synthetic gift exchange.");
    // Every source once, wherever it is nested; the site's marked.
    expect(text).toContain("Sources (2):");
    expect(text.match(/https:\/\/synthetic\.example\/guide/g)).toHaveLength(1);
    expect(text).toContain("- other.example: Other https://other.example/a");
    expect(text).toContain(
      "How many people does it need? (answered by www.synthetic.example ← your site)",
    );
    expect(text).toContain("- YouTube: Synthetic video https://video.example/1");
    expect(text).toContain("organic 2: Ours  ← your site");
    expect(text).toContain(
      "synthetic.example: cited by the AI overview (1×); organic #2 (https://www.synthetic.example/).",
    );
    expect(text).toContain("Cost: US$ 0.0040");

    // The login never reaches the model.
    const visible = JSON.stringify([h.model.requests, h.events]);
    expect(visible).not.toContain(PASSWORD);
    expect(visible).not.toContain(AUTH);
  });

  it("researches keywords: ideas from seeds, the long tail of one, or the keywords given", async () => {
    const ideas = run("keywords", { mode: "ideas", keywords: ["amigo secreto"], ...BR, limit: 30 });
    await ideas.turn("go");
    expect(seen[0]?.path).toBe("/v3/dataforseo_labs/google/keyword_ideas/live");
    expect(seen[0]?.body).toEqual([
      {
        ...BR,
        include_serp_info: true,
        keywords: ["amigo secreto"],
        limit: 30,
        order_by: ["keyword_info.search_volume,desc"],
      },
    ]);
    const text = result(ideas)?.content ?? "";
    expect(text).toContain(
      "amigo secreto online | 1900 | 22 | 0.31 | transactional | organic, video",
    );
    expect(text).toContain(
      "como fazer amigo secreto pelo whatsapp com 5 pessoas | 90 | ? | ? | informational | ?",
    );
    expect(text.indexOf("| 1900 |")).toBeLessThan(text.indexOf("| 90 |"));
    expect(text).toContain("Cost: US$ 0.0103");

    seen.length = 0;
    const tail = run("keywords", { mode: "suggestions", keywords: ["amigo secreto"], ...BR });
    await tail.turn("go");
    expect(seen[0]?.path).toBe("/v3/dataforseo_labs/google/keyword_suggestions/live");
    expect(seen[0]?.body).toEqual([
      expect.objectContaining({ keyword: "amigo secreto", limit: 50 }),
    ]);

    seen.length = 0;
    const exact = run("keywords", { mode: "overview", keywords: ["a", "b"], ...BR });
    await exact.turn("go");
    expect(seen[0]?.path).toBe("/v3/dataforseo_labs/google/keyword_overview/live");
    expect(seen[0]?.body).toEqual([{ ...BR, include_serp_info: true, keywords: ["a", "b"] }]);
  });

  it("finds AI answers citing a domain or a topic, and marks the domain among their sources", async () => {
    const h = run("ai_mentions", {
      domain: "www.synthetic.example",
      topic: "amigo secreto",
      ...BR,
    });
    await h.turn("go");
    expect(seen[0]?.path).toBe("/v3/ai_optimization/llm_mentions/search_mentions/live");
    expect(seen[0]?.body).toEqual([
      {
        target: [
          { domain: "synthetic.example", search_filter: "include" },
          { keyword: "amigo secreto", search_filter: "include" },
        ],
        platform: "google",
        ...BR,
        limit: 20,
        order_by: ["ai_search_volume,desc"],
      },
    ]);
    const text = result(h)?.content ?? "";
    expect(text).toContain("Q: what is amigo secreto (about 480/month)");
    // A subdomain is the site too.
    expect(text).toContain("Sources: blog.synthetic.example ← cited, wiki.example");
    expect(text).toContain("Cost: US$ 0.1030");

    const neither = run("ai_mentions", { ...BR });
    await neither.turn("go");
    expect(result(neither)).toMatchObject({ isError: true });
  });

  it("reads Google Images: the patterns in alt texts, titles and file names, and thumbnails to view", async () => {
    const h = run("images", { keyword: "amigo secreto", ...BR, thumbnails: 2 });
    await h.turn("go");
    expect(seen[0]?.path).toBe("/v3/serp/google/images/live/advanced");
    expect(seen[0]?.body).toEqual([{ keyword: "amigo secreto", ...BR, depth: 40 }]);
    const text = result(h)?.content ?? "";
    expect(text).toContain('Google Images for "amigo secreto" (desktop): 3 images.');
    expect(text).toContain("- Words in alt texts: amigo (2), presentes (2), secreto (2)");
    expect(text).toContain("- Words in file names: amigo (2), presentes (2), secreto (2)");
    expect(text).toContain("- File types: webp (2), jpg (1)");
    expect(text).toContain("- Without alt text: 1 of 3");
    expect(text).toContain("- Sites: other.example (2), synthetic.example (1)");
    expect(text).toContain("- Google's refinements: natal, empresa");
    expect(text).toContain(
      '1. Amigo secreto: como organizar | alt: "Amigos trocando presentes de amigo secreto" | synthetic.example | amigo-secreto-presentes.jpg',
    );
    expect(text).toContain("3. Sorteio online | alt: none | other.example | sorteio.webp");
    expect(text).toContain(
      "For view_images (the top 2, in order):\nhttps://thumbs.example/1\nhttps://thumbs.example/2\n",
    );
    expect(text).toContain("Cost: US$ 0.0020");
  });

  it("explains a refused login, an empty balance and a failed task", async () => {
    const refused = run("serp", { keyword: "x", ...BR }, "wrong-password");
    await refused.turn("go");
    expect(result(refused)).toMatchObject({ isError: true });
    expect(result(refused)?.content).toContain("the API password, not the account's");

    respond = () => ({
      status: 200,
      body: {
        status_code: 20000,
        tasks: [{ status_code: 40210, status_message: "Insufficient funds." }],
      },
    });
    const broke = run("keywords", { mode: "overview", keywords: ["x"], ...BR });
    await broke.turn("go");
    expect(result(broke)?.content).toBe(
      "DataForSEO: Insufficient funds. (40210). Check the balance in the DataForSEO dashboard.",
    );

    respond = () => ({
      status: 200,
      body: {
        status_code: 20000,
        tasks: [{ status_code: 40501, status_message: "Invalid Field: 'location_code'." }],
      },
    });
    const bad = run("serp", { keyword: "x", location_code: 1, language_code: "pt" });
    await bad.turn("go");
    expect(result(bad)).toMatchObject({ isError: true });
    expect(result(bad)?.content).toContain("Invalid Field: 'location_code'. (40501)");
  });
});
