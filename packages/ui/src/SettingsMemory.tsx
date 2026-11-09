// What agents keep across conversations, as files the owner can edit (C14, C18):
// the user file, an agent's brief, and its notes, with who wrote each.
import type { ClientMessage, Note, NoteSource } from "@jabuti/protocol";
import { useState } from "react";

type Send = (message: ClientMessage) => void;

const SOURCE_LABELS: Record<NoteSource, string> = {
  owner: "you",
  capture: "capture, approved",
  chat: "agent, with you",
  auto: "agent, alone",
};

/** The agent's notes (C14): who wrote each, and the owner's edits, which make them theirs. */
export function Notes(props: {
  agent: string;
  notes: Note[];
  summaryLimit: number;
  bodyLimit: number;
  send: Send;
}) {
  const [filter, setFilter] = useState<"all" | "unconfirmed" | "auto">("all");
  const [open, setOpen] = useState<string>();
  const shown = props.notes.filter((n) =>
    filter === "all"
      ? true
      : filter === "auto"
        ? n.source === "auto"
        : n.source === "chat" || n.source === "auto",
  );
  return (
    <fieldset className="notes">
      <legend>Notes</legend>
      <div className="sub">
        What this agent noted, newest first. It sees this list at the start of each conversation and
        reads a note when it needs the details. Saving a note makes it yours: the agent then asks
        before changing it.
      </div>
      <div className="actions">
        <select
          aria-label="Show notes"
          value={filter}
          onChange={(e) => {
            const value = e.target.value;
            if (value === "all" || value === "unconfirmed" || value === "auto") setFilter(value);
          }}
        >
          <option value="all">All notes ({props.notes.length})</option>
          <option value="unconfirmed">Not confirmed by you</option>
          <option value="auto">Written alone</option>
        </select>
        <button
          onClick={() => {
            setOpen(open === "new" ? undefined : "new");
          }}
        >
          + New note
        </button>
      </div>
      {open === "new" && (
        <NoteEditor
          {...props}
          onDone={() => {
            setOpen(undefined);
          }}
        />
      )}
      <ul>
        {shown.map((note) => (
          <li key={note.id} className={note.source}>
            <button
              className="note-line"
              onClick={() => {
                setOpen(open === note.id ? undefined : note.id);
              }}
            >
              <span className="sub">
                {note.date} {note.id}
              </span>{" "}
              <span className={`source ${note.source}`}>{SOURCE_LABELS[note.source]}</span>{" "}
              {note.summary}
              {note.check && <span className="sub"> · check {note.check}</span>}
            </button>
            {open === note.id && (
              <NoteEditor
                key={`${note.id}:${note.date}:${note.summary}:${note.body}`}
                {...props}
                note={note}
                onDone={() => {
                  setOpen(undefined);
                }}
              />
            )}
          </li>
        ))}
        {shown.length === 0 && <li className="sub">No notes here yet.</li>}
      </ul>
    </fieldset>
  );
}

function NoteEditor(props: {
  agent: string;
  note?: Note;
  summaryLimit: number;
  bodyLimit: number;
  send: Send;
  onDone: () => void;
}) {
  const { note } = props;
  const [summary, setSummary] = useState(note?.summary ?? "");
  const [body, setBody] = useState(note?.body ?? "");
  const [check, setCheck] = useState(note?.check ?? "");
  // A new note (no note) always counts as changed: its summary is never undefined.
  const changed = summary !== note?.summary || body !== note.body || check !== (note.check ?? "");
  const valid =
    summary.trim() !== "" && summary.length <= props.summaryLimit && body.length <= props.bodyLimit;
  const save = () => {
    props.send({
      type: "note.save",
      agent: props.agent,
      ...(note ? { id: note.id } : {}),
      summary,
      body,
      check: check || null,
    });
    props.onDone();
  };
  return (
    <div className="note-editor">
      {note?.conversation && (
        <div className="sub">
          Last changed by {SOURCE_LABELS[note.source]} in conversation{" "}
          {note.conversation.slice(0, 8)}; previous versions are kept in {props.agent}
          /memories/.history/.
        </div>
      )}
      <input
        type="text"
        aria-label="Summary"
        placeholder="One line: what the index shows"
        value={summary}
        onChange={(e) => {
          setSummary(e.target.value.replace(/\n/g, " "));
        }}
      />
      <textarea
        aria-label="Details"
        placeholder="Details: numbers, dates, URLs, how it was measured"
        rows={Math.min(14, Math.max(4, body.split("\n").length + 1))}
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
        }}
      />
      <div className="actions">
        <label className="sub">
          Check on{" "}
          <input
            type="date"
            value={check}
            onChange={(e) => {
              setCheck(e.target.value);
            }}
          />
        </label>
        <span
          className={
            summary.length > props.summaryLimit || body.length > props.bodyLimit ? "warn" : "sub"
          }
        >
          {summary.length} / {props.summaryLimit} · {body.length} / {props.bodyLimit}
        </span>
        {note && (
          <button
            onClick={() => {
              if (confirm(`Delete ${note.id}? Its last version is kept in the history.`)) {
                props.send({ type: "note.delete", agent: props.agent, id: note.id });
                props.onDone();
              }
            }}
          >
            Delete
          </button>
        )}
        {note && note.source !== "owner" && !changed && (
          <button className="primary" onClick={save}>
            Confirm
          </button>
        )}
        {changed && (
          <button className="primary" disabled={!valid} onClick={save}>
            Save
          </button>
        )}
      </div>
    </div>
  );
}

export function MemoryFile(props: {
  title: string;
  hint: string;
  content: string;
  limit: number;
  onSave: (content: string) => void;
}) {
  // Keyed by its content (below): a capture approved elsewhere remounts it with the new version.
  const [text, setText] = useState(props.content);
  const over = text.length > props.limit;
  return (
    <fieldset>
      <legend>{props.title}</legend>
      <div className="sub">{props.hint}</div>
      <textarea
        rows={Math.min(14, Math.max(4, text.split("\n").length + 1))}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
        }}
      />
      <div className="actions">
        <span className={over ? "warn" : "sub"}>
          {text.length} / {props.limit}
        </span>
        <button
          className="primary"
          disabled={text === props.content || over}
          onClick={() => {
            props.onSave(text);
          }}
        >
          Save
        </button>
      </div>
    </fieldset>
  );
}
