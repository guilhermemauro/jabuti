// The HTTP boundary: login API, the built UI, and the gate in front of the
// WebSocket. Nothing but /api/session, /api/setup and /api/login is reachable
// without an owner session (C15). /api/files serves the owner files of an agent's
// workspace, such as images a connector generated (C21); /api/upload saves the
// files the owner attaches to a message there. /api/mcp/oauth/callback ends an OAuth
// login the owner started: the provider's redirect carries no SameSite=Strict cookie,
// so its single-use state, not the session, authenticates it (mcp/servers.ts).
// /api/tls/allow answers Caddy, on a server, whether a name may get a certificate
// (domain/index.ts); the deploy's Caddy does not let it be asked from outside.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { z } from "zod";
import { AGENT_NAME } from "@jabuti/protocol";
import { Auth, SESSION_COOKIE } from "../auth/index.ts";
import { FILE_CAP, FILE_PATH, imageType } from "../sandbox/docker.ts";
import type { Domain } from "../domain/index.ts";
import type { Hub } from "../ws/server.ts";

const BODY_LIMIT = 16 * 1024;
const SESSION_MAX_AGE = 30 * 86_400;

const Credentials = z.strictObject({ code: z.string().optional(), password: z.string() });

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/** An agent's workspace files; undefined when the agent or file does not exist. */
export interface WorkspaceFiles {
  read(workspace: string, path: string): Promise<Buffer | undefined>;
  /** False when the agent does not exist. */
  write(workspace: string, path: string, bytes: Buffer): Promise<boolean>;
}

export function createApp(deps: {
  auth: Auth;
  hub: Hub;
  uiDir: string | undefined;
  /** Absent in tests that do not exercise it. */
  files?: WorkspaceFiles;
  /** Finishes a registered MCP server's OAuth login; resolves to the server's name. */
  oauthCallback?: (state: string, code: string) => Promise<string>;
  /** The names Caddy may get a certificate for; absent in tests that need none. */
  domain?: Domain;
}): Server {
  const { auth, hub } = deps;
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      process.stderr.write(`HTTP error: ${String(error)}\n`);
      if (!res.headersSent) json(res, 500, { error: "Internal error. Check the server log." });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    securityHeaders(res);
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/mcp/oauth/callback" && req.method === "GET") {
      return oauth(res, url.searchParams);
    }
    if (url.pathname === "/api/tls/allow" && req.method === "GET") {
      const allowed = deps.domain?.allows(url.searchParams.get("domain") ?? "") ?? false;
      json(res, allowed ? 200 : 403, {});
      return;
    }
    if (url.pathname.startsWith("/api/")) return api(req, res, url.pathname);
    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { error: "GET only." });
      return;
    }
    return serveUi(res, deps.uiDir, url.pathname);
  }

  async function api(req: IncomingMessage, res: ServerResponse, path: string) {
    const token = cookie(req, SESSION_COOKIE);
    if (path === "/api/session" && req.method === "GET") {
      json(res, 200, { state: auth.state(token) });
      return;
    }
    if (path.startsWith("/api/files/") && (req.method === "GET" || req.method === "HEAD")) {
      if (!auth.session(token)) {
        json(res, 401, { error: "Log in first." });
        return;
      }
      return file(res, path.slice("/api/files/".length));
    }
    if (path.startsWith("/api/upload/") && req.method === "POST") {
      // Raw bytes, not JSON: a form on another site cannot set this header (CSRF).
      if (!sameOrigin(req) || req.headers["x-jabuti-upload"] !== "1") {
        json(res, 403, { error: "Cross-origin request refused." });
        return;
      }
      if (!auth.session(token)) {
        json(res, 401, { error: "Log in first." });
        return;
      }
      return upload(req, res, path.slice("/api/upload/".length));
    }
    if (req.method !== "POST") {
      json(res, 405, { error: "POST only." });
      return;
    }
    // A form on another site cannot send JSON with a foreign Origin (CSRF).
    if (!sameOrigin(req) || !req.headers["content-type"]?.startsWith("application/json")) {
      json(res, 403, { error: "Cross-origin request refused." });
      return;
    }
    if (path === "/api/logout") {
      if (token) hub.closeSession(Auth.sessionId(token));
      auth.logout(token);
      res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
      json(res, 200, {});
      return;
    }
    if (path !== "/api/setup" && path !== "/api/login") {
      json(res, 404, { error: "Not found." });
      return;
    }
    const body = Credentials.safeParse(await readJson(req));
    if (!body.success) {
      json(res, 400, { error: "Send { password } as JSON." });
      return;
    }
    const result =
      path === "/api/setup"
        ? auth.setup(body.data.code ?? "", body.data.password)
        : auth.login(body.data.password);
    if ("error" in result) {
      json(res, path === "/api/setup" ? 400 : 401, result);
      return;
    }
    res.setHeader("Set-Cookie", sessionCookie(req, result.token, SESSION_MAX_AGE));
    json(res, 200, {});
  }

  async function oauth(res: ServerResponse, params: URLSearchParams) {
    const state = params.get("state") ?? "";
    const code = params.get("code") ?? "";
    let text: string;
    if (!deps.oauthCallback) {
      text = "This server does not take MCP logins.";
    } else if (!state || !code) {
      const why = params.get("error_description") ?? params.get("error") ?? "no code came back";
      text = `The login did not finish: ${why}. Connect again from Jabuti.`;
    } else {
      try {
        const name = await deps.oauthCallback(state, code);
        text = `Connected to ${name}. You can close this tab and go back to Jabuti.`;
      } catch (error) {
        text = `The login did not finish: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Jabuti</title>` +
        `<p style="font-family:sans-serif;margin:2rem">${escapeHtml(text)}</p>`,
    );
  }

  /** A file of a workspace, as "<agent>/<relative path>": an image shown, anything else downloaded. */
  async function file(res: ServerResponse, rest: string) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rest);
    } catch {
      json(res, 400, { error: "Bad path." });
      return;
    }
    const [workspace = "", ...parts] = decoded.split("/");
    const path = parts.join("/");
    const type = imageType(path);
    if (!AGENT_NAME.test(workspace) || !FILE_PATH.test(path) || !deps.files) {
      json(res, 404, { error: "Not found." });
      return;
    }
    const bytes = await deps.files.read(workspace, path).catch(() => undefined);
    if (!bytes) {
      json(res, 404, { error: "The file is not in the workspace." });
      return;
    }
    // Never rendered as a page: whatever is not an image is a download (no HTML, no SVG).
    res.writeHead(200, {
      "Content-Type": type ?? "application/octet-stream",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${type ? "inline" : "attachment"}; filename="${path.split("/").at(-1) ?? "file"}"`,
      // The agent may write the same name again.
      "Cache-Control": "private, no-cache",
    });
    res.end(bytes);
  }

  /** Saves an attached file in uploads/<date>/ of the agent's workspace. */
  async function upload(req: IncomingMessage, res: ServerResponse, workspace: string) {
    const name = String(req.headers["x-file-name"] ?? "");
    if (!AGENT_NAME.test(workspace) || !deps.files) {
      json(res, 404, { error: "No such agent." });
      return;
    }
    const bytes = await readBody(req, FILE_CAP);
    if (!bytes) {
      json(res, 413, { error: `Files up to ${String(FILE_CAP / 1024 / 1024)} MB.` });
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      decoded = "";
    }
    const date = new Date().toISOString().slice(0, 10);
    // A short random part keeps two files of the same name from overwriting each other.
    const path = `uploads/${date}/${safeName(decoded, randomBytes(2).toString("hex"))}`;
    const saved = await deps.files.write(workspace, path, bytes).catch((error: unknown) => {
      process.stderr.write(`Upload failed: ${String(error)}\n`);
      return undefined;
    });
    if (saved === false) {
      json(res, 404, { error: "No such agent." });
      return;
    }
    if (saved === undefined) {
      json(res, 500, { error: "The file could not be saved in the workspace." });
      return;
    }
    json(res, 200, { path, name: decoded || path.split("/").at(-1), size: bytes.length });
  }

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const session = auth.session(cookie(req, SESSION_COOKIE));
    // Browsers let any page open a WebSocket to any host: Origin and the
    // SameSite cookie are what keep other sites out.
    if (url.pathname !== "/ws" || !sameOrigin(req) || !session) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    hub.accept(req, socket, head, session);
  });

  return server;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
}

/** No Origin means a non-browser client, which cannot be driven by another site. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function sessionCookie(req: IncomingMessage, value: string, maxAge: number): string {
  // Behind a TLS-terminating proxy the request arrives as plain HTTP.
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(maxAge)}${secure}`;
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=") || undefined;
  }
  return undefined;
}

/** "Relatório final (v2).PDF" → "relatorio-final-v2-1a2b.pdf": plain characters only. */
function safeName(name: string, unique: string): string {
  const plain = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const dot = plain.lastIndexOf(".");
  const clean = (part: string) => part.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = clean(dot > 0 ? plain.slice(0, dot) : plain).slice(0, 80) || "file";
  const ext = dot > 0 ? clean(plain.slice(dot + 1)).slice(0, 10) : "";
  return `${base}-${unique}${ext ? `.${ext}` : ""}`;
}

/** The body up to cap bytes; undefined past it. */
async function readBody(req: IncomingMessage, cap: number): Promise<Buffer | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > cap) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT) return undefined;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function securityHeaders(res: ServerResponse) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  // No framing: another site must not overlay the Approve button (clickjacking).
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  );
}

async function serveUi(res: ServerResponse, uiDir: string | undefined, pathname: string) {
  if (!uiDir) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Jabuti server: in development the UI is served by Vite (pnpm dev).\n");
    return;
  }
  const root = resolve(uiDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    json(res, 400, { error: "Bad path." });
    return;
  }
  let path = resolve(join(root, decoded));
  if (path !== root && !path.startsWith(root + sep)) {
    json(res, 404, { error: "Not found." });
    return;
  }
  const file = await stat(path).catch(() => undefined);
  if (!file?.isFile()) {
    // Client-side routes fall back to the app; missing assets stay 404.
    if (extname(pathname)) {
      json(res, 404, { error: "Not found." });
      return;
    }
    path = join(root, "index.html");
  }
  const hashed = path.startsWith(join(root, "assets") + sep);
  res.writeHead(200, {
    "Content-Type": TYPES[extname(path)] ?? "application/octet-stream",
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
  });
  res.end(await readFile(path));
}
