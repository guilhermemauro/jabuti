// Agent profiles: data/agents/<name>/agent.json + system.md. Agents are data. This
// module is the only writer of those two files (the settings screen saves through
// it; the owner may also edit them by hand and reload). Profiles are validated
// here, once, against the protocol's AgentJson (boundary). The same folder holds
// the brief, memory and workspace, which belong to agents/state.ts.
//
// The repository's agents/ folder holds templates: copied in on first start, and
// offered as starting points for new agents.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AGENT_NAME,
  AgentJson,
  type AgentInfo,
  type AgentProfileData,
  type Problem,
  type ShellPermission,
} from "@jabuti/protocol";
import { z } from "zod";

export type { ShellPermission };
export type AgentProfile = AgentProfileData;

export class AgentRegistry {
  private agents = new Map<string, AgentProfile>();
  private loadProblems: Problem[] = [];
  private readonly dir: string | undefined;
  private readonly templatesDir: string | undefined;

  /** In memory, for tests: profiles cannot be saved. */
  constructor(agents: AgentProfile[] = [], dirs?: { dir: string; templatesDir: string }) {
    for (const agent of agents) this.agents.set(agent.name, agent);
    this.dir = dirs?.dir;
    this.templatesDir = dirs?.templatesDir;
  }

  static load(dir: string, templatesDir: string): AgentRegistry {
    const registry = new AgentRegistry([], { dir, templatesDir });
    registry.seed();
    registry.reload();
    return registry;
  }

  /** Problems from loading plus references to agents that do not exist. */
  get problems(): Problem[] {
    const missing: Problem[] = [];
    for (const agent of this.agents.values()) {
      for (const sub of agent.subagents) {
        if (!this.agents.has(sub)) {
          missing.push({
            message: `Agent "${agent.name}" lists unknown subagent "${sub}".`,
            nextStep: `Create agent "${sub}", or remove it from ${agent.name}'s subagents in Settings.`,
          });
        }
      }
    }
    return [...this.loadProblems, ...missing];
  }

  /** Re-reads every profile from disk. */
  reload() {
    if (!this.dir) return;
    const { agents, problems } = readProfiles(this.dir);
    this.agents = agents;
    this.loadProblems = problems;
  }

  templates(): AgentProfile[] {
    return this.templatesDir ? [...readProfiles(this.templatesDir).agents.values()] : [];
  }

  /** Writes agent.json and system.md; takes effect from the next turn. */
  save(profile: AgentProfile, create: boolean): Problem | undefined {
    if (!this.dir) return readOnly();
    if (create && (this.agents.has(profile.name) || existsSync(this.file(profile.name)))) {
      return {
        message: `Agent "${profile.name}" already exists.`,
        nextStep: "Pick another name, or edit the existing agent.",
      };
    }
    if (!create && !this.agents.has(profile.name)) {
      return { message: `Agent "${profile.name}" does not exist.`, nextStep: "Create it first." };
    }
    if (profile.subagents.includes(profile.name)) {
      return { message: "An agent cannot be its own subagent.", nextStep: "Remove it." };
    }
    const unknown = profile.subagents.find((s) => !this.agents.has(s));
    if (unknown) {
      return { message: `Unknown subagent "${unknown}".`, nextStep: "Create it first." };
    }
    const { name, system, ...json } = profile;
    const folder = join(this.dir, name);
    mkdirSync(folder, { recursive: true });
    writeAtomic(join(folder, "agent.json"), `${JSON.stringify(json, null, 2)}\n`);
    writeAtomic(join(folder, "system.md"), system);
    this.agents.set(name, profile);
    return undefined;
  }

  /**
   * Removes the profile files only. Brief, memory and workspace stay on disk, so
   * an agent created again with the same name finds them.
   */
  remove(name: string): Problem | undefined {
    if (!this.dir) return readOnly();
    if (!this.agents.has(name)) return { message: `No agent "${name}".`, nextStep: "Reload." };
    const parent = [...this.agents.values()].find((a) => a.subagents.includes(name));
    if (parent) {
      return {
        message: `Agent "${parent.name}" delegates to "${name}".`,
        nextStep: `Remove "${name}" from ${parent.name}'s subagents first.`,
      };
    }
    rmSync(join(this.dir, name, "agent.json"), { force: true });
    rmSync(join(this.dir, name, "system.md"), { force: true });
    this.agents.delete(name);
    return undefined;
  }

  get(name: string): AgentProfile | undefined {
    return this.agents.get(name);
  }

  profiles(): AgentProfile[] {
    return [...this.agents.values()];
  }

  list(): AgentInfo[] {
    return [...this.agents.values()].map((a) => ({
      name: a.name,
      description: a.description,
      model: a.model,
      shell: a.permissions.shell,
    }));
  }

  /** First start: no profile yet, so the templates become the agents. */
  private seed() {
    if (!this.dir || !this.templatesDir) return;
    if (readProfiles(this.dir).agents.size > 0 || !existsSync(this.templatesDir)) return;
    for (const name of readdirSync(this.templatesDir)) {
      for (const file of ["agent.json", "system.md"]) {
        const from = join(this.templatesDir, name, file);
        if (existsSync(from)) {
          mkdirSync(join(this.dir, name), { recursive: true });
          cpSync(from, join(this.dir, name, file));
        }
      }
    }
  }

  private file(name: string): string {
    return join(this.dir ?? "", name, "agent.json");
  }
}

function readProfiles(dir: string): { agents: Map<string, AgentProfile>; problems: Problem[] } {
  const agents = new Map<string, AgentProfile>();
  const problems: Problem[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory());
  } catch {
    return { agents, problems };
  }
  for (const name of names) {
    // A folder with only brief, memory or workspace belongs to a removed agent.
    if (!existsSync(join(dir, name, "agent.json"))) continue;
    if (!AGENT_NAME.test(name)) {
      problems.push({
        message: `Agent folder "${name}" has an invalid name.`,
        nextStep: "Rename it using only lowercase letters, digits and hyphens.",
      });
      continue;
    }
    try {
      const json: unknown = JSON.parse(readFileSync(join(dir, name, "agent.json"), "utf8"));
      const profile = AgentJson.parse(json);
      const system = readFileSync(join(dir, name, "system.md"), "utf8");
      agents.set(name, { ...profile, name, system });
    } catch (error) {
      const detail = error instanceof z.ZodError ? z.prettifyError(error) : String(error);
      problems.push({
        message: `Agent "${name}" could not be loaded: ${detail}`,
        nextStep: `Fix agents/${name}/agent.json or system.md, then reload agents in Settings.`,
      });
    }
  }
  return { agents, problems };
}

function writeAtomic(path: string, content: string) {
  writeFileSync(`${path}.tmp`, content);
  renameSync(`${path}.tmp`, path);
}

function readOnly(): Problem {
  return {
    message: "Agent profiles are read-only here.",
    nextStep: "This registry was built without a profiles folder.",
  };
}
