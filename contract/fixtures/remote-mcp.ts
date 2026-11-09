// A remote MCP server for C5 tests, over Streamable HTTP, with an OAuth provider of its
// own (protected-resource and authorization-server metadata, dynamic registration,
// PKCE, tokens). Synthetic: it records what reaches it and accepts one key or token.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export const REMOTE_KEY = "synthetic-remote-key";
const TOKEN = "synthetic-access-token";

export interface Remote {
  url: string;
  /** Tools called, by name. */
  calls: string[];
  /** The credential each MCP request carried. */
  credentials: string[];
  close(): Promise<void>;
}

export async function startRemote(options: { oauth: boolean }): Promise<Remote> {
  const calls: string[] = [];
  const credentials: string[] = [];
  const challenges = new Map<string, string>();
  let origin = "";

  const mcp = async (req: IncomingMessage, res: ServerResponse, body: unknown) => {
    const credential = options.oauth
      ? (req.headers.authorization ?? "")
      : String(req.headers["x-api-key"] ?? "");
    credentials.push(credential);
    if (credential !== (options.oauth ? `Bearer ${TOKEN}` : REMOTE_KEY)) {
      res.writeHead(401, {
        "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      });
      res.end();
      return;
    }
    const server = new McpServer({ name: "remote", version: "0.0.0" });
    server.registerTool(
      "read_item",
      { description: "Reads an item.", annotations: { readOnlyHint: true } },
      () => {
        calls.push("read_item");
        return { content: [{ type: "text", text: "item one" }] };
      },
    );
    server.registerTool("delete.item", { description: "Deletes an item." }, () => {
      calls.push("delete.item");
      return { content: [{ type: "text", text: "deleted" }] };
    });
    server.registerTool("hidden", { description: "Turned off by the owner." }, () => {
      calls.push("hidden");
      return { content: [{ type: "text", text: "hidden" }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const http = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", origin);
      const json = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (url.pathname === "/mcp") {
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        void mcp(req, res, JSON.parse(raw));
        return;
      }
      if (!options.oauth) {
        res.writeHead(404).end();
        return;
      }
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
      } else if (url.pathname === "/.well-known/oauth-authorization-server") {
        json(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      } else if (url.pathname === "/register" && req.method === "POST") {
        json(201, { ...(JSON.parse(raw) as object), client_id: "synthetic-client" });
      } else if (url.pathname === "/authorize") {
        // The owner approves at once: back to Jabuti with a code.
        const code = `code-${String(challenges.size)}`;
        challenges.set(code, url.searchParams.get("code_challenge") ?? "");
        const back = new URL(url.searchParams.get("redirect_uri") ?? "");
        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        res.writeHead(302, { location: back.href }).end();
      } else if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(raw);
        const challenge = challenges.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const expected = createHash("sha256").update(verifier).digest("base64url");
        if (!challenge || challenge !== expected) {
          json(400, { error: "invalid_grant" });
          return;
        }
        challenges.delete(form.get("code") ?? "");
        json(200, { access_token: TOKEN, token_type: "Bearer", expires_in: 3600 });
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${String((http.address() as AddressInfo).port)}`;
  return {
    url: `${origin}/mcp`,
    calls,
    credentials,
    close: () =>
      new Promise((done) => {
        http.closeAllConnections();
        http.close(() => {
          done();
        });
      }),
  };
}
