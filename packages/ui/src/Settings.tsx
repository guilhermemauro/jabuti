// The settings screen. Agents come first, each on its own page (SettingsAgents.tsx);
// the other tabs hold what is shared: skills, what Jabuti knows about the user,
// variables, model keys, the public domain and the version. It shows what the server sends and sends changes back; secret values go
// up, never down (C16).
import type { ClientMessage, ModelInfo, ProviderKeyInfo, SettingsSnapshot } from "@jabuti/protocol";
import { useEffect, useState } from "react";
import { TuneIcon } from "./Icons.tsx";
import { Agents } from "./SettingsAgents.tsx";
import { MemoryFile } from "./SettingsMemory.tsx";
import { Connectors } from "./SettingsConnectors.tsx";
import { Domain } from "./SettingsDomain.tsx";
import { Skills } from "./SettingsSkills.tsx";
import { Variables } from "./SettingsVariables.tsx";
import { Version } from "./SettingsVersion.tsx";

type Send = (message: ClientMessage) => void;
type Tab =
  "agents" | "skills" | "connectors" | "about" | "variables" | "keys" | "domain" | "version";

const TAB_LABELS: Record<Tab, string> = {
  agents: "Agents",
  skills: "Skills",
  connectors: "Connectors",
  about: "About you",
  variables: "Variables",
  keys: "Model keys",
  domain: "Domain",
  version: "Version",
};

export function SettingsScreen(props: {
  settings: SettingsSnapshot | undefined;
  models: ModelInfo[];
  /** A registered MCP server's login page, waiting to be opened. */
  mcpLogin: { name: string; url: string } | undefined;
  send: Send;
}) {
  const { settings, send } = props;
  const [tab, setTab] = useState<Tab>("agents");
  useEffect(() => {
    send({ type: "settings.open" });
  }, [send]);

  if (!settings) return <div className="empty">Loading settings…</div>;
  return (
    <div className="settings">
      <header className="settings-bar">
        <span className="avatar large">
          <TuneIcon />
        </span>
        <span className="settings-title">Agents &amp; settings</span>
        <nav className="tabs">
          {(
            [
              "agents",
              "skills",
              "connectors",
              "about",
              "variables",
              "keys",
              "domain",
              "version",
            ] as const
          ).map((t) => (
            <button
              key={t}
              className={t === tab ? "active" : ""}
              onClick={() => {
                setTab(t);
              }}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </nav>
      </header>
      <div className="settings-body">
        {settings.warnings.map((w) => (
          <div key={w.message} className="problem" role="alert">
            <div>
              <strong>{w.message}</strong>
              <div>{w.nextStep}</div>
            </div>
          </div>
        ))}
        {tab === "agents" && <Agents settings={settings} models={props.models} send={send} />}
        {tab === "skills" && <Skills settings={settings} send={send} />}
        {tab === "connectors" && (
          <Connectors settings={settings} login={props.mcpLogin} send={send} />
        )}
        {tab === "about" && <AboutYou settings={settings} send={send} />}
        {tab === "variables" && <Variables settings={settings} send={send} />}
        {tab === "keys" && <Keys keys={settings.providerKeys} send={send} />}
        {tab === "domain" && <Domain domain={settings.domain} send={send} />}
        {tab === "version" && <Version version={settings.version} />}
      </div>
    </div>
  );
}

/** What Jabuti knows about the user, shared by the agents that read it (C18). */
function AboutYou(props: { settings: SettingsSnapshot; send: Send }) {
  const { memory, agents } = props.settings;
  const readers = agents.filter((a) => a.userMemory).map((a) => a.name);
  return (
    <div className="memory-files">
      <p className="sub">
        One item per line, starting with “- ”. Read at the start of each conversation by{" "}
        {readers.length > 0 ? readers.join(", ") : "no agent yet"}; turn it on per agent in its
        Tools &amp; skills. Edits apply from the next conversation. Delete a line to make agents
        forget it.
      </p>
      <MemoryFile
        key={`user:${memory.user}`}
        title="About you"
        hint="Your name, preferences and projects: what every agent with About you on should know."
        content={memory.user}
        limit={memory.limit}
        onSave={(content) => {
          props.send({ type: "memory.save", agent: null, content });
        }}
      />
    </div>
  );
}

// --- Model keys ---

function Keys(props: { keys: ProviderKeyInfo[]; send: Send }) {
  return (
    <div className="keys">
      {props.keys.map((k) => (
        <KeyRow key={k.provider} info={k} send={props.send} />
      ))}
    </div>
  );
}

function KeyRow({ info, send }: { info: ProviderKeyInfo; send: Send }) {
  const [key, setKey] = useState("");
  return (
    <form
      className="form key"
      onSubmit={(e) => {
        e.preventDefault();
        send({ type: "providerKey.save", provider: info.provider, key: key.trim() });
        setKey("");
      }}
    >
      <strong>{info.provider}</strong>
      <span className="sub">
        {info.source === "environment"
          ? `Set by the server's environment (${info.provider.toUpperCase()}_API_KEY). Change it in .env.`
          : info.source === "settings"
            ? "Key saved."
            : "No key: this provider's models are unavailable."}
      </span>
      {info.source !== "environment" && (
        <div className="row">
          <input
            type="password"
            value={key}
            autoComplete="off"
            placeholder={info.source === "settings" ? "Replace the key" : "Paste the API key"}
            onChange={(e) => {
              setKey(e.target.value);
            }}
          />
          <button className="primary" disabled={key.trim() === ""}>
            Save
          </button>
          {info.source === "settings" && (
            <button
              type="button"
              className="danger"
              onClick={() => {
                if (window.confirm(`Remove the ${info.provider} key?`)) {
                  send({ type: "providerKey.save", provider: info.provider, key: null });
                }
              }}
            >
              Remove
            </button>
          )}
        </div>
      )}
    </form>
  );
}
