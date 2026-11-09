// The Plan screen (one agent's milestones, experiments, routine and runs) and the
// Inbox (everything across agents that waits for the owner). Both only show what
// the server sends and ask it to act (C19); the rules live on the server.
import type {
  AgentPlan,
  ClientMessage,
  Experiment,
  Milestone,
  PlanAction,
  Routine,
  Weekday,
} from "@jabuti/protocol";
import { useState } from "react";
import { AgentIcon, ChevronDownIcon, ChevronRightIcon, PlusIcon } from "./Icons.tsx";
import { Markdown } from "./Markdown.tsx";

type Send = (message: ClientMessage) => void;
type Open = (conversationId: string) => void;

const act = (send: Send, agent: string, action: PlanAction) => {
  send({ type: "plan.action", agent, action });
};

/** What waits for the owner in one plan. */
function waiting(plan: AgentPlan) {
  return {
    experiments: plan.experiments.filter((e) => e.status === "proposed"),
    milestones: plan.milestones.filter((m) => m.status === "proposed" || m.dropRequest),
    decisions: plan.decisions,
    reports: plan.runs.filter((r) => !r.read),
  };
}

export function inboxCount(plans: AgentPlan[]): number {
  return plans.reduce((sum, plan) => {
    const w = waiting(plan);
    return sum + w.experiments.length + w.milestones.length + w.decisions.length + w.reports.length;
  }, 0);
}

// --- Plan ---

export function PlanScreen(props: {
  agent: string;
  plan: AgentPlan | undefined;
  /** A run of this agent is in progress. */
  busy: boolean;
  send: Send;
  open: Open;
}) {
  const { agent, plan, send } = props;
  const [editing, setEditing] = useState<string | undefined>(undefined); // a milestone id, or "new"
  const [filter, setFilter] = useState<"active" | "all">("active");
  if (!plan) {
    return (
      <div className="plan-screen">
        <div className="empty">
          {agent} has no plan. Turn on “Plan and routine” for it in Agents &amp; settings → Tools.
        </div>
      </div>
    );
  }
  const shown = plan.milestones
    .filter((m) => filter === "all" || (m.status !== "done" && m.status !== "dropped"))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id, "en", { numeric: true }));
  return (
    <div className="plan-screen">
      <RoutineCard plan={plan} busy={props.busy} send={send} />
      <div className="plan-toolbar">
        <button
          className="primary"
          onClick={() => {
            setEditing("new");
          }}
        >
          <PlusIcon size={16} />
          New milestone
        </button>
        <select
          aria-label="Milestones shown"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value === "all" ? "all" : "active");
          }}
        >
          <option value="active">Active milestones</option>
          <option value="all">All milestones</option>
        </select>
      </div>
      {editing === "new" && (
        <MilestoneForm
          plan={plan}
          onCancel={() => {
            setEditing(undefined);
          }}
          onSave={(fields) => {
            act(send, agent, { op: "milestone.save", fields });
            setEditing(undefined);
          }}
        />
      )}
      {plan.milestones.length === 0 && editing !== "new" ? (
        <div className="plan-empty">
          <p>This agent has no plan yet.</p>
          <div className="actions">
            <button
              className="primary"
              onClick={() => {
                act(send, agent, { op: "run", kind: "draft" });
              }}
            >
              Ask {agent} to draft a plan
            </button>
            <span className="sub">or create a milestone yourself</span>
          </div>
        </div>
      ) : (
        <ul className="milestones">
          {shown.map((m) =>
            editing === m.id ? (
              <li key={m.id}>
                <MilestoneForm
                  plan={plan}
                  milestone={m}
                  onCancel={() => {
                    setEditing(undefined);
                  }}
                  onSave={(fields, status) => {
                    act(send, agent, { op: "milestone.save", id: m.id, fields, status });
                    setEditing(undefined);
                  }}
                />
              </li>
            ) : (
              <MilestoneCard
                key={m.id}
                plan={plan}
                milestone={m}
                send={send}
                open={props.open}
                onEdit={() => {
                  setEditing(m.id);
                }}
              />
            ),
          )}
        </ul>
      )}
      <Runs plan={plan} send={send} open={props.open} />
      <PlanSettings plan={plan} send={send} />
    </div>
  );
}

function RoutineCard({
  plan,
  busy: running,
  send,
}: {
  plan: AgentPlan;
  busy: boolean;
  send: Send;
}) {
  const { routine } = plan;
  return (
    <section className="routine-card">
      <div className="routine-head">
        <span className="avatar large">
          <AgentIcon agent={plan.agent} />
        </span>
        <div className="who">
          <div className="who-name">
            {plan.agent}
            <span className={`state-pill ${routine.enabled && !plan.paused ? "on" : ""}`}>
              <span className="dot" />
              {!routine.enabled ? "Routine off" : plan.paused ? "Paused" : "Routine on"}
            </span>
          </div>
          <div className="who-sub">
            Measures every day at {routine.time} ({routine.timeZone}), acts on{" "}
            {routine.actDays.length > 0 ? routine.actDays.join(", ") : "no day"}.
            {plan.nextRun &&
              ` Next run: ${plan.nextRun.day} ${plan.nextRun.time}, ${plan.nextRun.kind}.`}
          </div>
          {plan.paused && <div className="error-text">{plan.paused}</div>}
        </div>
        <div className="routine-spend">
          <div className="mono">
            US$ {plan.monthSpentUsd.toFixed(2)} / {routine.monthlyCapUsd.toFixed(2)}
          </div>
          <div className="meter">
            <span
              style={{
                width: `${String(Math.min(100, (plan.monthSpentUsd / routine.monthlyCapUsd) * 100))}%`,
              }}
            />
          </div>
          <div className="sub">spent this month</div>
        </div>
      </div>
      <div className="actions">
        <button
          className={routine.enabled ? "" : "primary"}
          onClick={() => {
            act(send, plan.agent, {
              op: "routine.save",
              routine: { ...routine, enabled: !routine.enabled },
            });
          }}
        >
          {routine.enabled ? "Pause routine" : "Turn routine on"}
        </button>
        <button
          disabled={running}
          title="An unattended run now: it records due checks and reports, without proposing changes."
          onClick={() => {
            act(send, plan.agent, { op: "run", kind: "measure" });
          }}
        >
          Run now: measure
        </button>
        <button
          disabled={running}
          title="An unattended run now that may also propose one change."
          onClick={() => {
            act(send, plan.agent, { op: "run", kind: "act" });
          }}
        >
          Run now: act
        </button>
      </div>
    </section>
  );
}

const STATUS_LABEL: Record<Milestone["status"], string> = {
  proposed: "proposed by agent",
  pending: "pending",
  running: "running",
  done: "done",
  dropped: "dropped",
};

function MilestoneCard(props: {
  plan: AgentPlan;
  milestone: Milestone;
  send: Send;
  open: Open;
  onEdit: () => void;
}) {
  const { plan, milestone: m, send } = props;
  const [expanded, setExpanded] = useState(m.status === "running");
  const experiments = plan.experiments.filter((e) => e.milestone === m.id);
  const blocked = m.dependsOn.filter(
    (d) => plan.milestones.find((other) => other.id === d)?.status !== "done",
  );
  return (
    <li className={`milestone ${m.status}`}>
      <div className="milestone-head">
        <button
          className="chevron-button"
          aria-label={expanded ? "Collapse" : "Expand"}
          onClick={() => {
            setExpanded(!expanded);
          }}
        >
          {expanded ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}
        </button>
        <span className="mono milestone-id">{m.id}</span>
        <span className="milestone-title">{m.title}</span>
        <span className={`pill ${m.status}`}>{STATUS_LABEL[m.status]}</span>
        <span className="sub">
          {m.due ? `due ${m.due}` : "no due date"}
          {blocked.length > 0 && ` · after ${blocked.join(", ")}`}
        </span>
      </div>
      <div className="milestone-done-when">
        <span className="sub">Done when:</span> {m.doneWhen}
      </div>
      {m.progress && <div className="milestone-progress">{m.progress}</div>}
      {m.status === "proposed" && (
        <div className="actions">
          <button
            className="primary"
            onClick={() => {
              act(send, plan.agent, { op: "milestone.decide", id: m.id, approve: true });
            }}
          >
            Approve
          </button>
          <button onClick={props.onEdit}>Edit</button>
          <button
            className="danger"
            onClick={() => {
              act(send, plan.agent, { op: "milestone.decide", id: m.id, approve: false });
            }}
          >
            Reject
          </button>
        </div>
      )}
      {m.dropRequest && (
        <div className="approval">
          The agent asks to drop it: {m.dropRequest}
          <div className="actions">
            <button
              className="danger"
              onClick={() => {
                act(send, plan.agent, { op: "milestone.decide", id: m.id, approve: true });
              }}
            >
              Drop it
            </button>
            <button
              onClick={() => {
                act(send, plan.agent, { op: "milestone.decide", id: m.id, approve: false });
              }}
            >
              Keep it
            </button>
          </div>
        </div>
      )}
      {expanded && (
        <div className="milestone-body">
          <p>{m.goal}</p>
          {m.evidence && (
            <p>
              <span className="sub">Evidence:</span> {m.evidence}
            </p>
          )}
          {experiments.length === 0 ? (
            <p className="sub">No experiments yet.</p>
          ) : (
            <ul className="experiments">
              {experiments.map((e) => (
                <ExperimentCard
                  key={e.id}
                  agent={plan.agent}
                  experiment={e}
                  send={send}
                  open={props.open}
                />
              ))}
            </ul>
          )}
          {m.status !== "proposed" && (
            <div className="actions">
              <button onClick={props.onEdit}>Edit</button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

const EXPERIMENT_LABEL: Record<Experiment["status"], string> = {
  proposed: "waiting for you",
  live: "measuring",
  done: "done",
  rejected: "rejected",
  withdrawn: "withdrawn",
};

function ExperimentCard(props: { agent: string; experiment: Experiment; send: Send; open: Open }) {
  const { experiment: e, send, agent } = props;
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <li className={`experiment ${e.status}`}>
      <div className="experiment-head">
        <span className="mono">{e.id}</span>
        <span className="mono sub">{e.kind}</span>
        <span className="mono experiment-urls">{e.urls.join(" ")}</span>
        <span className={`pill ${e.status}`}>{EXPERIMENT_LABEL[e.status]}</span>
      </div>
      <div className="experiment-change">{e.change}</div>
      <dl className="experiment-facts">
        <dt>Hypothesis</dt>
        <dd>{e.hypothesis}</dd>
        <dt>Metric</dt>
        <dd>{e.metric}</dd>
        <dt>Baseline</dt>
        <dd>{e.baseline}</dd>
        {e.liveAt && (
          <>
            <dt>Live since</dt>
            <dd>{e.liveAt}</dd>
          </>
        )}
        {e.branch && (
          <>
            <dt>Branch</dt>
            <dd className="mono">{e.branch}</dd>
          </>
        )}
        {e.rejectReason && (
          <>
            <dt>Rejected</dt>
            <dd>{e.rejectReason}</dd>
          </>
        )}
      </dl>
      {e.status !== "proposed" && e.status !== "rejected" && e.status !== "withdrawn" && (
        <ul className="checks">
          {e.checks.map((c) => (
            <li key={c.day} className={c.result ? "measured" : ""}>
              <span className="mono">+{c.day}d</span>
              <span className="mono sub">{c.date ?? ""}</span>
              <span>{c.result ?? "not measured yet"}</span>
            </li>
          ))}
        </ul>
      )}
      {e.issue && <div className="error-text">{e.issue}</div>}
      <div className="actions">
        {e.compare && (
          <a href={e.compare} target="_blank" rel="noreferrer">
            Review the changes on GitHub
          </a>
        )}
        {e.conversation && (
          <button
            className="link"
            onClick={() => {
              props.open(e.conversation ?? "");
            }}
          >
            Open conversation
          </button>
        )}
      </div>
      {e.status === "proposed" &&
        (rejecting ? (
          <div className="form reject">
            <label>
              Why not? The agent sees this and will not propose the same change to these pages for a
              while.
              <textarea
                rows={2}
                value={reason}
                onChange={(ev) => {
                  setReason(ev.target.value);
                }}
              />
            </label>
            <div className="actions">
              <button
                className="danger"
                onClick={() => {
                  act(send, agent, { op: "experiment.decide", id: e.id, approve: false, reason });
                  setRejecting(false);
                }}
              >
                Reject
              </button>
              <button
                onClick={() => {
                  setRejecting(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="actions">
            <button
              className="primary"
              title={
                e.branch
                  ? "Merges the pull request: it goes live, and its measurement starts today."
                  : "Marks it live from today. Publish it yourself."
              }
              onClick={() => {
                act(send, agent, { op: "experiment.decide", id: e.id, approve: true });
              }}
            >
              {e.branch ? "Approve and merge" : "Approve: mark live"}
            </button>
            <button
              onClick={() => {
                setRejecting(true);
              }}
            >
              Reject…
            </button>
          </div>
        ))}
    </li>
  );
}

function MilestoneForm(props: {
  plan: AgentPlan;
  milestone?: Milestone;
  onSave: (
    fields: Extract<PlanAction, { op: "milestone.save" }>["fields"],
    status?: Milestone["status"],
  ) => void;
  onCancel: () => void;
}) {
  const m = props.milestone;
  const [title, setTitle] = useState(m?.title ?? "");
  const [goal, setGoal] = useState(m?.goal ?? "");
  const [doneWhen, setDoneWhen] = useState(m?.doneWhen ?? "");
  const [due, setDue] = useState(m?.due ?? "");
  const [priority, setPriority] = useState(String(m?.priority ?? props.plan.milestones.length + 1));
  const [dependsOn, setDependsOn] = useState<string[]>(m?.dependsOn ?? []);
  const [status, setStatus] = useState<Milestone["status"] | "">(m?.status ?? "");
  const others = props.plan.milestones.filter((o) => o.id !== m?.id);
  return (
    <form
      className="form milestone-form"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSave(
          {
            title,
            goal,
            doneWhen,
            due: due || null,
            dependsOn,
            priority: Number(priority) || 1,
          },
          status === "" ? undefined : status,
        );
      }}
    >
      <label>
        Title
        <input
          value={title}
          required
          onChange={(e) => {
            setTitle(e.target.value);
          }}
        />
      </label>
      <label>
        Goal
        <textarea
          rows={2}
          value={goal}
          required
          onChange={(e) => {
            setGoal(e.target.value);
          }}
        />
      </label>
      <label>
        Done when (measurable)
        <input
          value={doneWhen}
          required
          placeholder="≥80% of the 20 key pages indexed"
          onChange={(e) => {
            setDoneWhen(e.target.value);
          }}
        />
      </label>
      <div className="row">
        <label>
          Due
          <input
            type="date"
            value={due}
            onChange={(e) => {
              setDue(e.target.value);
            }}
          />
        </label>
        <label>
          Priority (lower first)
          <input
            type="number"
            min={1}
            value={priority}
            onChange={(e) => {
              setPriority(e.target.value);
            }}
          />
        </label>
        {m && (
          <label>
            Status
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as Milestone["status"]);
              }}
            >
              {(["pending", "running", "done", "dropped"] as const).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {others.length > 0 && (
        <fieldset>
          <legend>Depends on</legend>
          {others.map((o) => (
            <label key={o.id} className="check">
              <input
                type="checkbox"
                checked={dependsOn.includes(o.id)}
                onChange={(e) => {
                  setDependsOn(
                    e.target.checked ? [...dependsOn, o.id] : dependsOn.filter((d) => d !== o.id),
                  );
                }}
              />
              {o.id} {o.title}
            </label>
          ))}
        </fieldset>
      )}
      <div className="actions">
        <button className="primary" type="submit">
          {m?.status === "proposed" ? "Save and approve" : "Save"}
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Runs({ plan, send, open }: { plan: AgentPlan; send: Send; open: Open }) {
  if (plan.runs.length === 0) return null;
  return (
    <section className="plan-section">
      <div className="section-label">Runs</div>
      <ul className="runs">
        {plan.runs.slice(0, 10).map((r) => (
          <Report key={r.id} plan={plan} report={r} send={send} open={open} />
        ))}
      </ul>
    </section>
  );
}

function Report(props: {
  plan: AgentPlan;
  report: AgentPlan["runs"][number];
  send: Send;
  open: Open;
}) {
  const { plan, report: r, send } = props;
  const [expanded, setExpanded] = useState(false);
  return (
    <li className={`run ${r.read ? "" : "unread"}`}>
      <button
        className="run-head"
        onClick={() => {
          setExpanded(!expanded);
          if (!r.read) act(send, plan.agent, { op: "report.read", id: r.id });
        }}
      >
        {expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
        <span className="mono">{r.at.slice(0, 16).replace("T", " ")}</span>
        <span className="pill">{r.kind}</span>
        <span className="sub">
          {r.reason} · US$ {r.costUsd.toFixed(2)}
        </span>
        <span className="run-summary">{firstLine(r.text)}</span>
      </button>
      {expanded && (
        <div className="run-body">
          <Markdown text={r.text} />
          <button
            className="link"
            onClick={() => {
              props.open(r.conversation);
            }}
          >
            Open conversation
          </button>
        </div>
      )}
    </li>
  );
}

const WEEKDAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function PlanSettings({ plan, send }: { plan: AgentPlan; send: Send }) {
  const [expanded, setExpanded] = useState(false);
  const [routine, setRoutine] = useState<Routine>(plan.routine);
  const [controls, setControls] = useState(plan.controls.join("\n"));
  const [limits, setLimits] = useState(plan.limits);
  const [repo, setRepo] = useState(plan.publish?.github.repo ?? "");
  const [base, setBase] = useState(plan.publish?.github.base ?? "main");
  const [path, setPath] = useState(plan.publish?.github.path ?? "repo");
  return (
    <section className="plan-section">
      <button
        className="section-toggle"
        onClick={() => {
          setExpanded(!expanded);
          setRoutine(plan.routine);
          setControls(plan.controls.join("\n"));
          setLimits(plan.limits);
        }}
      >
        {expanded ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
        Routine, limits, control pages and publishing
      </button>
      {expanded && (
        <div className="plan-settings">
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              act(send, plan.agent, { op: "routine.save", routine });
            }}
          >
            <div className="row">
              <label>
                Time
                <input
                  type="time"
                  value={routine.time}
                  onChange={(e) => {
                    setRoutine({ ...routine, time: e.target.value });
                  }}
                />
              </label>
              <label>
                Time zone
                <input
                  value={routine.timeZone}
                  onChange={(e) => {
                    setRoutine({ ...routine, timeZone: e.target.value });
                  }}
                />
              </label>
              <label>
                Monthly cap (US$)
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={routine.monthlyCapUsd}
                  onChange={(e) => {
                    setRoutine({ ...routine, monthlyCapUsd: Number(e.target.value) || 1 });
                  }}
                />
              </label>
            </div>
            <fieldset>
              <legend>Acts on (measures every day)</legend>
              {WEEKDAYS.map((d) => (
                <label key={d} className="check inline">
                  <input
                    type="checkbox"
                    checked={routine.actDays.includes(d)}
                    onChange={(e) => {
                      setRoutine({
                        ...routine,
                        actDays: e.target.checked
                          ? [...routine.actDays, d]
                          : routine.actDays.filter((x) => x !== d),
                      });
                    }}
                  />
                  {d}
                </label>
              ))}
            </fieldset>
            <div className="actions">
              <button type="submit">Save routine</button>
            </div>
          </form>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              act(send, plan.agent, { op: "limits.save", limits });
            }}
          >
            <div className="row">
              <label>
                Open proposals at once
                <input
                  type="number"
                  min={1}
                  value={limits.openProposals}
                  onChange={(e) => {
                    setLimits({ ...limits, openProposals: Number(e.target.value) || 1 });
                  }}
                />
              </label>
              <label>
                Days before a rejected idea returns
                <input
                  type="number"
                  min={0}
                  value={limits.rejectCooldownDays}
                  onChange={(e) => {
                    setLimits({ ...limits, rejectCooldownDays: Number(e.target.value) || 0 });
                  }}
                />
              </label>
              <label>
                Checks (days after going live)
                <input
                  value={limits.checkDays.join(", ")}
                  onChange={(e) => {
                    const days = e.target.value
                      .split(/[,\s]+/)
                      .map(Number)
                      .filter((n) => Number.isInteger(n) && n > 0);
                    if (days.length > 0) setLimits({ ...limits, checkDays: days });
                  }}
                />
              </label>
            </div>
            <div className="actions">
              <button type="submit">Save limits</button>
            </div>
          </form>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              act(send, plan.agent, {
                op: "controls.save",
                urls: controls
                  .split("\n")
                  .map((l) => l.trim())
                  .filter(Boolean),
              });
            }}
          >
            <label>
              Control pages, one per line: never changed, so experiments can be compared to them
              <textarea
                rows={4}
                className="mono"
                value={controls}
                onChange={(e) => {
                  setControls(e.target.value);
                }}
              />
            </label>
            <div className="actions">
              <button type="submit">Save control pages</button>
            </div>
          </form>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              act(send, plan.agent, {
                op: "publish.save",
                publish: repo.trim()
                  ? {
                      github: {
                        repo: repo.trim(),
                        base: base.trim() || "main",
                        path: path.trim() || "repo",
                      },
                    }
                  : null,
              });
            }}
          >
            <div className="row">
              <label>
                GitHub repository (owner/name)
                <input
                  className="mono"
                  value={repo}
                  placeholder="empty: you publish approved changes yourself"
                  onChange={(e) => {
                    setRepo(e.target.value);
                  }}
                />
              </label>
              <label>
                Base branch
                <input
                  className="mono"
                  value={base}
                  onChange={(e) => {
                    setBase(e.target.value);
                  }}
                />
              </label>
              <label>
                Clone folder in its workspace
                <input
                  className="mono"
                  value={path}
                  onChange={(e) => {
                    setPath(e.target.value);
                  }}
                />
              </label>
            </div>
            <p className="sub">
              Jabuti pushes each proposal's branch and, when you approve, merges it into the base
              branch, with a deploy key only Jabuti holds: {plan.agent} cannot push by itself.
            </p>
            <div className="actions">
              <button type="submit">Save publishing</button>
            </div>
          </form>
          {plan.publish && <DeployKeyPanel plan={plan} send={send} />}
        </div>
      )}
    </section>
  );
}

/**
 * The deploy key Jabuti made for this agent: its public half to paste on GitHub, and
 * whether Jabuti reaches the repository with it. The private half never leaves the runner.
 */
function DeployKeyPanel({ plan, send }: { plan: AgentPlan; send: Send }) {
  const key = plan.deployKey;
  const repo = plan.publish?.github.repo ?? "";
  const [copied, setCopied] = useState(false);
  return (
    <div className="deploy-key">
      <strong>Deploy key</strong>
      {!key ? (
        <>
          <p className="sub">
            Jabuti makes a key for {plan.agent}; you add its public half to the repository on
            GitHub. Only Jabuti can use it.
          </p>
          <div className="actions">
            <button
              className="primary"
              onClick={() => {
                act(send, plan.agent, { op: "publish.key" });
              }}
            >
              Create the deploy key
            </button>
          </div>
        </>
      ) : (
        <>
          <ol>
            <li>
              Copy the public key:
              <pre className="mono key">{key.publicKey}</pre>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(key.publicKey).then(() => {
                    setCopied(true);
                  });
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </li>
            <li>
              On GitHub, open{" "}
              <a
                href={`https://github.com/${repo}/settings/keys/new`}
                target="_blank"
                rel="noreferrer"
              >
                {repo} → Settings → Deploy keys → Add deploy key
              </a>
              , paste it, name it Jabuti, and tick <strong>Allow write access</strong>.
            </li>
            <li>
              Come back and test it:{" "}
              <button
                onClick={() => {
                  act(send, plan.agent, { op: "publish.test" });
                }}
              >
                Test the connection
              </button>
            </li>
          </ol>
          <div className="sub mono">{key.fingerprint}</div>
          {key.checkedAt && !key.problem && (
            <div className="ok-text">
              ✓ Reached {repo} on {new Date(key.checkedAt).toLocaleString()}.
            </div>
          )}
          {key.problem && <div className="error-text">✗ {key.problem}</div>}
        </>
      )}
    </div>
  );
}

// --- Inbox ---

export function InboxScreen(props: { plans: AgentPlan[]; send: Send; open: Open }) {
  const { plans, send } = props;
  const items = plans.flatMap((plan) => {
    const w = waiting(plan);
    return [
      ...w.experiments.map((e) => ({
        key: `${plan.agent}/${e.id}`,
        plan,
        kind: "proposal" as const,
        e,
      })),
      ...w.milestones.map((m) => ({
        key: `${plan.agent}/${m.id}`,
        plan,
        kind: "milestone" as const,
        m,
      })),
      ...w.decisions.map((d) => ({
        key: `${plan.agent}/${d.id}`,
        plan,
        kind: "decision" as const,
        d,
      })),
      ...w.reports.map((r) => ({ key: `${plan.agent}/${r.id}`, plan, kind: "report" as const, r })),
    ];
  });
  if (items.length === 0) {
    return (
      <div className="plan-screen">
        <div className="empty">Nothing waits for you.</div>
      </div>
    );
  }
  return (
    <div className="plan-screen">
      <ul className="inbox">
        {items.map((item) => (
          <li key={item.key} className="inbox-item">
            <div className="inbox-head">
              <span className={`pill kind-${item.kind}`}>{item.kind}</span>
              <span className="avatar small">
                <AgentIcon agent={item.plan.agent} />
              </span>
              <span className="mono">{item.plan.agent}</span>
            </div>
            {item.kind === "proposal" && (
              <ul className="experiments">
                <ExperimentCard
                  agent={item.plan.agent}
                  experiment={item.e}
                  send={send}
                  open={props.open}
                />
              </ul>
            )}
            {item.kind === "milestone" && (
              <ul className="milestones">
                <MilestoneCard
                  plan={item.plan}
                  milestone={item.m}
                  send={send}
                  open={props.open}
                  onEdit={() => undefined}
                />
              </ul>
            )}
            {item.kind === "decision" && (
              <div className="decision">
                <p>
                  A routine run could not ask you, so this was refused:{" "}
                  <span className="mono">{item.d.summary}</span>
                </p>
                <div className="actions">
                  <button
                    onClick={() => {
                      props.open(item.d.conversation);
                    }}
                  >
                    Open conversation
                  </button>
                  <button
                    onClick={() => {
                      act(send, item.plan.agent, { op: "decision.dismiss", id: item.d.id });
                    }}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}
            {item.kind === "report" && (
              <ul className="runs">
                <Report plan={item.plan} report={item.r} send={send} open={props.open} />
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .filter((l) => !l.startsWith("#"))
      .map((l) => l.replace(/^[>*\-\s]+/, "").trim())
      .find(Boolean) ?? ""
  ).slice(0, 140);
}
