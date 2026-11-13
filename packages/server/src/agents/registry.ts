// Agent profiles: data/agents/<name>/agent.json + system.md. Agents are data. This
// module is the only writer of those two files (the settings screen saves through
// it; the owner may also edit them by hand and reload). Profiles are validated
// here, once, against the protocol's AgentJson (boundary). The same folder holds
// the brief, memory and workspace, which belong to agents/state.ts.
//
// The repository's agents/ folder holds templates: copied in on first start, and
// offered as starting points for new agents. An agent made from one keeps following
// it (C22): .template.json in its folder names the template and the template's version
// each file derives from, so an update replaces only the files the owner never changed.
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
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  AGENT_NAME,
  AgentJson,
  type AgentInfo,
  type AgentProfileData,
  type Problem,
  type ShellPermission,
  type TemplateUpdate,
} from "@jabuti/protocol";
import { z } from "zod";
import { lineDiff } from "../tools/memory.ts";

export type { ShellPermission };
export type AgentProfile = AgentProfileData;

export class AgentRegistry {
  private agents = new Map<string, AgentProfile>();
  private loadProblems: Problem[] = [];
  /** Files updated from their template at this start, shown to the owner until restart. */
  private applied: TemplateUpdate[] = [];
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
    registry.followTemplates();
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
    if (create) this.recordOrigin(profile);
    return undefined;
  }

  /** Each template's newer file the owner has to decide on, then those applied at this start. */
  templateUpdates(): TemplateUpdate[] {
    const templates = this.templateMap();
    const available: TemplateUpdate[] = [];
    for (const agent of this.agents.values()) {
      const origin = this.origin(agent.name);
      const template = origin && templates.get(origin.template);
      if (!origin || !template) continue;
      for (const file of FILES) {
        const current = fileText(agent, file);
        const next = fileText(template, file);
        if (current === next || origin[file] === digest(next)) continue;
        available.push({
          agent: agent.name,
          template: template.name,
          file,
          diff: lineDiff(current, next),
          status: "available",
        });
      }
    }
    return [...available, ...this.applied];
  }

  /**
   * The owner's answer to an available update: apply writes the template's file over
   * theirs; keep leaves theirs and stops offering this version of the template.
   */
  decideTemplate(name: string, file: TemplateFile, apply: boolean): Problem | undefined {
    const agent = this.agents.get(name);
    const origin = this.origin(name);
    const template = origin && this.templateMap().get(origin.template);
    if (!agent || !origin || !template) {
      return { message: `No template update for "${name}".`, nextStep: "Reload Settings." };
    }
    if (apply) {
      const problem = this.save(withTemplateFile(agent, template, file), false);
      if (problem) return problem;
    }
    origin[file] = digest(fileText(template, file));
    this.writeOrigin(name, origin);
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
    rmSync(join(this.dir, name, ORIGIN), { force: true });
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

  /**
   * At start, after an upgrade: a file still identical to the template version it came
   * from takes the new version; a file the owner changed waits for them
   * (templateUpdates). An agent named after a template with no record, from before this
   * existed, follows it from now on, its changed files offered rather than replaced.
   */
  private followTemplates() {
    if (!this.dir) return;
    const templates = this.templateMap();
    for (const agent of [...this.agents.values()]) {
      const origin =
        this.origin(agent.name) ??
        (templates.has(agent.name)
          ? { template: agent.name, "system.md": null, "agent.json": null }
          : undefined);
      const template = origin && templates.get(origin.template);
      if (!origin || !template) continue;
      let profile = agent;
      for (const file of FILES) {
        const current = fileText(profile, file);
        const next = digest(fileText(template, file));
        if (digest(current) === next) {
          origin[file] = next;
        } else if (origin[file] === digest(current)) {
          const updated = withTemplateFile(profile, template, file);
          // A template naming a subagent this instance lacks waits for the owner instead.
          if (updated.subagents.some((s) => !this.agents.has(s))) continue;
          this.applied.push({
            agent: agent.name,
            template: template.name,
            file,
            diff: lineDiff(current, fileText(template, file)),
            status: "applied",
          });
          profile = updated;
          origin[file] = next;
        }
      }
      if (profile !== agent) this.save(profile, false);
      this.writeOrigin(agent.name, origin);
    }
  }

  /** A new agent whose prompt or settings are a template's follows that template. */
  private recordOrigin(profile: AgentProfile) {
    for (const template of this.templateMap().values()) {
      const same = FILES.some((f) => fileText(profile, f) === fileText(template, f));
      if (!same) continue;
      this.writeOrigin(profile.name, {
        template: template.name,
        "system.md": digest(fileText(template, "system.md")),
        "agent.json": digest(fileText(template, "agent.json")),
      });
      return;
    }
  }

  private templateMap(): Map<string, AgentProfile> {
    return new Map(this.templates().map((t) => [t.name, t]));
  }

  private origin(name: string): Origin | undefined {
    if (!this.dir) return undefined;
    try {
      return Origin.parse(JSON.parse(readFileSync(join(this.dir, name, ORIGIN), "utf8")));
    } catch {
      // Missing, or broken by a hand edit: the agent no longer follows a template.
      return undefined;
    }
  }

  private writeOrigin(name: string, origin: Origin) {
    if (!this.dir) return;
    writeAtomic(join(this.dir, name, ORIGIN), `${JSON.stringify(origin, null, 2)}\n`);
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

type TemplateFile = TemplateUpdate["file"];
const FILES: readonly TemplateFile[] = ["system.md", "agent.json"];
const ORIGIN = ".template.json";

/** The template an agent follows, and the digest of the template's file each of its files came from; null when unknown. */
const Origin = z.object({
  template: z.string(),
  "system.md": z.string().nullable(),
  "agent.json": z.string().nullable(),
});
type Origin = z.infer<typeof Origin>;

/** The file as the registry writes it, so equal settings compare equal whatever their spacing on disk. */
function fileText(profile: AgentProfile, file: TemplateFile): string {
  if (file === "system.md") return profile.system;
  const { name: _name, system: _system, ...json } = profile;
  return `${JSON.stringify(AgentJson.parse(json), null, 2)}\n`;
}

function withTemplateFile(
  profile: AgentProfile,
  template: AgentProfile,
  file: TemplateFile,
): AgentProfile {
  return file === "system.md"
    ? { ...profile, system: template.system }
    : { ...template, name: profile.name, system: profile.system };
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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
