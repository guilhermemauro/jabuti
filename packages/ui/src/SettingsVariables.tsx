// Variables (C16): values agents' connectors, and optionally their shells, receive.
// Values go up to the server, never down.
import type {
  ClientMessage,
  KnownVariable,
  SettingsSnapshot,
  VariableInfo,
} from "@jabuti/protocol";
import { type ReactNode, useState } from "react";

type Send = (message: ClientMessage) => void;

export function Variables(props: { settings: SettingsSnapshot; send: Send }) {
  const { settings, send } = props;
  const [editing, setEditing] = useState<VariableInfo | "new" | "global" | KnownVariable>();
  const agents = settings.agents.map((a) => a.name);
  const global = settings.variables.filter((v) => v.scope === "all");
  const specific = settings.variables.filter((v) => v.scope !== "all");
  const needed = settings.knownVariables.filter((k) => k.missingFor.length > 0);

  return (
    <div className="variables">
      {needed.length > 0 && (
        <div className="attention" role="status">
          <strong>
            {needed.length === 1 ? "1 variable is" : `${String(needed.length)} variables are`} still
            missing
          </strong>
          <ul className="needed">
            {needed.map((k) => (
              <li key={k.name}>
                <div>
                  <code>{k.name}</code> for {k.usedBy}, used by {k.missingFor.join(", ")}.{" "}
                  <button
                    className="link"
                    onClick={() => {
                      setEditing(k);
                    }}
                  >
                    Set it up
                  </button>
                </div>
                <div className="sub">{k.help}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="sub">
        By default only the server uses a variable (connectors); with “Pass to shell”, those agents’
        commands receive it as an environment variable, and their model can read it.
      </p>
      <section className="variable-group">
        <h3>
          Global <span className="sub">every agent, including ones created later</span>
        </h3>
        <VariableTable
          rows={global}
          empty="No global variables."
          whose={(v) => {
            const own = overrides(settings.variables, v.name);
            return own.length > 0 ? (
              <span className="sub">Not for {own.join(", ")}: they have their own value.</span>
            ) : (
              <ScopeTag scope="all" />
            );
          }}
          onEdit={setEditing}
          send={send}
        />
      </section>
      <section className="variable-group">
        <h3>
          Agent-specific{" "}
          <span className="sub">only the agents named; wins over a global value</span>
        </h3>
        <VariableTable
          rows={specific}
          empty="No agent-specific variables."
          whose={(v) => <ScopeTag scope={v.scope} />}
          onEdit={setEditing}
          send={send}
        />
      </section>
      {editing ? (
        <VariableForm
          key={typeof editing === "string" ? editing : "id" in editing ? editing.id : editing.name}
          initial={typeof editing !== "string" && "id" in editing ? editing : undefined}
          variables={settings.variables}
          {...(editing === "global"
            ? { preset: { name: "", scope: "all" as const } }
            : typeof editing !== "string" && "missingFor" in editing
              ? { preset: { name: editing.name, scope: editing.missingFor } }
              : {})}
          known={settings.knownVariables}
          agents={agents}
          onSave={(input) => {
            send({ type: "variable.save", ...input });
            setEditing(undefined);
          }}
          onCancel={() => {
            setEditing(undefined);
          }}
        />
      ) : (
        <div className="actions">
          <button
            className="primary"
            onClick={() => {
              setEditing("global");
            }}
          >
            Add a global variable
          </button>
          <button
            onClick={() => {
              setEditing("new");
            }}
          >
            Add for specific agents
          </button>
        </div>
      )}
    </div>
  );
}

/** Agents with a value of their own for a name that also has a global one. */
function overrides(variables: VariableInfo[], name: string): string[] {
  return variables.flatMap((v) => (v.name === name && v.scope !== "all" ? v.scope : []));
}

/** Who a value is for, at a glance: global, or the agents it names. */
function ScopeTag(props: { scope: VariableInfo["scope"] }) {
  if (props.scope === "all") return <span className="scope-tag global">All agents</span>;
  if (props.scope.length === 0) return <span className="sub">No agent</span>;
  return (
    <span className="scope-tags">
      {props.scope.map((agent) => (
        <span key={agent} className="scope-tag mono">
          {agent}
        </span>
      ))}
    </span>
  );
}

function VariableTable(props: {
  rows: VariableInfo[];
  empty: string;
  whose: (v: VariableInfo) => ReactNode;
  onEdit: (v: VariableInfo) => void;
  send: Send;
}) {
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Name</th>
          <th>Agents</th>
          <th>Shell</th>
          <th>Updated</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {props.rows.map((v) => (
          <tr key={v.id}>
            <td>
              <code>{v.name}</code>
              {v.problem && <div className="error-text">{v.problem}</div>}
            </td>
            <td>{props.whose(v)}</td>
            <td>{v.shell ? "⚠ passed to shell" : "server only"}</td>
            <td>{new Date(v.updatedAt).toLocaleString()}</td>
            <td className="actions">
              <button
                onClick={() => {
                  props.onEdit(v);
                }}
              >
                Edit
              </button>
              <button
                className="danger"
                onClick={() => {
                  const whose = v.scope === "all" ? "all agents" : v.scope.join(", ");
                  if (window.confirm(`Delete the value of ${v.name} for ${whose || "no agent"}?`)) {
                    props.send({ type: "variable.delete", id: v.id });
                  }
                }}
              >
                Delete
              </button>
            </td>
          </tr>
        ))}
        {props.rows.length === 0 && (
          <tr>
            <td colSpan={5} className="sub">
              {props.empty}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/** One value per name for an agent, as the server picks it: its own over the one for all. */
export function reaching(variables: VariableInfo[], agent: string): VariableInfo[] {
  const chosen = new Map<string, VariableInfo>();
  for (const v of variables) {
    if (v.scope !== "all" && v.scope.includes(agent)) chosen.set(v.name, v);
    else if (v.scope === "all" && !chosen.has(v.name)) chosen.set(v.name, v);
  }
  return [...chosen.values()];
}

export interface VariableInput {
  id?: string;
  name: string;
  value?: string;
  scope: "all" | string[];
  shell: boolean;
}

export function VariableForm(props: {
  /** The value being edited; undefined for a new one. */
  initial: VariableInfo | undefined;
  /** Every stored value, to offer sharing one and to mark agents that have their own. */
  variables: VariableInfo[];
  /** The variables Jabuti uses: offered by name, each with where to get its value. */
  known: KnownVariable[];
  /** For a new one: the name and agents to start from, such as a connector's missing key. */
  preset?: { name: string; scope: "all" | string[] };
  agents: string[];
  onSave: (input: VariableInput) => void;
  onCancel: () => void;
}) {
  const { initial, preset, known } = props;
  const [name, setName] = useState(initial?.name ?? preset?.name ?? "");
  // A name Jabuti does not use is typed: for an agent's own scripts (Pass to shell).
  const [other, setOther] = useState(name !== "" && !known.some((k) => k.name === name));
  const chosen = known.find((k) => k.name === name);
  const [value, setValue] = useState("");
  const start = initial?.scope ?? preset?.scope ?? [];
  const [all, setAll] = useState(start === "all");
  const [scope, setScope] = useState<string[]>(start === "all" ? [] : start);
  const [shell, setShell] = useState(initial?.shell ?? false);
  // A new value may instead share one that exists: its agents gain these ones.
  const [shared, setShared] = useState<string>();

  const others = props.variables.filter((v) => v.name === name && v.id !== initial?.id);
  const shareable = initial ? [] : others.filter((v) => v.scope !== "all");
  const base = shareable.find((v) => v.id === shared);
  const hasAll = others.some((v) => v.scope === "all");
  // Agents with their own value of this name cannot take a second one.
  const owner = (agent: string) =>
    others.find((v) => v.id !== base?.id && v.scope !== "all" && v.scope.includes(agent));

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (base && base.scope !== "all") {
          props.onSave({
            id: base.id,
            name,
            scope: [...new Set([...base.scope, ...scope])],
            shell: base.shell,
          });
          return;
        }
        props.onSave({
          ...(initial ? { id: initial.id } : {}),
          name,
          ...(value !== "" ? { value } : {}),
          scope: all ? "all" : scope,
          shell,
        });
      }}
    >
      <label>
        Name
        {initial ? (
          <input value={name} disabled />
        ) : (
          <select
            value={other ? "__other" : name}
            required
            onChange={(e) => {
              const value = e.target.value;
              setOther(value === "__other");
              setName(value === "__other" ? "" : value);
              setShared(undefined);
            }}
          >
            <option value="" disabled>
              Choose what it is for…
            </option>
            {known.map((k) => (
              <option key={k.name} value={k.name}>
                {k.name} — {k.usedBy}
              </option>
            ))}
            <option value="__other">Other: a name of my own…</option>
          </select>
        )}
      </label>
      {other && !initial && (
        <label>
          Your variable's name
          <input
            value={name}
            placeholder="MY_API_KEY"
            pattern="[A-Z_][A-Z0-9_]*"
            title="A-Z, 0-9 and _, starting with a letter or _."
            required
            onChange={(e) => {
              setName(e.target.value.toUpperCase());
            }}
          />
          <span className="sub">
            Jabuti itself does not read it. Turn on Pass to shell for an agent's own scripts to use
            it.
          </span>
        </label>
      )}
      {chosen?.help && <p className="help">{chosen.help}</p>}
      {shareable.length > 0 && (
        <fieldset>
          <legend>{name} already has an agent-specific value</legend>
          <label className="check">
            <input
              type="radio"
              name="shared"
              checked={base === undefined}
              onChange={() => {
                setShared(undefined);
              }}
            />
            A separate value, such as another site’s account
          </label>
          {shareable.map((v) => (
            <label key={v.id} className="check">
              <input
                type="radio"
                name="shared"
                checked={base?.id === v.id}
                onChange={() => {
                  setShared(v.id);
                }}
              />
              The same value as{" "}
              {v.scope === "all" ? "all agents" : v.scope.join(", ") || "no agent"}
            </label>
          ))}
        </fieldset>
      )}
      {!base && (
        <label>
          Value
          <input
            type="password"
            value={value}
            autoComplete="off"
            required={initial === undefined}
            placeholder={initial ? "Leave empty to keep the current value" : ""}
            onChange={(e) => {
              setValue(e.target.value);
            }}
          />
        </label>
      )}
      <fieldset>
        <legend>{base ? "Agents to add to that value" : "Who uses it"}</legend>
        {!base && (
          <label className="check">
            <input
              type="checkbox"
              checked={all}
              disabled={hasAll && !all}
              onChange={(e) => {
                setAll(e.target.checked);
              }}
            />
            Global: all agents, including ones created later
            {hasAll && !all && <span className="sub"> ({name} already has a global value)</span>}
          </label>
        )}
        {(base !== undefined || !all) &&
          props.agents.map((agent) => {
            const own = owner(agent);
            return (
              <label key={agent} className="check">
                <input
                  type="checkbox"
                  checked={scope.includes(agent)}
                  disabled={own !== undefined && !scope.includes(agent)}
                  onChange={(e) => {
                    setScope(
                      e.target.checked ? [...scope, agent] : scope.filter((a) => a !== agent),
                    );
                  }}
                />
                {agent}
                {own && <span className="sub"> (has its own value)</span>}
              </label>
            );
          })}
        {!base && !all && hasAll && (
          <span className="sub">These agents use this value instead of the global one.</span>
        )}
      </fieldset>
      {!base && (
        <label className="check">
          <input
            type="checkbox"
            checked={shell}
            onChange={(e) => {
              setShell(e.target.checked);
            }}
          />
          Pass to shell
          <span className="sub">
            Those agents’ commands get it as an environment variable. Their model can then read the
            value: use it only for values the agent may see.
          </span>
        </label>
      )}
      <div className="actions">
        <button className="primary">Save</button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
