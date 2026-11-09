// MCP clients (C5): the only owner of connector processes. One process per agent
// and connector, because credentials are per agent: it receives that agent's
// variables in its environment and nothing else from the server (the SDK passes
// only HOME, PATH and the like). Started at the first turn that needs it, kept for
// later turns, restarted after a crash or when its variables change.
//
// A file a connector returns (an embedded resource, text or binary) is saved in the agent's
// workspace, where its shell reads it; the model gets the path, not the content.
// The name comes from the connector, so it is reduced to plain characters and kept
// under mcp/<server>/.
//
// A connector that fails to start, or crashes, loses its tools and is reported as
// a notice; the agent keeps working with the rest (C5, C11).
//
// Remote servers the owner registered (servers.ts) connect over HTTP, one client per
// agent as well, since their headers carry that agent's variables. They offer only the
// tools the owner turned on, and those set to ask wait for the owner's approval.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { join } from "node:path";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Problem, ToolFile } from "@jabuti/protocol";
import { z } from "zod";
import type { AgentProfile } from "../agents/registry.ts";
import { FILE_CAP, imageType } from "../sandbox/docker.ts";
import type { Tool, ToolContext } from "../tools/types.ts";
import type { ConnectorSpec } from "./catalog.ts";
import { fill, type ListedTool, type McpServers, type RemoteSpec } from "./servers.ts";

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
/** Kept for the model; the trace truncates further. */
const RESULT_CAP = 30_000;

interface Connection {
  client: Client;
  /** The variables it was started with: a change means a restart. */
  fingerprint: string;
  tools: Tool[];
  alive: boolean;
  /** Last lines of stderr, for the notice when it dies. */
  stderr: string;
}

export interface McpTools {
  tools: Tool[];
  problems: Problem[];
}

export class Mcp {
  private readonly catalog: readonly ConnectorSpec[];
  /** A variable's value for an agent, if in its scope (C16). */
  private readonly value: (agent: string, name: string) => string | undefined;
  private readonly connections = new Map<string, Promise<Connection>>();

  /** Where connectors keep their per-agent folders (ConnectorSpec.state). */
  private readonly stateDir: string | undefined;
  /** The remote servers the owner registered; none in tests that do not need them. */
  private readonly servers: McpServers | undefined;

  constructor(
    catalog: readonly ConnectorSpec[],
    value: (agent: string, name: string) => string | undefined,
    stateDir?: string,
    servers?: McpServers,
  ) {
    this.catalog = catalog;
    this.value = value;
    this.stateDir = stateDir;
    this.servers = servers;
  }

  /**
   * Connects once, outside any run, and lists the server's tools for the owner to
   * choose from. Its headers take the variables of the first agent that lists it, or
   * those for all agents.
   */
  async discover(name: string, agents: readonly string[]): Promise<ListedTool[]> {
    const spec = this.servers?.specs().find((s) => s.name === name);
    if (!spec) throw new Error(`No server "${name}".`);
    const agent = agents[0] ?? "";
    const missing = spec.variables.filter((v) => !this.value(agent, v));
    if (missing.length > 0) {
      throw new Error(
        `It needs ${missing.join(", ")}${agent ? ` for ${agent}` : ""}: add it in Settings → Variables.`,
      );
    }
    const client = await this.remote(spec, this.headers(spec, agent));
    try {
      const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
      return listed.tools.map((tool) => ({
        name: tool.name,
        description: (tool.description ?? "").slice(0, 1_000),
        readOnly: tool.annotations?.readOnlyHint === true,
      }));
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /** Closes a server's connections: its settings or login changed. */
  async forget(name: string): Promise<void> {
    for (const [key, connection] of this.connections) {
      if (!key.endsWith(`/${name}`)) continue;
      this.connections.delete(key);
      const ready = await connection.catch(() => undefined);
      await ready?.client.close().catch(() => undefined);
    }
  }

  /** The connector tools for one run of an agent, in profile order (C7). */
  async tools(agent: AgentProfile): Promise<McpTools> {
    const tools: Tool[] = [];
    const problems: Problem[] = [];
    const remote = this.servers?.specs() ?? [];
    for (const name of agent.mcp) {
      const server = remote.find((s) => s.name === name);
      if (server) {
        const problem = await this.addRemote(agent.name, server, tools);
        if (problem) problems.push(problem);
        continue;
      }
      const spec = this.catalog.find((c) => c.name === name);
      if (!spec) {
        problems.push({
          message: `Agent ${agent.name} lists unknown connector "${name}".`,
          nextStep: "Remove it in Settings → Tools.",
        });
        continue;
      }
      const missing = spec.variables.filter((v) => !this.value(agent.name, v));
      if (missing.length > 0) {
        problems.push({
          message: `The ${name} connector needs ${missing.join(", ")} for ${agent.name}.`,
          nextStep: `Add it in Settings → Variables, with ${agent.name} in its scope.`,
        });
        continue;
      }
      try {
        tools.push(...(await this.connection(agent.name, spec)).tools);
      } catch (error) {
        problems.push({
          message: `The ${name} connector did not start: ${message(error)}`,
          nextStep: "It is retried on the next message. Check the server log if it persists.",
        });
      }
    }
    return { tools, problems };
  }

  async close() {
    const all = await Promise.allSettled(this.connections.values());
    this.connections.clear();
    for (const c of all) if (c.status === "fulfilled") await c.value.client.close();
  }

  /** A registered server's tools for this agent, or why it has none. */
  private async addRemote(
    agent: string,
    spec: RemoteSpec,
    tools: Tool[],
  ): Promise<Problem | undefined> {
    if (spec.oauth && !this.servers?.list().find((s) => s.name === spec.name)?.connected) {
      return {
        message: `The ${spec.name} server is not logged in.`,
        nextStep: "Connect it in Settings → Connectors.",
      };
    }
    const missing = spec.variables.filter((v) => !this.value(agent, v));
    if (missing.length > 0) {
      return {
        message: `The ${spec.name} server needs ${missing.join(", ")} for ${agent}.`,
        nextStep: `Add it in Settings → Variables, with ${agent} in its scope.`,
      };
    }
    const key = `${agent}/${spec.name}`;
    const headers = this.headers(spec, agent);
    const fingerprint = JSON.stringify({ headers, stamp: spec.stamp });
    try {
      const existing = this.connections.get(key);
      const ready = await existing?.catch(() => undefined);
      let connection = ready?.alive && ready.fingerprint === fingerprint ? ready : undefined;
      if (!connection) {
        this.connections.delete(key);
        if (ready?.alive) await ready.client.close().catch(() => undefined);
        const started = this.startRemote(spec, headers, fingerprint);
        started.catch(() => this.connections.delete(key));
        this.connections.set(key, started);
        connection = await started;
      }
      tools.push(...connection.tools);
      return undefined;
    } catch (error) {
      return {
        message: `The ${spec.name} server did not answer: ${message(error)}`,
        nextStep:
          "It is retried on the next message. Check its address and login in Settings → Connectors.",
      };
    }
  }

  private headers(spec: RemoteSpec, agent: string): Record<string, string> {
    return Object.fromEntries(
      spec.headers.map((h) => [h.name, fill(h.value, (name) => this.value(agent, name))]),
    );
  }

  /**
   * Streamable HTTP, the current transport. Accepted: a server that only speaks the
   * deprecated SSE transport does not connect; the error says what it answered.
   */
  private async remote(spec: RemoteSpec, headers: Record<string, string>): Promise<Client> {
    const url = new URL(spec.url);
    const options = {
      requestInit: { headers },
      ...(spec.oauth && this.servers ? { authProvider: this.servers.runProvider(spec.name) } : {}),
    };
    const client = new Client({ name: "jabuti", version: "0.1.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(url, options), {
        timeout: CONNECT_TIMEOUT_MS,
      });
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private async startRemote(
    spec: RemoteSpec,
    headers: Record<string, string>,
    fingerprint: string,
  ): Promise<Connection> {
    const client = await this.remote(spec, headers);
    const connection: Connection = { client, fingerprint, tools: [], alive: true, stderr: "" };
    client.onclose = () => {
      connection.alive = false;
    };
    try {
      const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
      const taken = new Set<string>();
      for (const tool of listed.tools) {
        // Only what the owner turned on; a tool listed since then waits for the owner.
        const rule = spec.tools.find((r) => r.name === tool.name && r.on);
        if (!rule) continue;
        const exposed = `mcp__${spec.name}__${tool.name.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(
          0,
          64,
        );
        if (taken.has(exposed)) continue;
        taken.add(exposed);
        connection.tools.push(toTool(spec.name, tool, connection, { exposed, ask: rule.ask }));
      }
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
    return connection;
  }

  private async connection(agent: string, spec: ConnectorSpec): Promise<Connection> {
    const key = `${agent}/${spec.name}`;
    const env = Object.fromEntries(spec.variables.map((v) => [v, this.value(agent, v) ?? ""]));
    const fingerprint = JSON.stringify(env);
    const existing = this.connections.get(key);
    if (existing) {
      const ready = await existing.catch(() => undefined);
      if (ready?.alive && ready.fingerprint === fingerprint) return ready;
      this.connections.delete(key);
      if (ready?.alive) await ready.client.close();
    }
    const state: Record<string, string> = {};
    if (spec.state && this.stateDir)
      state["JABUTI_STATE_DIR"] = join(this.stateDir, agent, spec.state);
    const started = this.start(spec, { ...env, ...state }, fingerprint);
    started.catch(() => this.connections.delete(key));
    this.connections.set(key, started);
    return started;
  }

  private async start(
    spec: ConnectorSpec,
    env: Record<string, string>,
    fingerprint: string,
  ): Promise<Connection> {
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: { ...spec.env, ...env },
      stderr: "pipe",
    });
    const client = new Client({ name: "jabuti", version: "0.1.0" });
    const connection: Connection = { client, fingerprint, tools: [], alive: true, stderr: "" };
    transport.stderr?.on("data", (chunk: Buffer) => {
      connection.stderr = (connection.stderr + chunk.toString("utf8")).slice(-2000);
    });
    client.onclose = () => {
      connection.alive = false;
    };
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
      connection.tools = listed.tools.map((tool) => toTool(spec.name, tool, connection));
    } catch (error) {
      await client.close().catch(() => undefined);
      const detail = connection.stderr.trim().split("\n").at(-1);
      throw new Error(`${message(error)}${detail ? ` (${detail})` : ""}`, { cause: error });
    }
    return connection;
  }
}

/**
 * A connector's tool as a Jabuti tool: `mcp__<server>__<tool>` (C5). A registered
 * server's tool name is reduced to the characters providers accept, and may ask first.
 */
function toTool(
  server: string,
  tool: { name: string; description?: string; inputSchema: Record<string, unknown> },
  connection: Connection,
  options: { exposed?: string; ask?: boolean } = {},
): Tool<Record<string, unknown>> {
  return {
    name: options.exposed ?? `mcp__${server}__${tool.name}`,
    description: () => tool.description ?? "",
    // The connector validates its own arguments; here only "an object".
    input: z.record(z.string(), z.unknown()),
    inputSchema: tool.inputSchema,
    async execute(input, ctx) {
      if (!connection.alive) {
        return {
          content: `The ${server} connector stopped. It restarts on the next message.`,
          isError: true,
        };
      }
      if (options.ask) {
        const approved = await ctx.requestApproval({
          kind: "mcp",
          server,
          tool: tool.name,
          input: JSON.stringify(input, null, 2).slice(0, 8_000),
        });
        if (!approved) return { content: "The user did not approve this call.", isError: true };
        if (ctx.signal.aborted) return { content: "Cancelled by the user.", isError: true };
      }
      try {
        const result = await connection.client.callTool(
          { name: tool.name, arguments: input },
          undefined,
          {
            timeout: CALL_TIMEOUT_MS,
            signal: ctx.signal,
          },
        );
        // Connector output is untrusted: text parts as text, text files to the workspace.
        const parsed = Result.safeParse(result);
        if (!parsed.success)
          return { content: "The connector sent an invalid result.", isError: true };
        let failed = false;
        const parts: string[] = [];
        const files: ToolFile[] = [];
        for (const part of parsed.data.content) {
          if (part.type === "text") {
            parts.push(part.text ?? "");
          } else if (part.type === "resource" && part.resource?.text !== undefined) {
            const saved = await save(server, part.resource.uri, part.resource.text, ctx);
            failed ||= saved.failed;
            parts.push(saved.text);
          } else if (part.type === "resource" && part.resource?.blob !== undefined) {
            // A binary file, such as a generated image: saved as it is, never shown as text.
            const bytes = Buffer.from(part.resource.blob, "base64");
            const saved = await save(server, part.resource.uri, bytes, ctx);
            failed ||= saved.failed;
            parts.push(saved.text);
            // The owner sees a generated image below the call, read back from the workspace.
            if (!saved.failed && imageType(saved.path)) {
              files.push({ workspace: ctx.workspace, path: saved.path });
            }
          } else {
            parts.push(`[${part.type} content omitted]`);
          }
        }
        const text = parts.join("\n");
        return {
          content: text.slice(0, RESULT_CAP),
          isError: failed || (parsed.data.isError ?? false),
          ...(files.length > 0 ? { files } : {}),
        };
      } catch (error) {
        if (ctx.signal.aborted) return { content: "Cancelled by the user.", isError: true };
        // Read again: the process may have died during the call.
        const why = alive(connection) ? message(error) : `it stopped (${message(error)})`;
        return {
          content: `The ${server} connector failed: ${why}. It restarts on the next message.`,
          isError: true,
        };
      }
    },
  };
}

const Result = z.object({
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
      resource: z
        .object({ uri: z.string(), text: z.string().optional(), blob: z.string().optional() })
        .optional(),
    }),
  ),
  isError: z.boolean().optional(),
});

/** Saves one file from a connector in the workspace the shell uses (C5). */
async function save(
  server: string,
  uri: string,
  content: string | Buffer,
  ctx: ToolContext,
): Promise<{ text: string; failed: boolean; path: string }> {
  const path = `mcp/${server}/${fileName(uri)}`;
  if (content.length > FILE_CAP) {
    return {
      text: `[A file over ${String(FILE_CAP / 1024 / 1024)} MB was not saved.]`,
      failed: true,
      path,
    };
  }
  try {
    await ctx.sandbox.writeFile(ctx.workspace, path, content, ctx.signal);
  } catch (error) {
    return { text: `[Could not save ${path}: ${message(error)}]`, failed: true, path };
  }
  const kb = Math.max(1, Math.round(Buffer.byteLength(content) / 1024));
  if (typeof content !== "string") {
    return {
      text: `[Saved ${path} in your workspace: ${String(kb)} KB.]`,
      failed: false,
      path,
    };
  }
  const lines = content.split("\n").filter((line) => line !== "").length;
  return {
    text: `[Saved ${path} in your workspace: ${String(lines)} lines, ${String(kb)} KB. Read it with the shell.]`,
    failed: false,
    path,
  };
}

/** The last part of the connector's name for it, in plain characters only. */
function fileName(uri: string): string {
  const last = uri.split(/[/\\:]/).at(-1) ?? "";
  const plain = last
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[^A-Za-z0-9_]+/, "")
    .slice(0, 100);
  return plain || `result-${String(Date.now())}.txt`;
}

function alive(connection: Connection): boolean {
  return connection.alive;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
