import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Auth } from "../packages/server/src/auth/index.ts";
import { openDatabase } from "../packages/server/src/db/index.ts";
import { Domain } from "../packages/server/src/domain/index.ts";
import { createApp } from "../packages/server/src/http/app.ts";
import { Hub } from "../packages/server/src/ws/server.ts";
import { harness } from "./harness.ts";

const PASSWORD = "synthetic-password-1";
const servers: { close(): void }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function instance() {
  const h = harness({ script: () => ({ text: "ok" }) });
  const auth = new Auth(openDatabase(":memory:"));
  const hub = new Hub();
  hub.wire({ agents: h.agents, providers: h.providers, store: h.store }, h.runtime);
  const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("synthetic")]);
  const asked: string[] = [];
  const written = new Map<string, Buffer>();
  const server = createApp({
    auth,
    hub,
    uiDir: undefined,
    files: {
      read: (workspace, path) => {
        asked.push(`${workspace}/${path}`);
        const saved = written.get(`${workspace}/${path}`);
        return Promise.resolve(
          saved ?? (workspace === "blog" && path === "mcp/nanobanana/hero-1.png" ? PNG : undefined),
        );
      },
      write: (workspace, path, bytes) => {
        if (workspace !== "blog") return Promise.resolve(false);
        written.set(`${workspace}/${path}`, bytes);
        return Promise.resolve(true);
      },
    },
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const host = `127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://${host}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://${host}`, ...headers },
      body: JSON.stringify(body),
    });
    const session = /jabuti_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    return { status: res.status, cookie: session ? `jabuti_session=${session}` : undefined };
  };

  /** The HTTP status the WebSocket handshake gets: 101 when accepted. */
  const upgrade = (headers: Record<string, string>) =>
    new Promise<number>((done, fail) => {
      const req = request(`http://${host}/ws`, {
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          ...headers,
        },
      });
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        done(res.statusCode ?? 0);
      });
      req.on("response", (res) => {
        done(res.statusCode ?? 0);
      });
      req.on("error", fail);
      req.end();
    });

  const get = (path: string, cookie = "") =>
    fetch(`http://${host}${path}`, { headers: { cookie } });

  const code = auth.setupCode ?? "";
  /** Uploads raw bytes as the composer does. */
  const send = (agent: string, name: string, bytes: Buffer, headers: Record<string, string>) =>
    fetch(`http://${host}/api/upload/${agent}`, {
      method: "POST",
      headers: {
        "x-jabuti-upload": "1",
        "x-file-name": encodeURIComponent(name),
        origin: `http://${host}`,
        ...headers,
      },
      body: bytes,
    });

  return { host, post, upgrade, get, send, code, PNG, asked, written };
}

describe("C15: only the owner's session reaches the instance", () => {
  it("refuses the WebSocket without a session", async () => {
    const { upgrade } = await instance();
    expect(await upgrade({})).toBe(401);
  });

  it("claims a fresh instance only with the setup code from the log", async () => {
    const { post, upgrade, code, host } = await instance();
    expect((await post("/api/setup", { code: "WRONG-CODE", password: PASSWORD })).status).toBe(400);
    expect((await post("/api/setup", { code, password: "short" })).status).toBe(400);

    const owner = await post("/api/setup", { code, password: PASSWORD });
    expect(owner.status).toBe(200);
    expect(await upgrade({ cookie: owner.cookie ?? "", origin: `http://${host}` })).toBe(101);
    // Claimed once: the same code cannot set a new owner.
    expect((await post("/api/setup", { code, password: "another-password" })).status).toBe(400);
  });

  it("logs in with the password and refuses a wrong one", async () => {
    const { post, upgrade, code } = await instance();
    await post("/api/setup", { code, password: PASSWORD });
    expect((await post("/api/login", { password: "wrong-password!" })).status).toBe(401);
    const login = await post("/api/login", { password: PASSWORD });
    expect(login.status).toBe(200);
    expect(await upgrade({ cookie: login.cookie ?? "" })).toBe(101);
  });

  it("refuses another site, even with a valid session cookie", async () => {
    const { post, upgrade, code } = await instance();
    const owner = await post("/api/setup", { code, password: PASSWORD });
    const evil = { origin: "https://evil.example" };
    expect(await upgrade({ cookie: owner.cookie ?? "", ...evil })).toBe(401);
    expect((await post("/api/login", { password: PASSWORD }, evil)).status).toBe(403);
  });

  it("ends the session on logout", async () => {
    const { post, upgrade, code } = await instance();
    const owner = await post("/api/setup", { code, password: PASSWORD });
    await post("/api/logout", {}, { cookie: owner.cookie ?? "" });
    expect(await upgrade({ cookie: owner.cookie ?? "" })).toBe(401);
  });

  it("serves workspace files to the owner only, within the workspace", async () => {
    const { post, get, code, PNG, asked } = await instance();
    const image = "/api/files/blog/mcp/nanobanana/hero-1.png";
    expect((await get(image)).status).toBe(401);
    const owner = await post("/api/setup", { code, password: PASSWORD });
    const res = await get(image, owner.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);

    expect((await get("/api/files/blog/mcp/nanobanana/gone.png", owner.cookie)).status).toBe(404);
    asked.length = 0;
    for (const bad of [
      "/api/files/blog/a%2F..%2F..%2Fb.png",
      "/api/files/blog//etc/a.png",
      "/api/files/Bad_Name/a.png",
      "/api/files/blog/-x.png",
    ]) {
      expect((await get(bad, owner.cookie)).status, bad).toBe(404);
    }
    // Refused before any read.
    expect(asked).toEqual([]);
  });

  it("saves an attached file in the agent's uploads, for the owner only", async () => {
    const { post, get, send, code, written } = await instance();
    const pdf = Buffer.from("%PDF-1.7 synthetic");
    expect((await send("blog", "a.pdf", pdf, {})).status).toBe(401);
    const owner = await post("/api/setup", { code, password: PASSWORD });
    const cookie = owner.cookie ?? "";
    // Another site cannot post, and a plain form cannot set the header.
    expect(
      (await send("blog", "a.pdf", pdf, { cookie, origin: "https://evil.example" })).status,
    ).toBe(403);
    expect((await send("blog", "a.pdf", pdf, { cookie, "x-jabuti-upload": "0" })).status).toBe(403);
    expect((await send("nobody", "a.pdf", pdf, { cookie })).status).toBe(404);
    expect(written.size).toBe(0);

    const res = await send("blog", "Relatório final (v2).PDF", pdf, { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; name: string; size: number };
    expect(body.path).toMatch(/^uploads\/\d{4}-\d{2}-\d{2}\/relatorio-final-v2-[0-9a-f]{4}\.pdf$/);
    expect(body).toMatchObject({ name: "Relatório final (v2).PDF", size: pdf.length });
    expect(written.get(`blog/${body.path}`)?.equals(pdf)).toBe(true);

    // Downloaded back as a file, never shown as a page.
    const back = await get(`/api/files/blog/${body.path}`, cookie);
    expect(back.headers.get("content-type")).toBe("application/octet-stream");
    expect(back.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("lets Caddy certify only the server's sslip.io name and the domain the owner proved", async () => {
    // Synthetic DNS: the owner's domain points at this server, the typo elsewhere.
    const dns: Record<string, string[]> = {
      "jabuti.example.com": ["203.0.113.10"],
      "typo.example.com": ["198.51.100.7"],
    };
    const domain = new Domain(openDatabase(":memory:"), (name) => Promise.resolve(dns[name] ?? []));
    const server = createApp({
      auth: new Auth(openDatabase(":memory:")),
      hub: new Hub(),
      uiDir: undefined,
      domain,
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const allow = async (name: string) =>
      (await fetch(`${base}/api/tls/allow?domain=${encodeURIComponent(name)}`)).status;

    expect(await allow("203-0-113-10.sslip.io")).toBe(200);
    // Not canonical: one name per IP, so no one can make it ask for endless names.
    for (const name of [
      "x.203-0-113-10.sslip.io",
      "203-0-113-300.sslip.io",
      "203.0.113.10.sslip.io",
      "jabuti.example.com",
      "",
    ]) {
      expect(await allow(name)).toBe(403);
    }

    const here = "203-0-113-10.sslip.io";
    expect(await domain.save("typo.example.com", here)).toMatchObject({
      message: expect.stringContaining("not to this server") as unknown,
    });
    expect(await domain.save("nowhere.example.com", here)).toMatchObject({
      message: expect.stringContaining("does not resolve") as unknown,
    });
    expect(await domain.save("https://jabuti.example.com/", here)).toBeDefined();
    // Saved only from an address that is known to be this server's.
    expect(await domain.save("jabuti.example.com", "localhost:4317")).toBeDefined();
    expect(domain.get()).toBeNull();

    expect(await domain.save("Jabuti.Example.com", here)).toBeUndefined();
    expect(await allow("jabuti.example.com")).toBe(200);
    expect(await allow("typo.example.com")).toBe(403);
    await domain.save(null, here);
    expect(await allow("jabuti.example.com")).toBe(403);
  });
});
