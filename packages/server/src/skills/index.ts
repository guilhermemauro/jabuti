// Skills (C4): methods an agent loads when a task needs them. Each is a folder with a
// SKILL.md: front matter with a one-line description, then the body. The system prompt
// lists only the name and description of the skills an agent's profile names; the body
// reaches the context when the agent loads it with the skill tool.
//
// Two folders: the repository's skills/ (built in, updated with Jabuti, never written)
// and the data folder's skills/ (the owner's: written here, from Settings or the agents
// tool, or by hand). An owner's skill with a built-in's name replaces it, so the owner
// can adapt one without an update overwriting it. Read from disk at each run: an edit
// applies from the next turn, and nothing is cached twice. This module is the only
// writer of skill files.
import {
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
  type Problem,
  type SkillData,
  type SkillInfo,
  type SkillInput,
} from "@jabuti/protocol";

const DESCRIPTION_LIMIT = 400;
const BODY_LIMIT = 60_000;

export interface Skill extends SkillInfo {
  body: string;
}

export class Skills {
  private readonly fixed: Skill[];
  private readonly dirs: { builtIn: string; owner: string } | undefined;

  /** In memory, for tests; or read from the two folders. */
  constructor(skills: Skill[] = [], dirs?: { builtIn: string; owner: string }) {
    this.fixed = skills;
    this.dirs = dirs;
  }

  /** Every skill, by name, and the folders that could not be read as one. */
  load(): { skills: Skill[]; problems: Problem[] } {
    if (!this.dirs) return { skills: this.fixed, problems: [] };
    const builtIn = read(this.dirs.builtIn, "built-in");
    const owner = read(this.dirs.owner, "owner");
    const byName = new Map<string, Skill>();
    for (const skill of [...builtIn.skills, ...owner.skills]) byName.set(skill.name, skill);
    return {
      skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
      problems: [...builtIn.problems, ...owner.problems],
    };
  }

  /** For the settings screen: bodies, and which of the owner's replace a built-in. */
  data(): SkillData[] {
    const builtIn = this.dirs ? read(this.dirs.builtIn, "built-in").skills : [];
    return this.load().skills.map((s) => ({
      ...s,
      replacesBuiltIn: s.source === "owner" && builtIn.some((b) => b.name === s.name),
    }));
  }

  get(name: string): Skill | undefined {
    return this.load().skills.find((s) => s.name === name);
  }

  /**
   * Writes the owner's skill. create refuses a name in use, except a built-in's: that
   * makes the owner's version of it. Without create, the skill must exist.
   */
  save(input: SkillInput, create: boolean): Problem | undefined {
    if (!this.dirs) return readOnly();
    const current = this.get(input.name);
    if (create && current?.source === "owner") {
      return {
        message: `The skill "${input.name}" already exists.`,
        nextStep: "Pick another name, or edit the existing skill.",
      };
    }
    if (!create && !current) {
      return { message: `There is no skill "${input.name}".`, nextStep: "Create it first." };
    }
    const folder = join(this.dirs.owner, input.name);
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "SKILL.md");
    writeFileSync(`${file}.tmp`, format(input));
    renameSync(`${file}.tmp`, file);
    return undefined;
  }

  /** Deletes the owner's skill folder; a built-in of the same name is used again. */
  remove(name: string): Problem | undefined {
    if (!this.dirs) return readOnly();
    const skill = this.get(name);
    if (skill?.source !== "owner") {
      return {
        message: skill ? `"${name}" is built in: it cannot be deleted.` : `No skill "${name}".`,
        nextStep: skill ? "Turn it off in the agents that use it." : "Reload settings.",
      };
    }
    rmSync(join(this.dirs.owner, name), { recursive: true, force: true });
    return undefined;
  }

  list(): SkillInfo[] {
    return this.load().skills.map(({ name, description, source }) => ({
      name,
      description,
      source,
    }));
  }

  /** The skills a profile names, in its order, and those that do not exist. */
  for(names: readonly string[]): { skills: Skill[]; problems: Problem[] } {
    const { skills } = this.load();
    const found: Skill[] = [];
    const problems: Problem[] = [];
    for (const name of names) {
      const skill = skills.find((s) => s.name === name);
      if (skill) found.push(skill);
      else
        problems.push({
          message: `The skill "${name}" does not exist: the agent works without it.`,
          nextStep: "Remove it from the agent in Settings → Tools, or add its folder to skills/.",
        });
    }
    return { skills: found, problems };
  }
}

/** The system prompt's list (C4): name and description only, never the body. */
export function skillList(skills: readonly SkillInfo[]): string {
  if (skills.length === 0) return "";
  return [
    "# Skills",
    "Methods for tasks you may get. Before starting a task one covers, load it with the " +
      "skill tool and follow it; once loaded it stays in the conversation.",
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join("\n");
}

function read(dir: string, source: SkillInfo["source"]): { skills: Skill[]; problems: Problem[] } {
  const skills: Skill[] = [];
  const problems: Problem[] = [];
  if (!existsSync(dir)) return { skills, problems };
  for (const name of readdirSync(dir)) {
    const folder = join(dir, name);
    const file = join(folder, "SKILL.md");
    if (!statSync(folder).isDirectory() || !existsSync(file)) continue;
    const where = `${source === "owner" ? "data/" : ""}skills/${name}/SKILL.md`;
    if (!AGENT_NAME.test(name)) {
      problems.push({
        message: `Skill folder "${name}" has an invalid name.`,
        nextStep: "Rename it using only lowercase letters, digits and hyphens.",
      });
      continue;
    }
    const parsed = parse(readFileSync(file, "utf8"));
    if ("problem" in parsed) {
      problems.push({ message: `${where}: ${parsed.problem}`, nextStep: FORMAT });
      continue;
    }
    skills.push({ name, source, ...parsed });
  }
  return { skills, problems };
}

/** The file as written: what parse() reads back. */
export function format(skill: SkillInput): string {
  return `---\ndescription: ${skill.description.trim()}\n---\n\n${skill.body.trim()}\n`;
}

function readOnly(): Problem {
  return {
    message: "Skills are read-only here.",
    nextStep: "This server was started without a skills folder.",
  };
}

const FORMAT =
  "Start the file with front matter: a line ---, a line description: <one line>, a line ---, then the method.";

/** "---\ndescription: ...\n---\nbody". Other front-matter keys are ignored. */
function parse(text: string): { description: string; body: string } | { problem: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { problem: "no front matter." };
  const front = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  const description = /^description:\s*(.+)$/m
    .exec(front)?.[1]
    ?.trim()
    .replace(/^"(.*)"$/, "$1");
  if (!description) return { problem: "no description in the front matter." };
  if (description.length > DESCRIPTION_LIMIT) {
    return { problem: `the description is over ${String(DESCRIPTION_LIMIT)} characters.` };
  }
  if (!body) return { problem: "no method after the front matter." };
  if (body.length > BODY_LIMIT) {
    return { problem: `the method is over ${String(BODY_LIMIT)} characters.` };
  }
  return { description, body };
}
