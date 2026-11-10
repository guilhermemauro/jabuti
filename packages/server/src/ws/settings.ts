// The settings screen's requests: agent profiles, variables and provider keys.
// Each change goes through the module that owns it; this file only checks the
// cross-module rules (a model must exist, a scope must name real agents) and
// builds what the screen shows. No secret value is ever put in a reply (C16).
import type {
  ClientMessage,
  ConnectorInfo,
  KnownVariable,
  Problem,
  SettingsSnapshot,
} from "@jabuti/protocol";
import type { AgentRegistry } from "../agents/registry.ts";
import { BODY_LIMIT, STATE_LIMIT, SUMMARY_LIMIT, type AgentState } from "../agents/state.ts";
import { saveAgent } from "../agents/save.ts";
import type { Providers } from "../providers/index.ts";
import type { Settings } from "../settings/index.ts";
import type { Skills } from "../skills/index.ts";
import type { ListedTool, McpServers } from "../mcp/servers.ts";
import type { Domain } from "../domain/index.ts";
import { Version } from "../version/index.ts";

export interface SettingsDeps {
  agents: AgentRegistry;
  providers: Providers;
  settings: Settings;
  /** The built-in MCP connectors (C5). */
  connectors: readonly ConnectorInfo[];
  /** Remote MCP servers the owner registered; absent in tests that need none. */
  mcpServers?: McpServers;
  /** Told when a server changes, so open connections restart. */
  mcpChanged?: (name: string) => void;
  /** Lists a registered server's tools (C5). */
  discover?: (name: string, agents: string[]) => Promise<ListedTool[]>;
  /** The public domain on a server; absent in tests that need none. */
  domain?: Domain;
  /** The running version and the newest release; absent in tests that need none. */
  version?: Version;
  /** Skills agents may list (C4). */
  skills: Skills;
  /** Setup issues, such as a secret key generated next to the data. */
  warnings: Problem[];
  /** Brief and memory files, which the owner may edit here (C14, C18). */
  state: AgentState;
}

type SettingsMessage = Extract<
  ClientMessage,
  {
    type:
      | "settings.open"
      | "variable.save"
      | "variable.delete"
      | "providerKey.save"
      | "agent.save"
      | "agent.delete"
      | "agents.reload"
      | "skill.save"
      | "skill.delete"
      | "mcp.save"
      | "mcp.delete"
      | "mcp.tools"
      | "mcp.disconnect"
      | "memory.save"
      | "note.save"
      | "note.delete";
  }
>;

export interface SettingsResult {
  problem?: Problem;
  saved?: string;
  /** Agents or model availability changed: every client needs the new catalog. */
  catalogChanged: boolean;
}

export function handleSettings(message: SettingsMessage, deps: SettingsDeps): SettingsResult {
  const { agents, providers, settings } = deps;
  switch (message.type) {
    case "settings.open":
      return { catalogChanged: false };
    case "memory.save": {
      // The owner's own edit: no approval, but the same limit the agents have.
      if (message.content.length > STATE_LIMIT) {
        return {
          problem: {
            message: `Not saved: ${String(message.content.length)} characters, over the ${String(STATE_LIMIT)} limit.`,
            nextStep: "Shorten it and save again.",
          },
          catalogChanged: false,
        };
      }
      if (message.agent === null) {
        deps.state.writeUser(message.content);
        return saved("Saved what agents know about you.", false);
      }
      if (!agents.get(message.agent)) {
        return {
          problem: { message: `Unknown agent "${message.agent}".`, nextStep: "Reload." },
          catalogChanged: false,
        };
      }
      deps.state.writeBrief(message.agent, message.content);
      return saved(`Saved ${message.agent}'s brief.`, false);
    }
    case "note.save":
    case "note.delete": {
      if (!agents.get(message.agent)) {
        return {
          problem: { message: `Unknown agent "${message.agent}".`, nextStep: "Reload." },
          catalogChanged: false,
        };
      }
      if (message.type === "note.delete") {
        return deps.state.deleteNote(message.agent, message.id)
          ? saved(`Deleted ${message.id}; its last version is kept in the history.`, false)
          : {
              problem: { message: `There is no note ${message.id}.`, nextStep: "Reload." },
              catalogChanged: false,
            };
      }
      // The owner's own words, or confirmed by the owner: its source becomes owner.
      const input = { summary: message.summary, body: message.body, check: message.check };
      const note = message.id
        ? deps.state.updateNote(message.agent, message.id, input, { source: "owner" })
        : deps.state.createNote(message.agent, input, { source: "owner" });
      if ("problem" in note) {
        return {
          problem: { message: note.problem, nextStep: "Fix it and save again." },
          catalogChanged: false,
        };
      }
      return saved(`Saved ${note.id}.`, false);
    }
    case "variable.save": {
      const unknown = message.scope === "all" ? [] : message.scope.filter((a) => !agents.get(a));
      if (unknown.length > 0) {
        return {
          problem: {
            message: `Unknown agent in scope: ${unknown.join(", ")}.`,
            nextStep: "Pick agents from the list.",
          },
          catalogChanged: false,
        };
      }
      const problem = settings.saveVariable({
        ...(message.id === undefined ? {} : { id: message.id }),
        name: message.name,
        value: message.value,
        scope: message.scope,
        shell: message.shell,
      });
      return problem ? { problem, catalogChanged: false } : saved(`Saved ${message.name}.`, false);
    }
    case "variable.delete": {
      const name = settings.deleteVariable(message.id);
      return name
        ? saved(`Deleted a value of ${name}.`, false)
        : {
            problem: { message: "That value no longer exists.", nextStep: "Reload." },
            catalogChanged: false,
          };
    }
    case "providerKey.save": {
      if (!providers.providerIds().includes(message.provider)) {
        return {
          problem: { message: `Unknown provider "${message.provider}".`, nextStep: "Reload." },
          catalogChanged: false,
        };
      }
      const problem = settings.saveProviderKey(message.provider, message.key);
      if (problem) return { problem, catalogChanged: false };
      return saved(message.key ? `Saved the ${message.provider} key.` : "Key removed.", true);
    }
    case "agent.save": {
      const problem = saveAgent(
        { ...deps, connectors: connectors(deps), skills: deps.skills.list() },
        message.profile,
        message.create,
      );
      if (problem) return { problem, catalogChanged: false };
      return saved(`Saved agent ${message.profile.name}. It applies from the next turn.`, true);
    }
    case "agent.delete": {
      const problem = agents.remove(message.name);
      if (problem) return { problem, catalogChanged: false };
      return saved(`Deleted agent ${message.name}. Its brief, memory and files were kept.`, true);
    }
    case "agents.reload":
      agents.reload();
      return saved("Agents reloaded from disk.", true);
    case "mcp.save":
    case "mcp.delete":
    case "mcp.tools":
    case "mcp.disconnect":
      return mcpServer(message, deps);
    case "skill.save": {
      const problem = deps.skills.save(message.skill, message.create);
      if (problem) return { problem, catalogChanged: false };
      return saved(`Saved skill ${message.skill.name}. It applies from the next turn.`, false);
    }
    case "skill.delete": {
      const replaced = deps.skills.data().find((s) => s.name === message.name)?.replacesBuiltIn;
      const users = agents.profiles().filter((a) => a.skills.includes(message.name));
      if (!replaced && users.length > 0) {
        return {
          problem: {
            message: `${users.map((a) => a.name).join(", ")} use the skill ${message.name}.`,
            nextStep: "Turn it off in those agents first.",
          },
          catalogChanged: false,
        };
      }
      const problem = deps.skills.remove(message.name);
      if (problem) return { problem, catalogChanged: false };
      return saved(
        replaced
          ? `Deleted your version of ${message.name}: agents use the built-in one again.`
          : `Deleted the skill ${message.name}.`,
        false,
      );
    }
  }
}

export function snapshot(deps: SettingsDeps): SettingsSnapshot {
  return {
    agents: deps.agents.profiles(),
    templates: deps.agents.templates(),
    variables: deps.settings.variables(),
    providerKeys: deps.settings.providerKeys(deps.providers.providerIds()),
    connectors: connectors(deps),
    mcpServers: deps.mcpServers?.list() ?? [],
    domain: deps.domain?.get() ?? null,
    version: (deps.version ?? new Version({})).info(),
    skills: deps.skills.data(),
    knownVariables: knownVariables(deps),
    // A skill folder that cannot be read is a setup issue the owner fixes on disk.
    warnings: [...deps.warnings, ...deps.skills.load().problems],
    memory: {
      user: deps.state.readUser(),
      agents: deps.agents.profiles().map(({ name }) => ({
        name,
        brief: deps.state.readBrief(name),
        notes: deps.state.notes(name),
      })),
      limit: STATE_LIMIT,
      summaryLimit: SUMMARY_LIMIT,
      bodyLimit: BODY_LIMIT,
    },
  };
}

/**
 * The variables connectors read, each with where to get it and the agents that use
 * it but cannot see a value yet: what the owner still has to set, by name.
 */
function knownVariables(deps: SettingsDeps): KnownVariable[] {
  const variables = deps.settings.variables();
  const profiles = deps.agents.profiles();
  const lacks = (agent: string, name: string) =>
    !variables.some((v) => v.name === name && (v.scope === "all" || v.scope.includes(agent)));
  const known = new Map<string, KnownVariable>();
  const add = (name: string, usedBy: string, help: string, users: string[]) => {
    const missingFor = users.filter((agent) => lacks(agent, name));
    const seen = known.get(name);
    if (seen) {
      seen.usedBy = `${seen.usedBy}, ${usedBy}`;
      seen.missingFor = [...new Set([...seen.missingFor, ...missingFor])];
    } else {
      known.set(name, { name, usedBy, help, missingFor });
    }
  };
  for (const c of connectors(deps)) {
    const users = profiles.filter((p) => p.mcp.includes(c.name)).map((p) => p.name);
    for (const name of c.variables)
      add(name, `the ${c.name} connector`, c.help?.[name] ?? "", users);
  }
  return [...known.values()];
}

/** What agents may list: the built-in connectors and the registered servers. */
function connectors(deps: SettingsDeps): ConnectorInfo[] {
  return [
    ...deps.connectors.map(({ name, description, variables, help }) => ({
      name,
      description,
      variables,
      ...(help ? { help } : {}),
    })),
    ...(deps.mcpServers?.connectorInfos() ?? []),
  ];
}

function mcpServer(
  message: Extract<
    SettingsMessage,
    { type: "mcp.save" | "mcp.delete" | "mcp.tools" | "mcp.disconnect" }
  >,
  deps: SettingsDeps,
): SettingsResult {
  const servers = deps.mcpServers;
  if (!servers) {
    return {
      problem: { message: "MCP servers are not available.", nextStep: "Restart." },
      catalogChanged: false,
    };
  }
  const name = message.type === "mcp.save" ? message.server.name : message.name;
  if (message.type === "mcp.delete") {
    const users = deps.agents.profiles().filter((a) => a.mcp.includes(name));
    if (users.length > 0) {
      return {
        problem: {
          message: `${users.map((a) => a.name).join(", ")} use the ${name} server.`,
          nextStep: "Turn it off in those agents first.",
        },
        catalogChanged: false,
      };
    }
  }
  const problem =
    message.type === "mcp.save"
      ? servers.save(message.server, message.create)
      : message.type === "mcp.delete"
        ? servers.remove(name)
        : message.type === "mcp.tools"
          ? servers.setTools(name, message.tools)
          : (servers.disconnect(name), undefined);
  if (problem) return { problem, catalogChanged: false };
  deps.mcpChanged?.(name);
  const done = {
    "mcp.save":
      message.type === "mcp.save" && message.create
        ? `Registered ${name}. List its tools next, then turn it on for the agents that need it.`
        : `Saved ${name}. Agents use the change from their next message.`,
    "mcp.delete": `Deleted the ${name} server.`,
    "mcp.tools": `Saved ${name}'s tools. Agents use them from their next message.`,
    "mcp.disconnect": `Logged out of ${name}.`,
  }[message.type];
  return saved(done, false);
}

function saved(message: string, catalogChanged: boolean): SettingsResult {
  return { saved: message, catalogChanged };
}
