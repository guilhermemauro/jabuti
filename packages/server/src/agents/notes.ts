// An agent's notes on disk (C14), written only through AgentState: one Markdown file
// per note in memories/, with its fields in a front matter Jabuti writes, and an
// index.md Jabuti regenerates from them. The model never writes either directly, so
// ids, dates, sources and paths are always consistent.
//
// The notes are the source of truth; index.md is a view for people, rebuilt after
// every change. Before a note changes or goes, its previous version is copied to
// memories/.history/, so any change can be undone.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  NOTE_SUMMARY_LIMIT,
  NOTE_SUMMARY_TARGET,
  type Note,
  type NoteSource,
} from "@jabuti/protocol";

/** One line in the index. */
export const SUMMARY_LIMIT = NOTE_SUMMARY_LIMIT;
/** What models are asked for; SUMMARY_LIMIT is what is accepted. */
export const SUMMARY_TARGET = NOTE_SUMMARY_TARGET;
/** A note is read on demand, so it may be longer than a line, not than a page. */
export const BODY_LIMIT = 4_000;
/** The index in the system prompt: the newest notes up to this many characters. */
const INDEX_LIMIT = 6_000;

const ID = /^m-(\d{4,})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FIELDS = ["id", "date", "source", "conversation", "summary", "check"] as const;
const SOURCES: readonly string[] = ["owner", "chat", "auto", "capture"];

export interface NoteInput {
  summary: string;
  body: string;
  /** null clears it. */
  check?: string | null;
}

export interface Author {
  source: NoteSource;
  conversation?: string;
}

export class Notes {
  private readonly dir: string;
  private readonly agentDir: string;

  constructor(agentDir: string) {
    this.agentDir = agentDir;
    this.dir = join(agentDir, "memories");
  }

  /** Newest change first; ids break ties, newest first. */
  list(): Note[] {
    this.migrate();
    if (!existsSync(this.dir)) return [];
    const notes = readdirSync(this.dir)
      .filter((name) => name.endsWith(".md"))
      .flatMap((name) => {
        const note = parse(readFileSync(join(this.dir, name), "utf8"), `memories/${name}`);
        return note ? [note] : [];
      });
    return notes.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  }

  get(id: string): Note | undefined {
    return this.list().find((n) => n.id === id);
  }

  /** Every note whose summary or body holds the text, ignoring case. */
  search(text: string): Note[] {
    const needle = text.toLowerCase();
    return this.list().filter((n) => `${n.summary}\n${n.body}`.toLowerCase().includes(needle));
  }

  create(input: NoteInput, author: Author, today: string): Note | { problem: string } {
    const problem = invalid(input);
    if (problem) return { problem };
    const id = `m-${String(this.nextNumber()).padStart(4, "0")}`;
    const note = this.build(id, `memories/${id}-${slug(input.summary)}.md`, input, author, today);
    this.store(note);
    return note;
  }

  /** Unset fields keep their value. */
  update(
    id: string,
    input: Partial<NoteInput>,
    author: Author,
    today: string,
  ): Note | { problem: string } {
    const current = this.get(id);
    if (!current) return { problem: `There is no note ${id}.` };
    const merged: NoteInput = {
      summary: input.summary ?? current.summary,
      body: input.body ?? current.body,
      check: input.check === undefined ? (current.check ?? null) : input.check,
    };
    const problem = invalid(merged);
    if (problem) return { problem };
    const note = this.build(id, current.path, merged, author, today);
    this.keep(current);
    this.store(note);
    return note;
  }

  delete(id: string): boolean {
    const current = this.get(id);
    if (!current) return false;
    this.keep(current);
    rmSync(join(this.agentDir, current.path));
    this.reindex();
    return true;
  }

  /** The note as its file holds it. */
  static render(note: Note): string {
    const lines = FIELDS.flatMap((field) => {
      const value = note[field];
      return value === undefined ? [] : [`${field}: ${value}`];
    });
    return `---\n${lines.join("\n")}\n---\n${note.body.trim()}\n`;
  }

  /** The index lines the agent sees at the start of a conversation (C7). */
  static index(notes: Note[]): string {
    const lines: string[] = [];
    let size = 0;
    for (const note of notes) {
      const line = indexLine(note);
      if (size + line.length > INDEX_LIMIT) {
        lines.push(
          `(${String(notes.length - lines.length)} older notes not shown: find them with search.)`,
        );
        break;
      }
      lines.push(line);
      size += line.length + 1;
    }
    return lines.join("\n");
  }

  private build(id: string, path: string, input: NoteInput, author: Author, today: string): Note {
    return {
      id,
      date: today,
      source: author.source,
      ...(author.conversation ? { conversation: author.conversation } : {}),
      summary: input.summary.trim(),
      ...(input.check ? { check: input.check } : {}),
      body: input.body.trim(),
      path,
    };
  }

  private store(note: Note) {
    writeAtomic(join(this.agentDir, note.path), Notes.render(note));
    this.reindex();
  }

  /** The version about to change, kept for undo. */
  private keep(note: Note) {
    const history = join(this.dir, ".history");
    mkdirSync(history, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    copyFileSync(join(this.agentDir, note.path), join(history, `${note.id}-${stamp}.md`));
  }

  private reindex() {
    const lines = this.list().map((n) => `${indexLine(n)} → ${n.path}`);
    writeAtomic(join(this.agentDir, "index.md"), lines.length > 0 ? `${lines.join("\n")}\n` : "");
  }

  /** Never an id used before, even by a deleted note: conversations still name it. */
  private nextNumber(): number {
    const used = [this.dir, join(this.dir, ".history")].flatMap((dir) =>
      existsSync(dir) ? readdirSync(dir) : [],
    );
    const numbers = used.map((name) =>
      Number(ID.exec(name.slice(0, name.indexOf("-", 2)))?.[1] ?? 0),
    );
    return Math.max(0, ...numbers) + 1;
  }

  /**
   * memory.md from before notes: each item becomes a note of the owner's, who
   * approved every one. The file is renamed, not deleted.
   */
  private migrate() {
    const old = join(this.agentDir, "memory.md");
    if (!existsSync(old) || existsSync(this.dir)) return;
    mkdirSync(this.dir, { recursive: true });
    const day = statSync(old).mtime.toISOString().slice(0, 10);
    const lines = readFileSync(old, "utf8").split("\n");
    const items = lines
      .flatMap((l) => (l.startsWith("- ") ? [l.slice(2).trim()] : []))
      .filter(Boolean);
    const loose = lines.filter((l) => !l.startsWith("- ") && l.trim() !== "").join("\n");
    if (loose) items.unshift(loose);
    for (const item of items) {
      const oneLine = item.replace(/\s+/g, " ");
      const summary =
        oneLine.length <= SUMMARY_LIMIT ? oneLine : `${oneLine.slice(0, SUMMARY_LIMIT - 1)}…`;
      const id = `m-${String(this.nextNumber()).padStart(4, "0")}`;
      const note = this.build(
        id,
        `memories/${id}-${slug(summary)}.md`,
        { summary, body: summary === item ? "" : item },
        { source: "owner" },
        day,
      );
      writeAtomic(join(this.agentDir, note.path), Notes.render(note));
    }
    renameSync(old, `${old}.migrated`);
    this.reindex();
  }
}

/** Why a note cannot be saved, or undefined. */
function invalid(input: NoteInput): string | undefined {
  const summary = input.summary.trim();
  if (!summary) return "A note needs a summary.";
  if (/[\r\n]/.test(summary)) return "The summary must be one line.";
  if (summary.length > SUMMARY_LIMIT) {
    return `The summary has ${String(summary.length)} characters, over ${String(SUMMARY_LIMIT)}: shorten it to about ${String(SUMMARY_TARGET)} and put details in the body.`;
  }
  if (input.body.length > BODY_LIMIT) {
    return `The body has ${String(input.body.length)} characters, over ${String(BODY_LIMIT)}: condense it, or split it into notes.`;
  }
  if (input.check && !DAY.test(input.check)) return "check must be a date, YYYY-MM-DD.";
  return undefined;
}

function indexLine(note: Note): string {
  const check = note.check ? ` · check ${note.check}` : "";
  return `- ${note.date} ${note.id} [${note.source}] ${note.summary}${check}`;
}

/** A note file, or undefined for a file that is not one (kept, never shown). */
function parse(text: string, path: string): Note | undefined {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? "").split("\n")) {
    const at = line.indexOf(": ");
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 2).trim());
  }
  const id = fields.get("id");
  const date = fields.get("date");
  const source = fields.get("source");
  const summary = fields.get("summary");
  if (!id || !ID.test(id) || !date || !source || !SOURCES.includes(source) || !summary)
    return undefined;
  const conversation = fields.get("conversation");
  const check = fields.get("check");
  return {
    id,
    date,
    source: source as NoteSource,
    ...(conversation ? { conversation } : {}),
    summary,
    ...(check ? { check } : {}),
    body: (match[2] ?? "").trim(),
    path,
  };
}

/** Plain lowercase words of the summary, for a readable file name. */
function slug(summary: string): string {
  const words =
    summary
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? [];
  let out = "";
  for (const word of words) {
    if (`${out}-${word}`.length > 40) break;
    out = out ? `${out}-${word}` : word;
  }
  return out || "note";
}

/** Write then rename, so a crash never leaves a half-written file. */
export function writeAtomic(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, content);
  renameSync(`${path}.tmp`, path);
}
