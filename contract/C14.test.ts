import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentState,
  STATE_LIMIT,
  SUMMARY_LIMIT,
  SUMMARY_TARGET,
} from "../packages/server/src/agents/state.ts";
import type { Script } from "./fake-model/index.ts";
import { agent, harness } from "./harness.ts";

// Synthetic fixtures only: no real site or client data.
const BRIEF = "Site: synthetic-shop.example. Conversion: newsletter signup.";

const site = agent("site", { tools: ["shell", "memory"], permissions: { shell: "auto" } });

function tempState() {
  const dir = mkdtempSync(join(tmpdir(), "jabuti-c14-"));
  const state = new AgentState(dir);
  state.writeBrief("site", BRIEF);
  return { dir, state };
}

/** Each request makes the next memory call; then it answers. */
const memory =
  (...inputs: object[]): Script =>
  (_, i) => {
    const input = inputs[i];
    return input ? { calls: [{ name: "memory", input }] } : { text: "ok" };
  };

const toolNames = (tools: unknown) => (tools as { name: string }[]).map((t) => t.name);

/** A second conversation of the same harness, to see what it starts with. */
async function nextConversation(h: ReturnType<typeof harness>, name = "site") {
  const next = h.runtime.create(name);
  if (!("id" in next)) throw new Error(next.message);
  h.runtime.send(next.id, "hi");
  await h.runtime.idle(next.id);
  return h.model.requests.at(-1)?.system ?? "";
}

const results = (h: ReturnType<typeof harness>) =>
  h.events.flatMap((e) => (e.type === "tool.finished" ? [e] : []));

describe("C14: an agent keeps a brief and notes across conversations", () => {
  it("keeps notes as files it indexes itself, with the id, date and source it sets", async () => {
    const { dir, state } = tempState();
    const create = {
      op: "create",
      summary: "FAQ added to the home page for 'synthetic query'",
      body: "Baseline: 14 impressions, position 74 (28 days to 2026-01-01).",
      check: "2099-01-01",
    };
    const h = harness({ script: memory(create), agents: [site], state });
    await h.turn("remember the experiment");

    // The agent's own note: saved at once, no approval.
    expect(h.events.some((e) => e.type === "approval.requested")).toBe(false);
    const [note] = state.notes("site");
    expect(note).toMatchObject({
      id: "m-0001",
      source: "chat",
      conversation: h.conversationId,
      summary: create.summary,
      check: "2099-01-01",
      date: new Date().toISOString().slice(0, 10),
    });
    expect(note?.path).toBe("memories/m-0001-faq-added-to-the-home-page-for-synthetic.md");
    expect(readFileSync(join(dir, "site", note?.path ?? ""), "utf8")).toContain(create.body);
    expect(readFileSync(join(dir, "site", "index.md"), "utf8")).toBe(
      `- ${note?.date ?? ""} m-0001 [chat] ${create.summary} · check 2099-01-01 → ${note?.path ?? ""}\n`,
    );

    // The model cannot claim a source, or write the index.
    const tool = (h.model.requests[0]?.tools as { name: string; inputSchema: object }[]).find(
      (t) => t.name === "memory",
    );
    expect(JSON.stringify(tool?.inputSchema)).not.toContain('"source"');
    const forged = harness({
      script: memory({ op: "create", summary: "x", source: "owner" }),
      agents: [site],
      state,
    });
    await forged.turn("forge");
    expect(results(forged)[0]?.isError).toBe(true);
    expect(state.notes("site")).toHaveLength(1);

    // The next conversation sees the index line, not the body.
    const system = await nextConversation(h);
    expect(system).toContain(`m-0001 [chat] ${create.summary} · check 2099-01-01`);
    expect(system).not.toContain("Baseline: 14 impressions");
  });

  it("sees what it noted as of the conversation's start, and reads and searches the rest", async () => {
    const { state } = tempState();
    const h = harness({
      script: memory(
        { op: "create", summary: "Synthetic fact.", body: "Detail: 42 rows." },
        { op: "read", id: "m-0001" },
        { op: "search", text: "42 ROWS" },
      ),
      agents: [site],
      state,
    });
    await h.turn("remember this");
    const [first, ...rest] = h.model.requests;
    expect(first?.system).toContain(BRIEF);
    expect(first?.system).not.toContain("Synthetic fact.");
    // Saved mid-conversation, yet the prefix does not move (C7).
    for (const request of rest) expect(request.system).toBe(first?.system);
    const [, read, search] = results(h);
    expect(read?.content).toContain("Detail: 42 rows.");
    expect(read?.content).toContain("source: chat");
    expect(search?.content).toContain("m-0001 [chat] Synthetic fact.");
    expect(await nextConversation(h)).toContain("Synthetic fact.");
  });

  it("lists the notes due by the conversation's start first", async () => {
    const { state } = tempState();
    state.createNote(
      "site",
      { summary: "Check the synthetic test.", body: "", check: "2000-01-01" },
      { source: "chat" },
    );
    state.createNote(
      "site",
      { summary: "Later test.", body: "", check: "2999-01-01" },
      { source: "chat" },
    );
    const h = harness({ script: () => ({ text: "ok" }), agents: [site], state });
    await h.turn("hi");
    const due = (h.model.requests[0]?.system ?? "").split("# Due by today")[1] ?? "";
    expect(due).toContain("m-0001 [chat] Check the synthetic test.");
    expect(due).not.toContain("Later test.");
  });

  it("changes the owner's notes only after approval, the agent's freely, and keeps every old version", async () => {
    const { dir, state } = tempState();
    state.createNote("site", { summary: "Never promise free.", body: "" }, { source: "owner" });
    state.createNote("site", { summary: "Own finding.", body: "" }, { source: "chat" });
    const h = harness({
      script: memory(
        { op: "update", id: "m-0001", summary: "Promise free." },
        { op: "delete", id: "m-0001" },
        { op: "update", id: "m-0002", summary: "Own finding, revised." },
        { op: "delete", id: "m-0002" },
      ),
      agents: [site],
      state,
      approvals: "deny",
    });
    await h.turn("tidy your notes");

    const asked = h.events.flatMap((e) => (e.type === "approval.requested" ? [e.action] : []));
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({ kind: "file", file: "memories/m-0001-never-promise-free.md" });
    expect(JSON.stringify(asked[0])).toContain("+ summary: Promise free.");
    expect(state.note("site", "m-0001")?.summary).toBe("Never promise free.");
    // Its own note: changed and deleted without asking, every version kept.
    expect(state.note("site", "m-0002")).toBeUndefined();
    const history = readdirSync(join(dir, "site", "memories", ".history"));
    expect(history.filter((f) => f.startsWith("m-0002-"))).toHaveLength(2);
    const kept = history.map((f) =>
      readFileSync(join(dir, "site", "memories", ".history", f), "utf8"),
    );
    expect(kept.some((t) => t.includes("summary: Own finding.\n"))).toBe(true);
    expect(kept.some((t) => t.includes("summary: Own finding, revised."))).toBe(true);
    // A deleted note's id is never given again.
    expect(
      state.createNote("site", { summary: "New.", body: "" }, { source: "chat" }),
    ).toMatchObject({ id: "m-0003" });
  });

  it("changes the brief only after the user approves a diff, even when the shell is auto", async () => {
    const { state } = tempState();
    const h = harness({
      script: memory({ op: "replace", file: "brief", content: "new line" }),
      agents: [site],
      state,
      approvals: "deny",
    });
    await h.turn("rewrite the brief");
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: "approval.requested",
        action: expect.objectContaining({ kind: "file", file: "brief.md" }) as object,
      }),
    );
    expect(state.readBrief("site")).toBe(BRIEF);
  });

  it("refuses what is over a limit instead of cutting it", async () => {
    const { state } = tempState();
    const h = harness({
      script: memory(
        { op: "replace", file: "brief", content: "x".repeat(STATE_LIMIT + 1) },
        { op: "create", summary: "y".repeat(SUMMARY_LIMIT + 1) },
        { op: "create", summary: "two\nlines" },
        // Over the target the model is asked for, within the limit: kept.
        { op: "create", summary: "z".repeat(SUMMARY_TARGET + 10) },
      ),
      agents: [site],
      state,
    });
    await h.turn("remember this");
    expect(h.events.some((e) => e.type === "approval.requested")).toBe(false);
    expect(results(h).map((r) => r.isError)).toEqual([true, true, true, false]);
    expect(state.readBrief("site")).toBe(BRIEF);
    expect(state.notes("site").map((n) => n.summary)).toEqual(["z".repeat(SUMMARY_TARGET + 10)]);
  });

  it("turns an old memory.md into the owner's notes, once", () => {
    const { dir, state } = tempState();
    mkdirSync(join(dir, "site"), { recursive: true });
    writeFileSync(join(dir, "site", "memory.md"), "- First fact.\n- Second fact.\n");
    expect(
      state
        .notes("site")
        .map((n) => [n.source, n.summary])
        .sort(),
    ).toEqual([
      ["owner", "First fact."],
      ["owner", "Second fact."],
    ]);
    expect(existsSync(join(dir, "site", "memory.md"))).toBe(false);
    expect(state.notes("site")).toHaveLength(2);
  });

  it("gives no brief or notes to an agent without the memory tool", async () => {
    const plain = agent("site", { tools: ["shell"] });
    const h = harness({
      script: () => ({ text: "ok" }),
      agents: [plain],
      state: tempState().state,
    });
    await h.turn("hi");
    expect(h.model.requests[0]?.system).toBe("You are site.");
  });

  it("runs subagents without notes, with the parent's brief to read, in its workspace", async () => {
    const parent = agent("site", {
      tools: ["shell", "delegate", "memory"],
      permissions: { shell: "auto" },
      subagents: ["analyst"],
    });
    const analyst = agent("analyst", {
      system: "You analyze.",
      tools: ["shell", "memory"],
      permissions: { shell: "auto" },
    });
    const script: Script = (request) => {
      const done = request.messages.some((m) => m.parts.some((p) => p.type === "tool_result"));
      if (request.system.startsWith("You analyze.")) {
        return done ? { text: "3 rows" } : { calls: [{ name: "shell", input: { command: "wc" } }] };
      }
      return done
        ? { text: "ok" }
        : { calls: [{ name: "delegate", input: { agent: "analyst", task: "count" } }] };
    };
    const { state } = tempState();
    state.createNote("site", { summary: "Parent's private note.", body: "" }, { source: "chat" });
    const h = harness({ script, agents: [parent, analyst], state });
    await h.turn("analyze");

    const child = h.model.requests.find((r) => r.system.startsWith("You analyze."));
    expect(toolNames(child?.tools)).toEqual(["shell"]);
    // The brief to read (C12), never the notes.
    expect(child?.system).toContain(BRIEF);
    expect(child?.system).not.toContain("Parent's private note.");
    expect(child?.system).not.toContain("Your notes");
    expect(h.sandbox.workspaces).toEqual(["site"]);
  });
});
