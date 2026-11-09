import type { Note } from "@jabuti/protocol";
import { z } from "zod";
import { BODY_LIMIT, STATE_LIMIT, SUMMARY_LIMIT, SUMMARY_TARGET } from "../agents/state.ts";
import type { AgentProfile } from "../agents/registry.ts";
import type { Tool, ToolContext } from "./types.ts";

// One flat object rather than a union per operation: models handle it more reliably,
// and each operation checks the fields it needs below.
const Input = z.strictObject({
  op: z
    .enum(["create", "read", "update", "delete", "search", "replace"])
    .describe(
      "create, read, update, delete or search your notes; replace a whole file " +
        "(brief or user).",
    ),
  id: z.string().optional().describe("The note, such as m-0012 (read, update, delete)."),
  summary: z
    .string()
    .optional()
    .describe(
      `One line of about ${String(SUMMARY_TARGET)} characters (${String(SUMMARY_LIMIT)} at most): what the index shows.`,
    ),
  body: z
    .string()
    .optional()
    .describe(
      `The details: numbers, dates, URLs, how it was measured. At most ${String(BODY_LIMIT)} characters.`,
    ),
  check: z
    .string()
    .optional()
    .describe(
      'When to look at it again, YYYY-MM-DD, such as an experiment\'s check date; "" clears it.',
    ),
  text: z.string().optional().describe("What to search for in summaries and bodies."),
  file: z.enum(["brief", "user"]).optional().describe("For replace."),
  content: z.string().optional().describe("For replace: the whole new file, in Markdown."),
});
type Input = z.infer<typeof Input>;

/** Whether the agent keeps a brief and notes of its own (C14). */
const ownState = (agent: AgentProfile) => agent.tools.includes("memory");

/** Notes the owner wrote or approved: the agent changes them only with approval. */
const protectedNote = (note: Note) => note.source === "owner" || note.source === "capture";

export const memoryTool: Tool<Input> = {
  name: "memory",
  description: (agent) => {
    const own = ownState(agent);
    return [
      ...(own
        ? [
            "Your notes across conversations: what you learned, decided, changed and measured. " +
              "Your index is in the system prompt; read a note by id for its details. Create " +
              "one per fact, decision, experiment or run, with the numbers and dates in the " +
              "body and a check date for what must be looked at again. Update a note instead " +
              "of adding a duplicate. Jabuti records who wrote each note: [owner] and " +
              "[capture] come from the user and win any conflict; [chat] you wrote with the " +
              "user present; [auto] you wrote unattended: treat those as hypotheses until " +
              "data confirms them. Changing or deleting an [owner] or [capture] note asks " +
              "the user first. Your notes are saved at once.",
            "replace brief: what you work on (site, audience, goals); the user approves it.",
          ]
        : []),
      ...(agent.userMemory
        ? [
            'replace user: what you know about the user, one item per line starting with "- ", ' +
              "shared with their other agents; the user approves it. When the user asks you " +
              "to remember something about them, in any language, save it now.",
          ]
        : []),
      `The brief and user hold at most ${String(STATE_LIMIT)} characters each. Never save ` +
        "secrets. The system prompt keeps the version this conversation started with.",
    ].join("\n");
  },
  input: Input,
  async execute(input, ctx) {
    if (input.op === "replace") return replace(input, ctx);
    if (!ownState(ctx.agent)) return failure("You keep no notes.");
    const agent = ctx.agent.name;
    // Set by Jabuti, never by the model: auto when nobody was watching (C19).
    const author = {
      source: ctx.unattended ? ("auto" as const) : ("chat" as const),
      conversation: ctx.conversationId,
    };
    switch (input.op) {
      case "create": {
        if (input.summary === undefined) return failure("create needs a summary.");
        const note = ctx.state.createNote(
          agent,
          {
            summary: input.summary,
            body: input.body ?? "",
            check: input.check === "" ? null : (input.check ?? null),
          },
          author,
        );
        return "problem" in note ? failure(note.problem) : done(`Created ${note.id}.`);
      }
      case "read": {
        const note = input.id ? ctx.state.note(agent, input.id) : undefined;
        if (!note) return failure(`There is no note ${input.id ?? "(no id given)"}.`);
        return done(ctx.state.renderNote(note));
      }
      case "search": {
        if (!input.text) return failure("search needs text.");
        const found = ctx.state.searchNotes(agent, input.text);
        if (found.length === 0) return done(`No note mentions "${input.text}".`);
        return done(found.map((n) => `- ${n.date} ${n.id} [${n.source}] ${n.summary}`).join("\n"));
      }
      case "update":
      case "delete": {
        const current = input.id ? ctx.state.note(agent, input.id) : undefined;
        if (!current) return failure(`There is no note ${input.id ?? "(no id given)"}.`);
        const change = {
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.check !== undefined ? { check: input.check || null } : {}),
        };
        if (protectedNote(current)) {
          const after =
            input.op === "delete"
              ? ""
              : ctx.state.renderNote({
                  ...current,
                  ...(change.summary !== undefined ? { summary: change.summary.trim() } : {}),
                  ...(change.body !== undefined ? { body: change.body.trim() } : {}),
                  ...(change.check === null
                    ? { check: undefined }
                    : change.check
                      ? { check: change.check }
                      : {}),
                });
          // These come from the user: text the agent read elsewhere must not undo them unseen.
          const approved = await ctx.requestApproval({
            kind: "file",
            file: current.path,
            diff: lineDiff(ctx.state.renderNote(current), after),
            notes: [
              `A note from the ${current.source === "owner" ? "user" : "capture the user approved"}.`,
            ],
          });
          if (!approved) return failure("The user did not approve this change.");
          if (ctx.signal.aborted) return failure("Cancelled by the user.");
        }
        if (input.op === "delete") {
          ctx.state.deleteNote(agent, current.id);
          return done(`Deleted ${current.id}; its last version is kept in the history.`);
        }
        const note = ctx.state.updateNote(agent, current.id, change, author);
        return "problem" in note ? failure(note.problem) : done(`Updated ${note.id}.`);
      }
    }
  },
};

/** A whole file the user approves: the agent's brief, or user memory. */
async function replace(input: Input, ctx: ToolContext) {
  const file = input.file;
  if (!file || input.content === undefined) return failure("replace needs file and content.");
  if (file === "user" ? !ctx.agent.userMemory : !ownState(ctx.agent)) {
    return failure(`You do not keep ${file}.md.`);
  }
  if (input.content.length > STATE_LIMIT) {
    return failure(
      `Not saved: ${String(input.content.length)} characters, over the ` +
        `${String(STATE_LIMIT)} limit. Condense it and try again.`,
    );
  }
  const current = file === "user" ? ctx.state.readUser() : ctx.state.readBrief(ctx.agent.name);
  if (current === input.content) return done(`${file}.md already has this content.`);
  // Always asked, whatever the agent's permissions: these enter every future
  // conversation, so text the agent read elsewhere must not land there unseen (C14).
  const approved = await ctx.requestApproval({
    kind: "file",
    file: `${file}.md`,
    diff: lineDiff(current, input.content),
    ...(file === "user" ? { notes: ["Every agent with user memory on reads this file."] } : {}),
  });
  if (!approved) return failure("The user did not approve this change.");
  if (ctx.signal.aborted) return failure("Cancelled by the user.");
  if (file === "user") ctx.state.writeUser(input.content);
  else ctx.state.writeBrief(ctx.agent.name, input.content);
  return done(`Saved ${file}.md.`);
}

const done = (content: string) => ({ content, isError: false });
const failure = (content: string) => ({ content, isError: true });

/** Every line of both versions, prefixed "+ ", "- " or "  " (longest common subsequence). */
export function lineDiff(before: string, after: string): string {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  const width = b.length + 1;
  // lcs[i * width + j]: length of the common subsequence of a[i..] and b[j..].
  const lcs = new Uint32Array((a.length + 1) * width);
  const at = (i: number, j: number) => lcs[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left !== undefined && left === right) {
      out.push(`  ${left}`);
      i++;
      j++;
    } else if (left !== undefined && (right === undefined || at(i + 1, j) >= at(i, j + 1))) {
      out.push(`- ${left}`);
      i++;
    } else {
      out.push(`+ ${right ?? ""}`);
      j++;
    }
  }
  return out.join("\n");
}
