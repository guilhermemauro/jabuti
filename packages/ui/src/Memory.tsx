// What the capture proposes to remember (C18): one card per proposal, each change
// kept or dropped and editable before saving. Nothing is saved until the owner does.
import {
  NOTE_SUMMARY_LIMIT,
  type ClientMessage,
  type MemoryChange,
  type MemoryProposal,
} from "@jabuti/protocol";
import { useState } from "react";

type Send = (message: ClientMessage) => void;

export function MemoryProposals(props: { proposals: MemoryProposal[]; send: Send }) {
  if (props.proposals.length === 0) return null;
  return (
    <div className="memory-proposals">
      {props.proposals.map((p) => (
        <ProposalCard key={p.id} proposal={p} send={props.send} />
      ))}
    </div>
  );
}

const OP_LABELS = { add: "New", update: "Change", remove: "Forget" } as const;

function ProposalCard({ proposal, send }: { proposal: MemoryProposal; send: Send }) {
  const [kept, setKept] = useState(() => proposal.changes.map(() => true));
  const [texts, setTexts] = useState(() => proposal.changes.map((c) => c.text));
  const count = proposal.changes.length;
  // A note's summary is one line in its index: the server refuses a longer one.
  const tooLong = (i: number) =>
    proposal.changes[i]?.scope === "agent" &&
    proposal.changes[i].op !== "remove" &&
    (texts[i] ?? "").trim().length > NOTE_SUMMARY_LIMIT;
  const blocked = proposal.changes.some((_, i) => kept[i] && tooLong(i));
  const decide = (accept: { index: number; text: string }[]) => {
    send({ type: "memory.decide", proposalId: proposal.id, accept });
  };
  return (
    <div className="memory-card">
      <div className="title">
        🧠 {count === 1 ? "1 thing" : `${String(count)} things`} to remember from “
        {proposal.conversationTitle}” <span className="sub">· {proposal.agent}</span>
      </div>
      <ul>
        {proposal.changes.map((change, i) => (
          <li key={i}>
            <label>
              <input
                type="checkbox"
                checked={kept[i] ?? false}
                onChange={(e) => {
                  setKept(kept.map((k, j) => (j === i ? e.target.checked : k)));
                }}
              />
              <span className={`op ${change.op}`}>{OP_LABELS[change.op]}</span>
              <span className="sub">{scopeLabel(change, proposal.agent)}</span>
            </label>
            {change.before !== undefined && <div className="before">{change.before}</div>}
            {change.op !== "remove" && (
              <input
                type="text"
                aria-label="What to remember"
                value={texts[i] ?? ""}
                disabled={!kept[i]}
                onChange={(e) => {
                  setTexts(texts.map((t, j) => (j === i ? e.target.value : t)));
                }}
              />
            )}
            {kept[i] && tooLong(i) && (
              <div className="warn">
                {(texts[i] ?? "").trim().length} / {NOTE_SUMMARY_LIMIT} characters: shorten it to
                one line.
              </div>
            )}
            {change.evidence && <div className="evidence">“{change.evidence}”</div>}
          </li>
        ))}
      </ul>
      <div className="actions">
        <span className="sub">Read for US$ {proposal.costUsd.toFixed(4)}</span>
        <button
          onClick={() => {
            decide([]);
          }}
        >
          Discard
        </button>
        <button
          className="primary"
          disabled={!kept.some(Boolean) || blocked}
          onClick={() => {
            decide(
              proposal.changes.flatMap((_, index) =>
                kept[index] ? [{ index, text: (texts[index] ?? "").trim() }] : [],
              ),
            );
          }}
        >
          Save selected
        </button>
      </div>
    </div>
  );
}

function scopeLabel(change: MemoryChange, agent: string): string {
  return change.scope === "user" ? "about you" : `${agent}'s notes`;
}
