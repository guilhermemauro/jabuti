// Remote MCP servers the owner registers (C5): the only writer of mcp_servers and
// mcp_oauth. A server is a URL, headers whose ${NAME} parts come from the agent's
// variables (C16), or an OAuth login, and the owner's choice of tools: which agents get,
// and which ask before each call. Nothing of a third party runs here: only requests to
// the URL. The connections themselves belong to mcp/index.ts.
//
// OAuth follows the MCP authorization spec through the SDK (discovery, dynamic client
// registration, PKCE, refresh). One login per server, shared by the agents that list it:
// for two accounts, register the server twice. Tokens and the registered client are
// encrypted with the settings key. The login is started from the settings screen; the
// callback is a top-level navigation from the provider's site, which does not carry the
// owner's SameSite=Strict cookie, so it is authenticated by its state: random, single
// use, kept in memory for ten minutes after the owner's session asked for it.
//
// Accepted: servers without dynamic client registration (a pre-registered OAuth app,
// such as GitHub's) need a token in a header instead; a login in progress is lost on
// restart.
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  MCP_SERVER_NAME,
  McpServerInput,
  type ConnectorInfo,
  type McpServerInfo,
  type McpToolRule,
  type Problem,
} from "@jabuti/protocol";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";

const LOGIN_TTL_MS = 10 * 60_000;
const VARIABLE = /\$\{([A-Z_][A-Z0-9_]{0,63})\}/g;
/** Set by the transport, or by OAuth. */
const RESERVED_HEADERS = new Set([
  "host",
  "content-type",
  "content-length",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
]);

/** A registered server as mcp/index.ts connects to it. */
export interface RemoteSpec {
  name: string;
  description: string;
  url: string;
  headers: { name: string; value: string }[];
  oauth: boolean;
  tools: McpToolRule[];
  /** Variables its headers name. */
  variables: string[];
  /** Changes whenever the server or its login does: open connections restart. */
  stamp: string;
}

/** A listed tool, before the owner's choices. */
export interface ListedTool {
  name: string;
  description: string;
  readOnly: boolean;
}

interface Row {
  name: string;
  description: string;
  url: string;
  headers: string;
  oauth: number;
  tools: string;
  listed_at: string | null;
  updated_at: string;
}

const Stored = z.object({
  client: z.record(z.string(), z.unknown()).optional(),
  /** The redirect URL the client was registered with: another one registers again. */
  redirect: z.string().optional(),
  tokens: z.record(z.string(), z.unknown()).optional(),
});
type Stored = z.infer<typeof Stored>;

interface Login {
  name: string;
  redirect: string;
  verifier: string;
  expires: number;
}

export interface Secrets {
  seal(aad: string, plain: string): string;
  unseal(aad: string, stored: string): string | undefined;
}

export class McpServers {
  private readonly db: DatabaseSync;
  private readonly secrets: Secrets;
  /** The built-in connectors' names, which a registered server may not take. */
  private readonly reserved: readonly string[];
  private readonly logins = new Map<string, Login>();
  private readonly now: () => number;

  constructor(
    db: DatabaseSync,
    secrets: Secrets,
    reserved: readonly string[],
    now: () => number = Date.now,
  ) {
    this.db = db;
    this.secrets = secrets;
    this.reserved = reserved;
    this.now = now;
  }

  list(): McpServerInfo[] {
    return this.rows().map((row) => this.info(row));
  }

  specs(): RemoteSpec[] {
    return this.rows().map((row) => {
      const info = this.info(row);
      const login = this.db
        .prepare("SELECT updated_at FROM mcp_oauth WHERE name = ?")
        .get(row.name) as { updated_at: string } | undefined;
      return {
        name: info.name,
        description: info.description,
        url: info.url,
        headers: info.headers,
        oauth: info.oauth,
        tools: info.tools,
        variables: info.variables,
        stamp: `${row.updated_at}/${login?.updated_at ?? ""}`,
      };
    });
  }

  /** As agents list them, next to the built-in connectors. */
  connectorInfos(): ConnectorInfo[] {
    return this.list().map((s) => ({
      name: s.name,
      description: s.description,
      variables: s.variables,
      ...(s.oauth && !s.connected
        ? { problem: "Not logged in: connect it in Settings → Connectors." }
        : s.listedAt === undefined
          ? { problem: "Its tools were never listed: list them in Settings → Connectors." }
          : {}),
    }));
  }

  save(raw: McpServerInput, create: boolean): Problem | undefined {
    const parsed = McpServerInput.safeParse(raw);
    if (!parsed.success) return invalid(z.prettifyError(parsed.error));
    const input = parsed.data;
    if (!MCP_SERVER_NAME.test(input.name) || this.reserved.includes(input.name)) {
      return invalid(`"${input.name}" is taken by a built-in connector or not a valid name.`);
    }
    const url = checkUrl(input.url);
    if ("problem" in url) return invalid(url.problem);
    for (const header of input.headers) {
      const name = header.name.toLowerCase();
      if (RESERVED_HEADERS.has(name)) return invalid(`Jabuti sets the ${header.name} header.`);
      if (input.oauth && name === "authorization") {
        return invalid("With OAuth, the login sets Authorization: remove that header.");
      }
    }
    const existing = this.row(input.name);
    if (create && existing) {
      return { message: `A server "${input.name}" exists.`, nextStep: "Pick another name." };
    }
    if (!create && !existing) {
      return { message: `No server "${input.name}".`, nextStep: "Reload settings." };
    }
    const at = new Date(this.now()).toISOString();
    this.db
      .prepare(
        `INSERT INTO mcp_servers (name, description, url, headers, oauth, tools, listed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '[]', NULL, ?)
         ON CONFLICT (name) DO UPDATE SET description = excluded.description, url = excluded.url,
           headers = excluded.headers, oauth = excluded.oauth, updated_at = excluded.updated_at`,
      )
      .run(
        input.name,
        input.description,
        url.url,
        JSON.stringify(input.headers),
        input.oauth ? 1 : 0,
        at,
      );
    // Another address or no OAuth: the old login is not for it.
    if (existing && (existing.url !== url.url || !input.oauth)) this.disconnect(input.name);
    return undefined;
  }

  remove(name: string): Problem | undefined {
    if (!this.row(name)) return { message: `No server "${name}".`, nextStep: "Reload settings." };
    this.db.prepare("DELETE FROM mcp_servers WHERE name = ?").run(name);
    this.db.prepare("DELETE FROM mcp_oauth WHERE name = ?").run(name);
    return undefined;
  }

  /**
   * The tools the server lists now, keeping the owner's choices. A new tool is on, and
   * asks first unless the server says it only reads.
   */
  recordTools(name: string, listed: ListedTool[]): void {
    const row = this.row(name);
    if (!row) return;
    const before = rules(row.tools);
    const tools = listed.map((tool) => {
      const old = before.find((r) => r.name === tool.name);
      return {
        ...tool,
        on: old?.on ?? true,
        ask: old?.ask ?? !tool.readOnly,
      };
    });
    const at = new Date(this.now()).toISOString();
    this.db
      .prepare("UPDATE mcp_servers SET tools = ?, listed_at = ?, updated_at = ? WHERE name = ?")
      .run(JSON.stringify(tools), at, at, name);
  }

  setTools(
    name: string,
    choices: { name: string; on: boolean; ask: boolean }[],
  ): Problem | undefined {
    const row = this.row(name);
    if (!row) return { message: `No server "${name}".`, nextStep: "Reload settings." };
    const tools = rules(row.tools).map((tool) => {
      const choice = choices.find((c) => c.name === tool.name);
      return choice ? { ...tool, on: choice.on, ask: choice.ask } : tool;
    });
    this.db
      .prepare("UPDATE mcp_servers SET tools = ?, updated_at = ? WHERE name = ?")
      .run(JSON.stringify(tools), new Date(this.now()).toISOString(), name);
    return undefined;
  }

  // --- OAuth ---

  /**
   * For a connection during a run: tokens and refresh only. A login it would need
   * fails the connection instead of redirecting anyone.
   */
  runProvider(name: string): OAuthClientProvider {
    const stored = this.stored(name);
    return this.provider(name, stored.redirect ?? "http://localhost/unused", undefined, () => {
      throw new Error(`Not logged in to ${name}: connect it in Settings → Connectors.`);
    });
  }

  /** The page to open in the owner's browser, or connected already (a refresh did it). */
  async startLogin(name: string, redirect: string): Promise<{ url: string } | { connected: true }> {
    const row = this.row(name);
    if (!row?.oauth) throw new Error(`No OAuth server "${name}".`);
    this.expire();
    let opened: URL | undefined;
    const state = randomBytes(24).toString("base64url");
    let verifier = "";
    const provider = this.provider(
      name,
      redirect,
      { state, onVerifier: (v) => (verifier = v) },
      (url) => {
        opened = url;
      },
    );
    const result = await auth(provider, { serverUrl: row.url });
    if (result === "AUTHORIZED") return { connected: true };
    if (!opened) throw new Error("The server gave no login page.");
    this.logins.set(state, { name, redirect, verifier, expires: this.now() + LOGIN_TTL_MS });
    return { url: opened.href };
  }

  /** The callback: the state names the login the owner started; it is used once. */
  async finishLogin(state: string, code: string): Promise<{ name: string }> {
    this.expire();
    const login = this.logins.get(state);
    this.logins.delete(state);
    if (!login) throw new Error("This login link expired or was used: connect again.");
    const row = this.row(login.name);
    if (!row) throw new Error(`The server ${login.name} was removed.`);
    const provider = this.provider(login.name, login.redirect, {
      state,
      verifier: login.verifier,
    });
    const result = await auth(provider, { serverUrl: row.url, authorizationCode: code });
    if (result !== "AUTHORIZED") throw new Error("The server did not accept the login.");
    return { name: login.name };
  }

  disconnect(name: string): void {
    this.db.prepare("DELETE FROM mcp_oauth WHERE name = ?").run(name);
  }

  private provider(
    name: string,
    redirect: string,
    login: { state: string; verifier?: string; onVerifier?: (v: string) => void } | undefined,
    redirectTo: (url: URL) => void = () => undefined,
  ): OAuthClientProvider {
    let verifier = login?.verifier ?? "";
    const metadata: OAuthClientMetadata = {
      client_name: "Jabuti",
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    return {
      redirectUrl: redirect,
      clientMetadata: metadata,
      ...(login ? { state: () => login.state } : {}),
      clientInformation: () => {
        const stored = this.stored(name);
        // Registered for another address of this instance: register again.
        if (login && stored.redirect !== redirect) return undefined;
        return stored.client as OAuthClientInformationMixed | undefined;
      },
      saveClientInformation: (client) => {
        this.store(name, { ...this.stored(name), client, redirect });
      },
      tokens: () => this.stored(name).tokens as OAuthTokens | undefined,
      saveTokens: (tokens) => {
        this.store(name, { ...this.stored(name), tokens });
      },
      redirectToAuthorization: redirectTo,
      saveCodeVerifier: (v) => {
        verifier = v;
        login?.onVerifier?.(v);
      },
      codeVerifier: () => verifier,
      invalidateCredentials: (scope) => {
        const stored = this.stored(name);
        if (scope === "all") this.disconnect(name);
        else if (scope === "tokens") this.store(name, { ...stored, tokens: undefined });
        else if (scope === "client") this.store(name, { ...stored, client: undefined });
      },
    };
  }

  private stored(name: string): Stored {
    const row = this.db.prepare("SELECT value FROM mcp_oauth WHERE name = ?").get(name) as
      { value: string } | undefined;
    const plain = row ? this.secrets.unseal(`mcp-oauth:${name}`, row.value) : undefined;
    if (!plain) return {};
    const parsed = Stored.safeParse(JSON.parse(plain));
    return parsed.success ? parsed.data : {};
  }

  private store(name: string, value: Stored): void {
    this.db
      .prepare(
        `INSERT INTO mcp_oauth (name, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(
        name,
        this.secrets.seal(`mcp-oauth:${name}`, JSON.stringify(value)),
        new Date(this.now()).toISOString(),
      );
  }

  private expire(): void {
    for (const [state, login] of this.logins) {
      if (login.expires < this.now()) this.logins.delete(state);
    }
  }

  private info(row: Row): McpServerInfo {
    const headers = z
      .array(z.object({ name: z.string(), value: z.string() }))
      .parse(JSON.parse(row.headers));
    return {
      name: row.name,
      description: row.description,
      url: row.url,
      headers,
      oauth: row.oauth === 1,
      connected: row.oauth === 1 && this.stored(row.name).tokens !== undefined,
      tools: rules(row.tools),
      ...(row.listed_at ? { listedAt: row.listed_at } : {}),
      variables: [
        ...new Set(headers.flatMap((h) => [...h.value.matchAll(VARIABLE)].map((m) => m[1] ?? ""))),
      ],
    };
  }

  private rows(): Row[] {
    return this.db.prepare("SELECT * FROM mcp_servers ORDER BY name").all() as unknown as Row[];
  }

  private row(name: string): Row | undefined {
    return this.db.prepare("SELECT * FROM mcp_servers WHERE name = ?").get(name) as Row | undefined;
  }
}

/** A header's value with each ${NAME} replaced; undefined names are reported by the caller. */
export function fill(value: string, lookup: (name: string) => string | undefined): string {
  return value.replace(VARIABLE, (_, name: string) => lookup(name) ?? "");
}

function rules(json: string): McpToolRule[] {
  return z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        readOnly: z.boolean(),
        on: z.boolean(),
        ask: z.boolean(),
      }),
    )
    .parse(JSON.parse(json));
}

/** https, or http on this machine (development); never credentials in the address. */
function checkUrl(raw: string): { url: string } | { problem: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { problem: `Not an address: ${raw}` };
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return { problem: "Use an https:// address." };
  }
  if (url.username || url.password) {
    return { problem: "Put credentials in a header with a variable, not in the address." };
  }
  return { url: url.href };
}

function invalid(message: string): Problem {
  return { message, nextStep: "Fix it and save again." };
}
