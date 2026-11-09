// Skills (C4): the methods agents load when a task needs one. Built-in skills come with
// Jabuti and are read-only; saving one makes the owner's version, which deleting removes.
// Which agents use a skill is set on each agent's Tools & skills page.
import type { ClientMessage, SettingsSnapshot, SkillData } from "@jabuti/protocol";
import { useState } from "react";

type Send = (message: ClientMessage) => void;

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const DESCRIPTION_LIMIT = 400;
const BODY_LIMIT = 60_000;

export function Skills(props: { settings: SettingsSnapshot; send: Send }) {
  const { skills, agents } = props.settings;
  const [open, setOpen] = useState<string>();
  const users = (name: string) => agents.filter((a) => a.skills.includes(name)).map((a) => a.name);
  return (
    <div className="memory-files notes">
      <p className="sub">
        Methods agents load when a task needs one: an agent&apos;s prompt lists only the names and
        descriptions of its skills, and it reads the whole method when it starts such a task. Turn a
        skill on per agent in its Tools &amp; skills. The agent that manages agents can also write
        skills, each saved only after you approve it. Edits apply from the next turn.
      </p>
      <div className="actions">
        <button
          onClick={() => {
            setOpen(open === "" ? undefined : "");
          }}
        >
          + New skill
        </button>
      </div>
      {open === "" && (
        <SkillEditor
          send={props.send}
          onDone={() => {
            setOpen(undefined);
          }}
        />
      )}
      <ul>
        {skills.map((skill) => (
          <li key={skill.name}>
            <button
              className="note-line"
              onClick={() => {
                setOpen(open === skill.name ? undefined : skill.name);
              }}
            >
              <span className="mono">{skill.name}</span>{" "}
              <span className={skill.source === "owner" ? "source owner" : "source"}>
                {skill.source === "built-in"
                  ? "built in"
                  : skill.replacesBuiltIn
                    ? "yours, replaces the built-in"
                    : "yours"}
              </span>{" "}
              {skill.description}
              <span className="sub">
                {" "}
                · {users(skill.name).length > 0 ? users(skill.name).join(", ") : "no agent uses it"}
              </span>
            </button>
            {open === skill.name && (
              <SkillEditor
                key={`${skill.name}:${skill.source}:${skill.description}:${skill.body}`}
                skill={skill}
                users={users(skill.name)}
                send={props.send}
                onDone={() => {
                  setOpen(undefined);
                }}
              />
            )}
          </li>
        ))}
        {skills.length === 0 && <li className="sub">No skills yet.</li>}
      </ul>
    </div>
  );
}

function SkillEditor(props: {
  skill?: SkillData;
  users?: string[];
  send: Send;
  onDone: () => void;
}) {
  const { skill } = props;
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [body, setBody] = useState(skill?.body ?? "");
  const builtIn = skill?.source === "built-in";
  // A new skill (no skill) always counts as changed.
  const changed = description !== skill?.description || body !== skill.body;
  const valid =
    NAME.test(name) &&
    description.trim() !== "" &&
    description.length <= DESCRIPTION_LIMIT &&
    body.trim() !== "" &&
    body.length <= BODY_LIMIT;
  const users = props.users ?? [];
  return (
    <div className="note-editor">
      {builtIn && (
        <div className="sub">
          Comes with Jabuti. Saving a change makes your own version, which updates no longer
          overwrite; delete yours to go back to the built-in.
        </div>
      )}
      {!skill && (
        <input
          type="text"
          aria-label="Name"
          placeholder="name-with-hyphens"
          value={name}
          onChange={(e) => {
            setName(e.target.value.toLowerCase().replace(/\s+/g, "-"));
          }}
        />
      )}
      <input
        type="text"
        aria-label="Description"
        placeholder="One line: what it does and when an agent should load it"
        value={description}
        onChange={(e) => {
          setDescription(e.target.value.replace(/\n/g, " "));
        }}
      />
      <textarea
        aria-label="Method"
        placeholder="The method, in Markdown: the goal, the steps in order, the rules, what it delivers"
        rows={Math.min(24, Math.max(8, body.split("\n").length + 1))}
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
        }}
      />
      <div className="actions">
        <span
          className={
            description.length > DESCRIPTION_LIMIT || body.length > BODY_LIMIT ? "warn" : "sub"
          }
        >
          {description.length} / {DESCRIPTION_LIMIT} · {body.length} / {BODY_LIMIT}
        </span>
        {!skill && name !== "" && !NAME.test(name) && (
          <span className="warn">Lowercase letters, digits and hyphens.</span>
        )}
        {skill?.source === "owner" && (
          <button
            onClick={() => {
              const question = skill.replacesBuiltIn
                ? `Delete your version of ${skill.name}? Agents use the built-in one again.`
                : `Delete the skill ${skill.name}?`;
              if (confirm(question)) {
                props.send({ type: "skill.delete", name: skill.name });
                props.onDone();
              }
            }}
            disabled={!skill.replacesBuiltIn && users.length > 0}
            title={
              !skill.replacesBuiltIn && users.length > 0
                ? `Turn it off in ${users.join(", ")} first.`
                : undefined
            }
          >
            {skill.replacesBuiltIn ? "Back to the built-in" : "Delete"}
          </button>
        )}
        {changed && (
          <button
            className="primary"
            disabled={!valid}
            onClick={() => {
              props.send({
                type: "skill.save",
                skill: { name, description, body },
                // A built-in's name: creating makes the owner's version of it.
                create: !skill || builtIn,
              });
              props.onDone();
            }}
          >
            {builtIn ? "Save as yours" : "Save"}
          </button>
        )}
      </div>
    </div>
  );
}
