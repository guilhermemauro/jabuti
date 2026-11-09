// Connectors (C5): the built-in MCP connectors, and the remote MCP servers the owner
// registers: an address, headers whose ${NAME} parts come from Variables, or an OAuth
// login, and which of its tools agents get and which ask first. Which agents use a
// server is set on each agent's Tools & skills page.
import type {
  ClientMessage,
  McpServerInfo,
  McpServerInput,
  McpToolRule,
  SettingsSnapshot,
} from "@jabuti/protocol";
import { useState } from "react";

type Send = (message: ClientMessage) => void;

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function Connectors(props: {
  settings: SettingsSnapshot;
  login: { name: string; url: string } | undefined;
  send: Send;
}) {
  const { settings, send } = props;
  const [adding, setAdding] = useState(false);
  const builtIn = settings.connectors.filter(
    (c) => !settings.mcpServers.some((s) => s.name === c.name),
  );
  return (
    <div className="memory-files notes">
      <p className="sub">
        MCP servers give agents more tools. Register a remote server by its address, then list its
        tools, choose which agents get and which ask you before each call, and turn the server on in
        each agent&apos;s Tools &amp; skills. Tokens go in Variables and reach a server through its
        headers, as ${"{NAME}"}; the model never sees them.
      </p>
      <fieldset>
        <legend>Your MCP servers</legend>
        <div className="actions">
          <button
            onClick={() => {
              setAdding(!adding);
            }}
          >
            + Add server
          </button>
        </div>
        {adding && (
          <ServerForm
            send={send}
            onDone={() => {
              setAdding(false);
            }}
          />
        )}
        <ul>
          {settings.mcpServers.map((server) => (
            <Server
              key={server.name}
              server={server}
              users={settings.agents.filter((a) => a.mcp.includes(server.name)).map((a) => a.name)}
              login={props.login?.name === server.name ? props.login.url : undefined}
              send={send}
            />
          ))}
          {settings.mcpServers.length === 0 && <li className="sub">None yet.</li>}
        </ul>
      </fieldset>
      <fieldset>
        <legend>Built in</legend>
        <ul>
          {builtIn.map((c) => (
            <li key={c.name}>
              <span className="mono">{c.name}</span> <span className="sub">{c.description}</span>
            </li>
          ))}
        </ul>
      </fieldset>
    </div>
  );
}

function Server(props: {
  server: McpServerInfo;
  users: string[];
  login: string | undefined;
  send: Send;
}) {
  const { server, send } = props;
  const [editing, setEditing] = useState(false);
  const on = server.tools.filter((t) => t.on).length;
  return (
    <li>
      <div>
        <span className="mono">{server.name}</span>{" "}
        {server.oauth && (
          <span className={server.connected ? "source owner" : "source auto"}>
            {server.connected ? "logged in" : "not logged in"}
          </span>
        )}{" "}
        {server.description}
        <div className="sub">
          {server.url} ·{" "}
          {server.listedAt
            ? `${String(on)} of ${String(server.tools.length)} tools on`
            : "tools not listed yet"}{" "}
          · {props.users.length > 0 ? props.users.join(", ") : "no agent uses it"}
        </div>
      </div>
      <div className="actions">
        <button
          onClick={() => {
            send({ type: "mcp.list", name: server.name });
          }}
        >
          {server.listedAt ? "List tools again" : "List tools"}
        </button>
        {server.oauth && (
          <button
            onClick={() => {
              send({ type: "mcp.connect", name: server.name });
            }}
          >
            {server.connected ? "Log in again" : "Log in"}
          </button>
        )}
        {server.oauth && server.connected && (
          <button
            onClick={() => {
              send({ type: "mcp.disconnect", name: server.name });
            }}
          >
            Log out
          </button>
        )}
        <button
          onClick={() => {
            setEditing(!editing);
          }}
        >
          Edit
        </button>
        <button
          disabled={props.users.length > 0}
          title={
            props.users.length > 0 ? `Turn it off in ${props.users.join(", ")} first.` : undefined
          }
          onClick={() => {
            if (confirm(`Delete the ${server.name} server and its login?`)) {
              send({ type: "mcp.delete", name: server.name });
            }
          }}
        >
          Delete
        </button>
      </div>
      {props.login && (
        <div className="warn-line">
          <a href={props.login} target="_blank" rel="noopener noreferrer">
            Open the {server.name} login page ↗
          </a>{" "}
          — authorize Jabuti there; this page updates when it is done.
        </div>
      )}
      {editing && (
        <ServerForm
          server={server}
          send={send}
          onDone={() => {
            setEditing(false);
          }}
        />
      )}
      {server.listedAt && (
        <Tools
          key={JSON.stringify(server.tools)}
          server={server.name}
          tools={server.tools}
          send={send}
        />
      )}
    </li>
  );
}

function Tools(props: { server: string; tools: McpToolRule[]; send: Send }) {
  const [tools, setTools] = useState(props.tools);
  const changed = JSON.stringify(tools) !== JSON.stringify(props.tools);
  const set = (name: string, patch: Partial<McpToolRule>) => {
    setTools(tools.map((t) => (t.name === name ? { ...t, ...patch } : t)));
  };
  return (
    <div className="note-editor">
      <div className="sub">
        On: agents get the tool. Ask first: you approve each call, with its arguments. A tool the
        server does not mark read-only asks first until you change it.
      </div>
      {tools.map((t) => (
        <div key={t.name} className="setting">
          <label className="check">
            <input
              type="checkbox"
              checked={t.on}
              onChange={(e) => {
                set(t.name, { on: e.target.checked });
              }}
            />
            <span className="mono">{t.name}</span>
            {t.readOnly && <span className="sub"> · read-only</span>}
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={t.ask}
              disabled={!t.on}
              onChange={(e) => {
                set(t.name, { ask: e.target.checked });
              }}
            />
            Ask first
          </label>
          <span className="sub">{t.description.split("\n")[0]}</span>
        </div>
      ))}
      {tools.length === 0 && <span className="sub">The server lists no tools.</span>}
      {changed && (
        <div className="actions">
          <button
            className="primary"
            onClick={() => {
              props.send({
                type: "mcp.tools",
                name: props.server,
                tools: tools.map(({ name, on, ask }) => ({ name, on, ask })),
              });
            }}
          >
            Save tools
          </button>
        </div>
      )}
    </div>
  );
}

function ServerForm(props: { server?: McpServerInfo; send: Send; onDone: () => void }) {
  const { server } = props;
  const [form, setForm] = useState<McpServerInput>({
    name: server?.name ?? "",
    description: server?.description ?? "",
    url: server?.url ?? "",
    headers: server?.headers ?? [],
    oauth: server?.oauth ?? false,
  });
  const valid =
    NAME.test(form.name) &&
    form.description.trim() !== "" &&
    /^https?:\/\//.test(form.url) &&
    form.headers.every((h) => /^[A-Za-z0-9-]{1,64}$/.test(h.name));
  const header = (i: number, patch: Partial<{ name: string; value: string }>) => {
    setForm({
      ...form,
      headers: form.headers.map((h, j) => (j === i ? { ...h, ...patch } : h)),
    });
  };
  return (
    <div className="note-editor">
      {!server && (
        <input
          type="text"
          aria-label="Name"
          placeholder="name: lowercase, such as notion; its tools become mcp__notion__…"
          value={form.name}
          onChange={(e) => {
            setForm({ ...form, name: e.target.value.toLowerCase() });
          }}
        />
      )}
      <input
        type="text"
        aria-label="Description"
        placeholder="What it gives agents, in one line"
        value={form.description}
        onChange={(e) => {
          setForm({ ...form, description: e.target.value });
        }}
      />
      <input
        type="text"
        aria-label="Address"
        placeholder="https://… its MCP address"
        value={form.url}
        onChange={(e) => {
          setForm({ ...form, url: e.target.value.trim() });
        }}
      />
      <label className="check">
        <input
          type="checkbox"
          checked={form.oauth}
          onChange={(e) => {
            setForm({ ...form, oauth: e.target.checked });
          }}
        />
        Log in with OAuth (the server asks you to authorize Jabuti in the browser)
      </label>
      <div className="sub">
        Headers sent with each request, such as Authorization: Bearer ${"{GITHUB_TOKEN}"}. Put the
        token in Variables, scoped to the agents that use this server; never type it here.
      </div>
      {form.headers.map((h, i) => (
        <div key={i} className="row">
          <input
            type="text"
            aria-label="Header name"
            placeholder="Authorization"
            value={h.name}
            onChange={(e) => {
              header(i, { name: e.target.value });
            }}
          />
          <input
            type="text"
            aria-label="Header value"
            placeholder="Bearer ${TOKEN_NAME}"
            value={h.value}
            onChange={(e) => {
              header(i, { value: e.target.value });
            }}
          />
          <button
            onClick={() => {
              setForm({ ...form, headers: form.headers.filter((_, j) => j !== i) });
            }}
          >
            Remove
          </button>
        </div>
      ))}
      <div className="actions">
        <button
          onClick={() => {
            setForm({ ...form, headers: [...form.headers, { name: "", value: "" }] });
          }}
        >
          + Header
        </button>
        <button
          className="primary"
          disabled={!valid}
          onClick={() => {
            props.send({ type: "mcp.save", server: form, create: !server });
            props.onDone();
          }}
        >
          {server ? "Save" : "Register"}
        </button>
      </div>
    </div>
  );
}
