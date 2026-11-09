// The only writer of agent state on disk: data/agents/<name>/ holds brief.md (what
// the agent works on, e.g. one site), its notes (memories/ and index.md, see
// notes.ts) and workspace/ (its shell files). data/user.md holds what Jabuti knows
// about the user, read by every agent with user memory on (C18).
// The sandbox mounts only workspace/, so the shell cannot edit the brief or notes
// (C14): the brief and user memory change only with the owner's approval; notes
// through the memory tool, which asks before changing one of the owner's.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryChange, Note } from "@jabuti/protocol";
import {
  BODY_LIMIT,
  Notes,
  SUMMARY_LIMIT,
  SUMMARY_TARGET,
  writeAtomic,
  type Author,
  type NoteInput,
} from "./notes.ts";
import { Plans } from "./plan.ts";

export { BODY_LIMIT, SUMMARY_LIMIT, SUMMARY_TARGET };

/** The brief and user memory each enter every request of a conversation: kept short. */
export const STATE_LIMIT = 6_000;

export class AgentState {
  private readonly dir: string;
  private readonly userFile: string;
  /** Milestones, experiments and routine (C19): plan.json, written only by Plans. */
  readonly plans: Plans;

  /** `userFile` defaults to user.md in `dir`; no agent can be named that. */
  constructor(dir: string, userFile = join(dir, "user.md"), today?: () => string) {
    this.dir = dir;
    this.userFile = userFile;
    this.plans = new Plans(dir, today);
  }

  workspace(agent: string): string {
    const dir = join(this.dir, agent, "workspace");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  readBrief(agent: string): string {
    return readOrEmpty(join(this.dir, agent, "brief.md"));
  }

  writeBrief(agent: string, content: string) {
    writeAtomic(join(this.dir, agent, "brief.md"), content);
  }

  readUser(): string {
    return readOrEmpty(this.userFile);
  }

  writeUser(content: string) {
    writeAtomic(this.userFile, content);
  }

  // --- Notes ---

  notes(agent: string): Note[] {
    return this.notesOf(agent).list();
  }

  note(agent: string, id: string): Note | undefined {
    return this.notesOf(agent).get(id);
  }

  searchNotes(agent: string, text: string): Note[] {
    return this.notesOf(agent).search(text);
  }

  createNote(agent: string, input: NoteInput, author: Author): Note | { problem: string } {
    return this.notesOf(agent).create(input, author, today());
  }

  updateNote(
    agent: string,
    id: string,
    input: Partial<NoteInput>,
    author: Author,
  ): Note | { problem: string } {
    return this.notesOf(agent).update(id, input, author, today());
  }

  deleteNote(agent: string, id: string): boolean {
    return this.notesOf(agent).delete(id);
  }

  /** The note as stored, for a diff the owner approves. */
  renderNote(note: Note): string {
    return Notes.render(note);
  }

  /**
   * User memory with approved changes applied, item by item (C18), without writing
   * it. An item is a line starting with "- "; other lines are the owner's and stay as
   * they are. A problem instead when an item is gone or the file would pass the limit.
   */
  withUserChanges(changes: MemoryChange[]): { content: string } | { problem: string } {
    const current = this.readUser();
    const lines = current === "" ? [] : current.replace(/\n+$/, "").split("\n");
    for (const change of changes) {
      if (change.op === "add") {
        lines.push(`- ${oneLine(change.text)}`);
        continue;
      }
      const at = lines.findIndex((l) => item(l) === change.before);
      if (at === -1) {
        return {
          problem: `"${change.before ?? ""}" is no longer in the memory: it was edited meanwhile.`,
        };
      }
      if (change.op === "remove") lines.splice(at, 1);
      else lines[at] = `- ${oneLine(change.text)}`;
    }
    const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    if (content.length > STATE_LIMIT) {
      return {
        problem: `The memory would hold ${String(content.length)} characters, over the ${String(STATE_LIMIT)} limit.`,
      };
    }
    return { content };
  }

  /**
   * What the agent knows as the conversation sees it for its whole life: taken once,
   * when it starts, so the system prompt stays byte-identical (C7). Notes appear as
   * their index; their bodies are read on demand.
   */
  snapshot(
    agent: string,
    show: { own: boolean; user: boolean; plan?: boolean; reports?: number },
  ): string {
    const sections: string[] = [];
    const user = show.user ? this.readUser().trim() : "";
    // Only when there is something: an empty section would be noise in every prompt.
    if (user) sections.push("# What you know about the user", user, "");
    if (show.own) {
      const notes = this.notes(agent);
      const due = notes.filter((n) => n.check !== undefined && n.check <= today());
      sections.push(
        "# brief.md: what you work on",
        this.readBrief(agent).trim() || "(empty)",
        "",
        "# Your notes, newest first (read one with the memory tool)",
        Notes.index(notes) || "(none yet)",
        "",
      );
      if (due.length > 0) {
        sections.push(`# Due by today (${today()}): check these first`, Notes.index(due), "");
      }
    }
    // Milestones, open experiments, checks due and locks (C19); reports in unattended runs.
    if (show.plan) {
      const plans = this.plans;
      sections.push(plans.render(plans.get(agent), { reports: show.reports ?? 0 }));
    }
    if (sections.length === 0) return "";
    sections.push(
      "This is as it was when this conversation started. Changes saved now apply " +
        "from the next conversation on.",
    );
    return sections.join("\n");
  }

  private notesOf(agent: string): Notes {
    return new Notes(join(this.dir, agent));
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The item a line holds, or undefined for a line that is not an item. */
function item(line: string): string | undefined {
  return line.startsWith("- ") ? line.slice(2).trim() : undefined;
}

/** The items of a memory file, in order. */
export function items(content: string): string[] {
  return content.split("\n").flatMap((line) => item(line) ?? []);
}

/** An item is one line: a newline would make it two. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
