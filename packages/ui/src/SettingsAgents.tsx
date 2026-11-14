// Settings for one agent at a time: its profile, tools and connectors, memory and the
// variables that reach it. What keeps an agent from using something it has on is said
// in words, on the page, next to the switch: not in a tooltip.
import type {
  AgentProfileData,
  ClientMessage,
  ModelInfo,
  SettingsSnapshot,
  TemplateUpdate,
  ToolName,
  VariableInfo,
} from "@jabuti/protocol";
import { useState } from "react";
import { AgentIcon } from "./Icons.tsx";
import { MemoryFile, Notes } from "./SettingsMemory.tsx";
import { reaching, VariableForm } from "./SettingsVariables.tsx";

type Send = (message: ClientMessage) => void;
type Section = "profile" | "tools" | "memory" | "variables";

const SECTION_LABELS: Record<Section, string> = {
  profile: "Profile",
  tools: "Tools & skills",
  memory: "Memory",
  variables: "Variables",
};

const BLANK: AgentProfileData = {
  name: "",
  description: "",
  model: "",
  budget: { maxSteps: 30, maxCostUsd: 1 },
  tools: ["shell", "packages"],
  permissions: { shell: "auto" },
  subagents: [],
  mcp: [],
  skills: [],
  userMemory: true,
  capture: true,
  system: "",
};

const TOOLS = [
  { name: "shell", label: "Shell", hint: "Runs commands in its workspace." },
  {
    name: "packages",
    label: "Install packages",
    hint: "Installs system programs such as git; you approve each install.",
  },
  {
    name: "web_read",
    label: "Read pages",
    hint: "Reads a web page's main text, for research. Runs in its sandbox.",
  },
  {
    name: "page_structure",
    label: "Page structure",
    hint: "Reads a page's headings, calls to action and links, for SEO. Runs in its sandbox.",
  },
  {
    name: "site_crawl",
    label: "Crawl site",
    hint: "Follows a site's internal links and lists what to fix: broken links, orphan pages, generic anchors. Runs in its sandbox.",
  },
  {
    name: "view_images",
    label: "View images",
    hint: "Looks at web images or its own files, as one grid, with its own model. Runs in its sandbox.",
  },
  { name: "delegate", label: "Delegate", hint: "Hands tasks to its subagents." },
  {
    name: "memory",
    label: "Brief and notes",
    hint: "Keeps a brief and notes across conversations.",
  },
  {
    name: "plan",
    label: "Milestones and routine",
    hint: "Works on milestones and experiments, alone on a routine; you approve what goes live.",
  },
  {
    name: "agents",
    label: "Manage agents",
    hint: "Creates and edits other agents from the chat; you approve each change.",
  },
] as const satisfies readonly { name: ToolName; label: string; hint: string }[];

/** Profile switches next to the tools: memory about the user, and capture (C18). */
const MEMORY_SWITCHES = [
  {
    key: "userMemory",
    label: "About you",
    hint: "Reads what Jabuti knows about you (your name, preferences, projects), shared by the agents that have this on, and can save to it when you ask.",
  },
  {
    key: "capture",
    label: "Auto-remember",
    hint: "After a conversation goes quiet (30 minutes, or when you start another), a small model reads your messages and the agent's replies and proposes what to remember. Nothing is saved until you approve. Costs a fraction of a cent per conversation.",
  },
] as const;

/** Why a tool that is on cannot do anything, in words; undefined when it can. */
function unusable(p: AgentProfileData, tool: ToolName): string | undefined {
  if (tool === "packages" && (!p.tools.includes("shell") || p.permissions.shell === "deny")) {
    return "Needs the shell on: it installs programs for the shell to use.";
  }
  if (
    (tool === "web_read" || tool === "page_structure" || tool === "site_crawl") &&
    p.permissions.shell === "deny"
  ) {
    return "Runs in the sandbox: set the shell mode to Auto or Ask.";
  }
  if (tool === "delegate" && p.subagents.length === 0) {
    return "No subagents chosen: pick them below, or turn Delegate off.";
  }
  return undefined;
}

const scoped = (v: VariableInfo, agent: string) => v.scope === "all" || v.scope.includes(agent);

interface Attention {
  section: Section;
  text: string;
}

/** Everything keeping this agent from working as set up, for the banner and the list. */
function attention(
  p: AgentProfileData,
  settings: SettingsSnapshot,
  models: ModelInfo[],
): Attention[] {
  const found: Attention[] = [];
  const model = models.find((m) => m.id === p.model);
  if (!model) found.push({ section: "profile", text: `Model ${p.model} is not in the catalog.` });
  else if (!model.available) {
    found.push({
      section: "profile",
      text: `${model.label} has no API key: add one in Model keys, or pick another model.`,
    });
  }
  for (const t of TOOLS) {
    const why = p.tools.includes(t.name) ? unusable(p, t.name) : undefined;
    if (why) found.push({ section: "tools", text: `${t.label}: ${why}` });
  }
  if (p.capture && !p.userMemory && !p.tools.includes("memory")) {
    found.push({
      section: "tools",
      text: "Auto-remember: nothing to remember into. Turn on About you or Brief and notes.",
    });
  }
  for (const c of settings.connectors.filter((c) => p.mcp.includes(c.name))) {
    if (c.problem) found.push({ section: "tools", text: `${c.name}: ${c.problem}` });
    for (const name of c.variables) {
      if (!settings.variables.some((v) => v.name === name && scoped(v, p.name))) {
        found.push({ section: "tools", text: `${c.name}: needs the variable ${name}.` });
      }
    }
  }
  for (const v of reaching(settings.variables, p.name).filter((v) => v.problem)) {
    found.push({ section: "variables", text: `${v.name}: ${v.problem ?? ""}` });
  }
  return found;
}

export function Agents(props: { settings: SettingsSnapshot; models: ModelInfo[]; send: Send }) {
  const { settings, models, send } = props;
  const [selected, setSelected] = useState<string | undefined>(settings.agents[0]?.name);
  const [draft, setDraft] = useState<AgentProfileData>();
  // The first agent until the owner picks one, and again if that one is deleted.
  const current = settings.agents.find((a) => a.name === selected) ?? settings.agents[0];

  return (
    <div className="split">
      <aside>
        <ul className="list">
          {settings.agents.map((a) => {
            const issues = attention(a, settings, models).length;
            const update = settings.templateUpdates.some(
              (u) => u.agent === a.name && u.status === "available",
            );
            return (
              <li key={a.name}>
                <button
                  className={!draft && a.name === current?.name ? "active" : ""}
                  onClick={() => {
                    setDraft(undefined);
                    setSelected(a.name);
                  }}
                >
                  <span className="avatar small">
                    <AgentIcon agent={a.name} size={16} />
                  </span>
                  <span>
                    {a.name}
                    <span className="sub mono">{a.model}</span>
                  </span>
                  {update && (
                    <span className="issues" title="Its template has an update for you to review">
                      ↑
                    </span>
                  )}
                  {issues > 0 && (
                    <span
                      className="issues"
                      title={`${String(issues)} ${issues === 1 ? "thing needs" : "things need"} attention`}
                    >
                      ⚠ {issues}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <select
          aria-label="New agent"
          value=""
          onChange={(e) => {
            const template = settings.templates.find((t) => t.name === e.target.value);
            const base = template ?? { ...BLANK, model: models[0]?.id ?? "" };
            setDraft({ ...base, name: "" });
          }}
        >
          <option value="">+ New agent…</option>
          <option value="__blank">Blank</option>
          {settings.templates.map((t) => (
            <option key={t.name} value={t.name}>
              From template: {t.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            send({ type: "agents.reload" });
          }}
        >
          Reload from disk
        </button>
      </aside>
      {draft ? (
        <div className="agent-page">
          <header className="agent-head">
            <div>
              <div className="agent-title">New agent</div>
              <div className="sub">
                Tools, connectors and memory come from the template; adjust them once it exists.
              </div>
            </div>
          </header>
          <ProfileForm
            initial={draft}
            create
            models={models}
            onSave={(profile) => {
              send({ type: "agent.save", profile, create: true });
              setDraft(undefined);
              setSelected(profile.name);
            }}
            onCancel={() => {
              setDraft(undefined);
            }}
          />
        </div>
      ) : current ? (
        <AgentPage
          key={current.name}
          profile={current}
          settings={settings}
          models={models}
          send={send}
          onDeleted={() => {
            setSelected(undefined);
          }}
        />
      ) : (
        <div className="empty">No agent yet. Create one from the list.</div>
      )}
    </div>
  );
}

function AgentPage(props: {
  profile: AgentProfileData;
  settings: SettingsSnapshot;
  models: ModelInfo[];
  send: Send;
  onDeleted: () => void;
}) {
  const { profile, settings, models, send } = props;
  const [section, setSection] = useState<Section>("profile");
  const issues = attention(profile, settings, models);
  const count = (s: Section) => issues.filter((i) => i.section === s).length;
  /** Saves at once: a switch here is the whole change. */
  const save = (patch: Partial<AgentProfileData>) => {
    send({ type: "agent.save", profile: { ...profile, ...patch }, create: false });
  };

  return (
    <div className="agent-page">
      <header className="agent-head">
        <span className="avatar large">
          <AgentIcon agent={profile.name} />
        </span>
        <div>
          <div className="agent-title">{profile.name}</div>
          <div className="sub">{profile.description}</div>
        </div>
      </header>
      <TemplateUpdates
        updates={settings.templateUpdates.filter((u) => u.agent === profile.name)}
        send={send}
      />
      {issues.length > 0 && (
        <div className="attention" role="status">
          <strong>
            {issues.length === 1 ? "1 thing needs" : `${String(issues.length)} things need`}{" "}
            attention
          </strong>
          <ul>
            {issues.map((i) => (
              <li key={i.text}>
                <button
                  className="link"
                  onClick={() => {
                    setSection(i.section);
                  }}
                >
                  {i.text}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <nav className="tabs subtabs">
        {(["profile", "tools", "memory", "variables"] as const).map((s) => (
          <button
            key={s}
            className={s === section ? "active" : ""}
            onClick={() => {
              setSection(s);
            }}
          >
            {SECTION_LABELS[s]}
            {count(s) > 0 && <span className="issues"> ⚠ {count(s)}</span>}
          </button>
        ))}
      </nav>
      {section === "profile" && (
        <ProfileForm
          initial={profile}
          create={false}
          models={models}
          onSave={(fields) => {
            // Only the fields this form edits: switches saved meanwhile are kept.
            save({
              description: fields.description,
              model: fields.model,
              budget: fields.budget,
              system: fields.system,
            });
          }}
          onDelete={() => {
            if (
              window.confirm(`Delete agent ${profile.name}? Its brief, memory and files are kept.`)
            ) {
              send({ type: "agent.delete", name: profile.name });
              props.onDeleted();
            }
          }}
        />
      )}
      {section === "tools" && (
        <ToolsSection profile={profile} settings={settings} save={save} send={send} />
      )}
      {section === "memory" && <MemorySection profile={profile} settings={settings} send={send} />}
      {section === "variables" && (
        <VariablesSection profile={profile} settings={settings} send={send} />
      )}
    </div>
  );
}

/**
 * A newer template (C22): applied ones are shown so the owner sees what changed; the
 * ones they edited wait for them, with what applying would change in their file.
 */
function TemplateUpdates(props: { updates: TemplateUpdate[]; send: Send }) {
  if (props.updates.length === 0) return null;
  return (
    <div className="template-updates">
      {props.updates.map((u) => (
        <details
          key={`${u.file}-${u.status}`}
          className="attention"
          open={u.status === "available"}
        >
          <summary>
            <strong>
              {u.status === "applied"
                ? `${u.file} was updated from the ${u.template} template.`
                : `The ${u.template} template has a new ${u.file}, and you edited yours.`}
            </strong>
          </summary>
          {u.status === "available" && (
            <p className="sub">
              Lines with − are yours and would go; lines with + come from the template.
            </p>
          )}
          <pre className="diff">
            {u.diff.split("\n").map((line, i) => (
              <div
                key={i}
                className={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : ""}
              >
                {line}
              </div>
            ))}
          </pre>
          {u.status === "available" && (
            <div className="row">
              <button
                className="primary"
                onClick={() => {
                  props.send({ type: "agent.template", name: u.agent, file: u.file, apply: true });
                }}
              >
                Use the template's
              </button>
              <button
                onClick={() => {
                  props.send({ type: "agent.template", name: u.agent, file: u.file, apply: false });
                }}
              >
                Keep mine
              </button>
            </div>
          )}
        </details>
      ))}
    </div>
  );
}

function ToolsSection(props: {
  profile: AgentProfileData;
  settings: SettingsSnapshot;
  save: (patch: Partial<AgentProfileData>) => void;
  send: Send;
}) {
  const { profile: p, settings, save } = props;
  const [adding, setAdding] = useState<string>();
  const others = settings.agents.map((a) => a.name).filter((a) => a !== p.name);
  const toggle = <T extends string>(list: readonly T[], item: T, on: boolean): T[] =>
    on ? [...list, item] : list.filter((x) => x !== item);

  return (
    <div className="agent-section">
      <p className="sub">Changes here are saved at once and apply from the next turn.</p>
      <fieldset>
        <legend>Tools</legend>
        {TOOLS.map((t) => {
          const on = p.tools.includes(t.name);
          const why = on ? unusable(p, t.name) : undefined;
          return (
            <div key={t.name} className="setting">
              <label className="check">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => {
                    save({ tools: toggle(p.tools, t.name, e.target.checked) });
                  }}
                />
                {t.label}
              </label>
              <span className="sub">{t.hint}</span>
              {why && <span className="warn-line">⚠ {why}</span>}
              {t.name === "delegate" && on && (
                <div className="nested">
                  {others.length === 0 && <span className="sub">No other agent yet.</span>}
                  {others.map((name) => (
                    <label key={name} className="check">
                      <input
                        type="checkbox"
                        checked={p.subagents.includes(name)}
                        onChange={(e) => {
                          save({ subagents: toggle(p.subagents, name, e.target.checked) });
                        }}
                      />
                      {name}
                    </label>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </fieldset>

      <fieldset>
        <legend>Shell mode</legend>
        <select
          aria-label={`Shell mode for ${p.name}`}
          value={p.permissions.shell}
          onChange={(e) => {
            const shell = e.target.value;
            if (shell === "ask" || shell === "auto" || shell === "deny") {
              save({ permissions: { shell } });
            }
          }}
        >
          <option value="auto">Auto: runs commands and installs without asking</option>
          <option value="ask">Ask before every command</option>
          <option value="deny">No shell</option>
        </select>
        <span className="sub">
          Auto never asks: commands and package installs run in the agent's own workspace. Each
          conversation can switch between Auto and Ask; No shell cannot be overridden.
        </span>
      </fieldset>

      <fieldset>
        <legend>Memory</legend>
        {MEMORY_SWITCHES.map((m) => (
          <div key={m.key} className="setting">
            <label className="check">
              <input
                type="checkbox"
                checked={p[m.key]}
                onChange={(e) => {
                  save({ [m.key]: e.target.checked });
                }}
              />
              {m.label}
            </label>
            <span className="sub">{m.hint}</span>
            {m.key === "capture" && p.capture && !p.userMemory && !p.tools.includes("memory") && (
              <span className="warn-line">
                ⚠ Nothing to remember into: turn on About you or Brief and notes.
              </span>
            )}
          </div>
        ))}
      </fieldset>

      <fieldset>
        <legend>Connectors</legend>
        {settings.connectors.length === 0 && <span className="sub">No connectors installed.</span>}
        {settings.connectors.map((c) => {
          const on = p.mcp.includes(c.name);
          const lacking = c.variables.filter(
            (name) => !settings.variables.some((v) => v.name === name && scoped(v, p.name)),
          );
          return (
            <div key={c.name} className="setting">
              <label className="check">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => {
                    save({ mcp: toggle(p.mcp, c.name, e.target.checked) });
                  }}
                />
                <span className="mono">{c.name}</span>
              </label>
              <span className="sub">
                {c.description}
                {c.variables.length > 0 &&
                  ` Uses ${c.variables.join(", ")}; only the connector receives it, never the model.`}
              </span>
              {on &&
                lacking.map((name) =>
                  adding === name ? (
                    <div key={name} className="nested">
                      <VariableForm
                        initial={undefined}
                        variables={settings.variables}
                        known={settings.knownVariables}
                        preset={{ name, scope: [p.name] }}
                        agents={settings.agents.map((a) => a.name)}
                        onSave={(input) => {
                          props.send({ type: "variable.save", ...input });
                          setAdding(undefined);
                        }}
                        onCancel={() => {
                          setAdding(undefined);
                        }}
                      />
                    </div>
                  ) : (
                    <span key={name} className="warn-line">
                      ⚠ Needs {name}, scoped to {p.name}.{" "}
                      <button
                        className="link"
                        onClick={() => {
                          setAdding(name);
                        }}
                      >
                        Add {name}
                      </button>
                    </span>
                  ),
                )}
            </div>
          );
        })}
      </fieldset>

      <fieldset>
        <legend>Skills</legend>
        <span className="sub">
          Methods it loads when a task needs one: its prompt lists only their names and
          descriptions. Write and edit them in the Skills tab.
        </span>
        {settings.skills.length === 0 && <span className="sub">No skills installed.</span>}
        {settings.skills.map((s) => (
          <div key={s.name} className="setting">
            <label className="check">
              <input
                type="checkbox"
                checked={p.skills.includes(s.name)}
                onChange={(e) => {
                  save({ skills: toggle(p.skills, s.name, e.target.checked) });
                }}
              />
              <span className="mono">{s.name}</span>
              {s.source === "owner" && <span className="sub"> · yours</span>}
            </label>
            <span className="sub">{s.description}</span>
          </div>
        ))}
        {p.skills
          .filter((name) => !settings.skills.some((s) => s.name === name))
          .map((name) => (
            <span key={name} className="warn-line">
              ⚠ Lists the skill {name}, which does not exist.{" "}
              <button
                className="link"
                onClick={() => {
                  save({ skills: p.skills.filter((n) => n !== name) });
                }}
              >
                Remove it
              </button>
            </span>
          ))}
      </fieldset>
    </div>
  );
}

function MemorySection(props: {
  profile: AgentProfileData;
  settings: SettingsSnapshot;
  send: Send;
}) {
  const { profile, settings, send } = props;
  const { memory } = settings;
  const files = memory.agents.find((a) => a.name === profile.name);
  return (
    <div className="agent-section memory-files">
      <p className="sub">
        One item per line, starting with “- ”. {profile.name} reads these at the start of each
        conversation; edits apply from the next one.
      </p>
      {!profile.tools.includes("memory") && (
        <span className="warn-line">
          ⚠ {profile.name} does not read these itself: turn on Brief and notes in Tools &amp;
          connectors. Agents that delegate to it still pass it their brief.
        </span>
      )}
      <MemoryFile
        key={`brief:${files?.brief ?? ""}`}
        title="Brief"
        hint="What this agent works on: site, products, positioning, audience, tone, goals. Its subagents read it too."
        content={files?.brief ?? ""}
        limit={memory.limit}
        onSave={(content) => {
          send({ type: "memory.save", agent: profile.name, content });
        }}
      />
      <Notes
        agent={profile.name}
        notes={files?.notes ?? []}
        summaryLimit={memory.summaryLimit}
        bodyLimit={memory.bodyLimit}
        send={send}
      />
    </div>
  );
}

function VariablesSection(props: {
  profile: AgentProfileData;
  settings: SettingsSnapshot;
  send: Send;
}) {
  const { profile, settings, send } = props;
  const me = profile.name;
  // A new value only for this agent, optionally of a name it now gets globally.
  const [editing, setEditing] = useState<VariableInfo | { own: string }>();
  const reach = reaching(settings.variables, me);
  const overridden = (name: string) =>
    settings.variables.some((v) => v.name === name && v.scope === "all");
  return (
    <div className="agent-section">
      <p className="sub">
        The variables that reach {me}. <strong>Global</strong> ones reach every agent;{" "}
        <strong>its own</strong> are only for the agents named and win over a global value of the
        same name. Server only: its connectors receive them. Passed to shell: its commands receive
        them too, so its model can read them.
      </p>
      <table className="grid">
        <thead>
          <tr>
            <th>Name</th>
            <th>From</th>
            <th>Shell</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {reach.map((v) => {
            const global = v.scope === "all";
            const shared = v.scope === "all" ? [] : v.scope.filter((a) => a !== me);
            return (
              <tr key={v.id}>
                <td>
                  <code>{v.name}</code>
                  {v.problem && <div className="error-text">{v.problem}</div>}
                </td>
                <td>
                  {global ? (
                    <span className="scope-tag global">Global</span>
                  ) : (
                    <span className="scope-tag">
                      Only {shared.length > 0 ? "these agents" : me}
                    </span>
                  )}
                  {shared.length > 0 && <div className="sub">Shared with {shared.join(", ")}</div>}
                  {!global && overridden(v.name) && (
                    <div className="sub">Used instead of the global value</div>
                  )}
                </td>
                <td>{v.shell ? "⚠ passed to shell" : "server only"}</td>
                <td className="actions">
                  <button
                    title={global ? "Changes it for every agent" : undefined}
                    onClick={() => {
                      setEditing(v);
                    }}
                  >
                    {global ? "Edit for all" : "Edit"}
                  </button>
                  {global && (
                    <button
                      onClick={() => {
                        setEditing({ own: v.name });
                      }}
                    >
                      Use another value here
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {reach.length === 0 && (
            <tr>
              <td colSpan={4} className="sub">
                No variable reaches {me} yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {editing ? (
        <VariableForm
          known={settings.knownVariables}
          key={"own" in editing ? `own:${editing.own}` : editing.id}
          initial={"own" in editing ? undefined : editing}
          {...("own" in editing ? { preset: { name: editing.own, scope: [me] } } : {})}
          variables={settings.variables}
          agents={settings.agents.map((a) => a.name)}
          onSave={(input) => {
            send({ type: "variable.save", ...input });
            setEditing(undefined);
          }}
          onCancel={() => {
            setEditing(undefined);
          }}
        />
      ) : (
        <button
          className="primary"
          onClick={() => {
            setEditing({ own: "" });
          }}
        >
          Add a variable only for {me}
        </button>
      )}
    </div>
  );
}

function ProfileForm(props: {
  initial: AgentProfileData;
  create: boolean;
  models: ModelInfo[];
  onSave: (profile: AgentProfileData) => void;
  onDelete?: () => void;
  onCancel?: () => void;
}) {
  const [p, setP] = useState(props.initial);
  const set = (patch: Partial<AgentProfileData>) => {
    setP({ ...p, ...patch });
  };
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSave(p);
      }}
    >
      {props.create && (
        <label>
          Name
          <input
            value={p.name}
            placeholder="my-blog"
            pattern="[a-z0-9][a-z0-9\-]*"
            title="Lowercase letters, digits and hyphens. Cannot be changed later."
            required
            onChange={(e) => {
              set({ name: e.target.value });
            }}
          />
        </label>
      )}
      <label>
        Description
        <input
          value={p.description}
          required
          onChange={(e) => {
            set({ description: e.target.value });
          }}
        />
      </label>
      <label>
        Model
        <select
          value={p.model}
          onChange={(e) => {
            set({ model: e.target.value });
          }}
        >
          {props.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.available ? "" : " (no API key)"}
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        <label>
          Max steps per turn
          <input
            type="number"
            min={1}
            value={p.budget.maxSteps}
            onChange={(e) => {
              set({ budget: { ...p.budget, maxSteps: Number(e.target.value) } });
            }}
          />
        </label>
        <label>
          Max cost per turn (USD)
          <input
            type="number"
            min={0.01}
            step={0.01}
            value={p.budget.maxCostUsd}
            onChange={(e) => {
              set({ budget: { ...p.budget, maxCostUsd: Number(e.target.value) } });
            }}
          />
        </label>
      </div>
      <label>
        System prompt
        <textarea
          rows={16}
          value={p.system}
          onChange={(e) => {
            set({ system: e.target.value });
          }}
        />
      </label>
      <div className="actions">
        <button className="primary">{props.create ? "Create agent" : "Save"}</button>
        {props.onCancel && (
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
        )}
        {props.onDelete && (
          <button type="button" className="danger" onClick={props.onDelete}>
            Delete
          </button>
        )}
      </div>
    </form>
  );
}
