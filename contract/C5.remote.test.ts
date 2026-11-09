import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../packages/server/src/db/index.ts";
import { Mcp } from "../packages/server/src/mcp/index.ts";
import { McpServers } from "../packages/server/src/mcp/servers.ts";
import { Settings } from "../packages/server/src/settings/index.ts";
import type { Script } from "./fake-model/index.ts";
import { REMOTE_KEY, startRemote, type Remote } from "./fixtures/remote-mcp.ts";
import { agent, harness } from "./harness.ts";

// C5: the owner registers a remote MCP server; agents that list it get only the tools the
// owner turned on, those set to ask wait for approval, and its credentials (a variable in
// a header, or an OAuth login) never reach the model.
const open: { remote: Remote; mcp: Mcp }[] = [];
afterEach(async () => {
  for (const { remote, mcp } of open.splice(0)) {
    await mcp.close();
    await remote.close();
  }
});

async function setup(oauth: boolean) {
  const remote = await startRemote({ oauth });
  const db = openDatabase(":memory:");
  const settings = new Settings(db, randomBytes(32), {});
  settings.saveVariable({ name: "REMOTE_KEY", value: REMOTE_KEY, scope: ["user"], shell: false });
  const servers = new McpServers(db, settings, ["serper"]);
  const problem = servers.save(
    {
      name: "remote",
      description: "A synthetic remote server.",
      url: remote.url,
      headers: oauth ? [] : [{ name: "X-Api-Key", value: "${REMOTE_KEY}" }],
      oauth,
    },
    true,
  );
  expect(problem).toBeUndefined();
  const mcp = new Mcp([], (a, n) => settings.value(a, n), undefined, servers);
  open.push({ remote, mcp });
  return { remote, db, settings, servers, mcp };
}

const calls =
  (...steps: { name: string; input: object }[]): Script =>
  (_, i) => {
    const call = steps[i];
    return call ? { calls: [call] } : { text: "done" };
  };
const names = (tools: unknown) => (tools as { name: string }[]).map((t) => t.name);
const user = agent("user", { mcp: ["remote"] });

describe("C5: remote MCP servers the owner registers", () => {
  it("offers only the tools turned on, asks first where set, keeps the key out", async () => {
    const { remote, servers, mcp, settings } = await setup(false);
    // A built-in connector's name is not free.
    const registered = {
      name: "serper",
      description: "x",
      url: remote.url,
      headers: [],
      oauth: false,
    };
    expect(servers.save(registered, true)).toBeDefined();

    // Listing: read-only tools run directly, the others ask until the owner changes it.
    servers.recordTools("remote", await mcp.discover("remote", ["user"]));
    expect(servers.list()[0]?.tools).toEqual([
      expect.objectContaining({ name: "read_item", readOnly: true, on: true, ask: false }),
      expect.objectContaining({ name: "delete.item", readOnly: false, on: true, ask: true }),
      expect.objectContaining({ name: "hidden", on: true, ask: true }),
    ]);
    servers.setTools("remote", [{ name: "hidden", on: false, ask: true }]);

    const h = harness({
      script: calls(
        { name: "mcp__remote__read_item", input: { id: "1" } },
        { name: "mcp__remote__delete_item", input: { id: "2" } },
      ),
      agents: [user, agent("other")],
      mcp,
      settings,
      approvals: "deny",
    });
    await h.turn("go");
    expect(names(h.model.requests[0]?.tools)).toEqual([
      "shell",
      "mcp__remote__read_item",
      "mcp__remote__delete_item",
    ]);
    expect(h.events).toContainEqual(
      expect.objectContaining({
        type: "approval.requested",
        action: { kind: "mcp", server: "remote", tool: "delete.item", input: '{\n  "id": "2"\n}' },
      }),
    );
    // Denied: the server never saw the delete.
    expect(remote.calls).toEqual(["read_item"]);
    expect(remote.credentials.every((c) => c === REMOTE_KEY)).toBe(true);
    expect(JSON.stringify([h.model.requests, h.events, h.history()])).not.toContain(REMOTE_KEY);

    // An agent that does not list it gets nothing from it.
    const other = harness({ script: calls(), agents: [agent("other")], mcp, settings });
    await other.turn("hi");
    expect(names(other.model.requests[0]?.tools)).toEqual(["shell"]);
  });

  it("logs in with OAuth once, by a single-use state, and keeps the tokens encrypted", async () => {
    const { remote, db, servers, mcp, settings } = await setup(true);

    // Before the login, the agent is told and keeps working.
    const before = harness({ script: calls(), agents: [user], mcp, settings });
    await before.turn("hi");
    expect(before.events).toContainEqual(
      expect.objectContaining({
        type: "notice",
        problem: expect.objectContaining({
          message: "The remote server is not logged in.",
        }) as unknown,
      }),
    );

    const started = await servers.startLogin(
      "remote",
      "http://jabuti.example/api/mcp/oauth/callback",
    );
    if (!("url" in started)) throw new Error("expected a login page");
    // The owner's browser: the provider sends it back to Jabuti's callback.
    const back = new URL(
      (await fetch(started.url, { redirect: "manual" })).headers.get("location") ?? "",
    );
    expect(back.origin + back.pathname).toBe("http://jabuti.example/api/mcp/oauth/callback");
    const state = back.searchParams.get("state") ?? "";
    await expect(servers.finishLogin("forged-state", "code-0")).rejects.toThrow(/expired/);
    expect(await servers.finishLogin(state, back.searchParams.get("code") ?? "")).toEqual({
      name: "remote",
    });
    await expect(servers.finishLogin(state, "code-0")).rejects.toThrow(/expired or was used/);
    expect(servers.list()[0]?.connected).toBe(true);
    const stored = JSON.stringify(db.prepare("SELECT * FROM mcp_oauth").all());
    expect(stored).not.toContain("synthetic-access-token");

    servers.recordTools("remote", await mcp.discover("remote", []));
    const h = harness({
      script: calls({ name: "mcp__remote__read_item", input: {} }),
      agents: [user],
      mcp,
      settings,
    });
    await h.turn("go");
    expect(remote.calls).toEqual(["read_item"]);
    expect(JSON.stringify([h.model.requests, h.events])).not.toContain("synthetic-access-token");

    // Logged out: the next run is told again.
    servers.disconnect("remote");
    expect(servers.list()[0]?.connected).toBe(false);
  });
});
