# AGENTS.md — Jabuti

Instructions for coding agents. Read it all before changing code.

Keep this file under 12,000 characters so agents load it whole. When a rule grows long, move it to a scoped `AGENTS.md` in the directory that owns it and leave a one-line pointer here.

This project follows [Impatient Programming](https://impatientprogramming.org/rules/). The rules below are how they apply here.

## The story (IMP rule 1)

**Jabuti** is a general-purpose agent harness in TypeScript, built without any agent framework, with a graphical interface. The user configures several agents, each with its own model (any provider), system prompt, skills, MCP connectors and permissions, and switches between them. Agents can use a shell to write and run code. It deploys as a container, self-hosted by one owner.

**Done means:** an SEO agent running on this harness pulls Google Search Console data through an MCP connector, writes a script in its shell to analyze it, and delivers a quick-wins report in the interface.

## Hard constraints

- **No agent frameworks.** No LangChain, LangGraph, CrewAI, Mastra, Vercel AI SDK agents, Claude Agent SDK or similar. The loop, tool registry, context management, permissions, skills loader and agent switching are written here, by hand: understanding them is the point.
- **Allowed libraries:** `@anthropic-ai/sdk` (API client), `@modelcontextprotocol/sdk` (protocol, not orchestration), `zod`, React + Vite for the UI, a WebSocket library, `vitest`, and Docker for the shell sandbox. Anything else needs a reasoned line in `docs/DECISIONS.md`.
- **TypeScript, strict.** No `any` without a comment on why.

## Design priorities

- **One owner per responsibility.** Each piece of state (conversations, agent profiles, MCP connections, approvals) has one module that writes it; others call it. No second copy or competing cache.
- **Small core, capable edges.** Each built-in tool costs context on every request. New capability goes first to a skill, then an MCP server, only last a core tool.
- **Stable conversation context.** History only appends (C10). Per-turn facts (time, approvals, status) go in that turn's message, not the system prompt. See C7 and C10.
- **Design for real failures.** Crashes, restarts, timeouts, a dying MCP server, not theoretical races. Name accepted edge cases in a comment or the PR.
- **Every action shows its outcome** (C11).

```
ui (React, browser)  ⇄  HTTP + WebSocket  ⇄  server (Node)
  ├─ http + auth      (login, serves the UI)
  ├─ agent registry   (profiles on disk)
  ├─ conversation store
  ├─ loop             (one per running conversation)
  ├─ providers        (model adapters)
  ├─ tool registry    (built-in, MCP, skills)
  ├─ mcp clients      (hold connector credentials)
  ├─ agent state      (brief, notes, plan, workspace)
  ├─ autopilot        (routine runs, inbox, publishing)
  ├─ shell sandbox    (local Docker, or the runner)
  └─ tracer           (JSONL per conversation)
```

- **Agent = profile.** `data/agents/<name>/agent.json` (model, budget, tools, MCP, skills…) and `system.md`, edited in Settings or by hand: agents are data. Its folder also holds its brief, notes and workspace (C14). The repo's `agents/` holds templates.
- **Agents switch inside a conversation** (C6).
- **Secrets live in the server process only.** The model never sees them, and the shell container never inherits them. The exception is a variable the owner marks for an agent's shell (C16).
- **State in SQLite** (conversations, owner, sessions, settings). Files for brief and notes (the user edits them too), workspaces, traces.

## The Contract (IMP rules 13, 20, 29)

Every obligation below is a test in `contract/`, named after its ID, run against a **fake model** (scripted, no API): deterministic and free.

| ID | Obligation |
|---|---|
| C1 | The loop ends when the model replies without a tool call, or past the budget (steps or cost): a clean stop with a message, never a crash. |
| C2 | Every tool call receives exactly one tool result, including on error, timeout or user denial. |
| C3 | Shell commands run in a container without secrets, each agent confined to its own workspace (locally one container per agent; deployed one Unix user per agent in the runner, keeping its files across rebuilds). Only the agent's own shell variables (C16) reach them, nothing from the host or runner. |
| C4 | The system prompt lists only the name and description of each enabled skill. A skill's body enters the context only when the skill is loaded. |
| C5 | MCP tools are exposed as `mcp__<server>__<tool>`, only to agents listing the server. Each agent gets its own connection, with only the variables it needs from its scope (C16), never the server's environment. Registered servers offer only tools the owner turned on, those set to ask after approval; OAuth tokens are encrypted. A returned file is saved in the agent's workspace, as the agent; the model gets the path. A failing connector loses its tools, shown with a next step; the agent keeps working; it restarts next turn. |
| C6 | Each turn runs with the tools, skills, MCP servers and permissions of its active agent, and records which agent it was. History is shared across agents; capabilities are not: a tool call runs only if the current agent has that tool and permission. |
| C7 | Between agent switches, the request prefix (system prompt + tool definitions, in order) is byte-identical across steps, so prompt caching holds; only a switch may change it. |
| C8 | Each step appends one JSONL line to the conversation trace: input, tool calls, tool results (truncated), output, tokens, cost, duration. |
| C9 | Shell commands need approval in the UI, except in auto mode (profile or conversation), where only commands deterministic rules find risky (delete, move, send data out, opaque code) ask. The mode is read at execution. |
| C10 | History is append-only. Past a size or on request, a traced mark clears old tool results or summarizes for the model; recent messages stay whole (C2 holds). |
| C11 | Every failure (tool error, MCP crash, budget stop, denied approval) appears in the UI with a next step, never only in logs. |
| C12 | `delegate` runs a listed subagent on its own model and tools with a fresh context plus its caller's brief (read-only), its shell mode the stricter of its and its caller's, and returns its final answer as one tool result. Subagents cannot delegate; their spend counts toward the parent's budget. The `agents` tool's run is the same, in the target's own workspace. |
| C13 | The loop is provider-neutral: a provider SDK is imported only in `server/src/providers/<name>/`. A conversation may override its agent's model from the next turn; each turn records its model. Replayed history never fails because the prefix changed. |
| C14 | An agent sees its brief and notes' index, with those due (memory tool), and what Jabuti knows about the user (user memory on), as of the conversation's start. Brief and user memory change only with the owner's approval, within a limit. Notes are files Jabuti writes and indexes, with id, date and source; the agent changes the owner's only with approval; every change keeps the old version. The shell cannot reach them; subagents only read the caller's brief. |
| C15 | Only the owner's session reaches the instance: the WebSocket and API (but session, setup, login) need it and refuse other origins. A fresh instance is claimed only with the setup code in the log. TLS only for its sslip.io name and an owner-set domain resolving to it. |
| C16 | A variable reaches only agents in its scope: server-side (connectors) by default, or in their shell when marked (a subagent uses its own scope). A name may hold a value per scope; an agent's own wins over the one for all. Values are encrypted at rest, never sent to the UI, applied without restart. The `agents` tool changes profiles only after the owner approves a diff (a brief only at create); it never grants itself or edits an agent that has it, and its run uses the target's variables only after the owner approves the task. |
| C17 | System packages are installed only by the `packages` tool (needs a usable shell): Debian names only, never a command, approved by the user each time. Deployed, all agents share them and they survive image rebuilds; agents' commands never run as root. |
| C18 | When a conversation idles, the owner starts another or asks, a fixed cheap model reads its new messages once (the user's and agent's words, never tool results) and proposes memory changes. Nothing is saved until the owner approves; nothing is written if an item changed meanwhile or a file would overflow. A failure is shown and retried; cost goes to the trace. |
| C19 | An agent with a plan works on milestones the owner approves: it sets their status, never their goal, and marks one done only on evidence. Each published change is an experiment with an approved baseline; Jabuti refuses one on a locked or control page, past the proposal cap or in a rejection's cooldown, and records a check only once due. Routine runs: approvals refused and listed in the inbox, notes marked auto, the final answer the report, a monthly cap. Only the runner holds the deploy key: Jabuti pushes branches and merges on approval. |
| C20 | `web_read`, `page_structure`, `site_crawl` run fixed scripts in the agent's sandbox, not the server: http(s) only, no variables, capped output. Ask mode asks; no shell, no tool. |
| C21 | `view_images` mosaics web images or workspace files in the agent's sandbox, never the server; the agent's model sees it in the tool result. |

**When a bug is found in production (rule 28):** add the missing obligation first, as a test proven to catch the bug, then fix the code.

## How to work here

- **The One Question (rule 5).** Before starting a feature, write down what we still need to learn. If the answer isn't "nothing", run a spike first.
- **Breathe in, breathe out (rule 12).** Explore freely; before the PR, fold learning back: drop dead paths, merge duplicates, update this file and the Contract. No technical debt is merged.
- **Contract first (rule 20).** Write or update the Contract obligation, then the test, then the code. Pin current behavior with a test before changing it.
- **Tests must earn their place (rule 26).** One Contract test that kills many mutants beats many that catch the same thing.
- **Labels (rule 9).** `fix:` only for defects in live code; else `refine:` or `feat:`.
- **Small PRs (rule 23),** no long-lived branches.
- **The pre-commit hook is the gate.** `pnpm check`: Prettier, ESLint, typecheck, knip, vitest. Never `--no-verify`. `eslint.config.js` encodes the hard constraints; change a rule there, not with a disable comment.

## Execution discipline

- **Reproduce first,** through the real entry point. If you can't name the line, the premise is unverified.
- **Question every proof.** Could this test pass with the feature broken? The fake model proves the Contract; each slice also needs a real-model run in the UI.
- **No blind retries.** Two identical failures or 10 minutes stuck: change course, or ask.
- **Done is done.** Behavior proven, Contract green: stop. No speculative scope.
- **Validate once, at the boundary.** Untrusted input (model output, tool results, MCP, user input) is validated where it enters; internal data is trusted.

## Safety

- **Traces are local.** They hold message and tool content by design, never leave the machine, and are redacted at export.
- No credentials, private data or real user content in commits, tests or fixtures. Use synthetic fixtures.
- Ask before: new dependencies, new config options, schema changes, destructive operations, anything that costs money.

## Decisions

Decisions a reader would otherwise rediscover go in [`docs/DECISIONS.md`](docs/DECISIONS.md), dated, with the reason. Read it before reopening one. UI: `packages/ui/AGENTS.md`. Slices (rule 2): [`docs/SLICES.md`](docs/SLICES.md).
