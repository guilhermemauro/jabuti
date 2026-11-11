<h1 align="center">🐢 Jabuti</h1>

<p align="center">
  <b>A self-hosted agent harness you can read end to end.</b><br>
  Several agents, each with its own model, prompt, tools, skills, MCP connectors and
  permissions, running real work in a sandboxed shell, behind a web interface you own.
</p>

<p align="center">
  <a href="https://github.com/guilhermemauro/jabuti/actions/workflows/check.yml"><img alt="Check" src="https://github.com/guilhermemauro/jabuti/actions/workflows/check.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Node 26+" src="https://img.shields.io/badge/node-26%2B-339933">
  <img alt="TypeScript strict" src="https://img.shields.io/badge/typescript-strict-3178c6">
  <img alt="Status: early" src="https://img.shields.io/badge/status-early-orange">
</p>

> **Jabuti** (/ʒa.buˈtʃi/) is the Brazilian tortoise: slow to start, hard to break, and
> it always gets there. The harness is built the same way.

## Why Jabuti

Most agent stacks are a framework wrapped around a loop you never see. Jabuti is the
loop, written by hand, small enough to read in an afternoon, and strict about what an
agent may do.

- **No agent framework.** No LangChain, LangGraph, CrewAI, Mastra or agent SDKs. The
  loop, the tool registry, context management, permissions, the skills loader and
  agent switching are plain TypeScript in this repository. The only libraries are the
  model API client, the MCP SDK, `zod`, React, a WebSocket server and Vitest.

- **One agent per site or project.** Each agent is a profile on disk: its model,
  system prompt, budget, tools, shell mode, subagents, MCP connectors and skills. It
  keeps its own brief, notes and workspace, so the agent for your blog never sees the
  files or credentials of the agent for your store. Switch agents mid-conversation;
  the history is shared, the capabilities are not.

- **Agents do real work in a shell.** Commands run in a Linux container with Python,
  one workspace per agent, with no secret from the server. Per agent and per
  conversation, they run on their own (auto) or wait for your approval on each (ask).

- **Secrets stay in the server.** API keys and tokens are encrypted at rest and reach
  only the MCP connectors of the agents in their scope. The model never sees them,
  and the shell never inherits them, unless you mark a variable for an agent's shell.

- **Connect anything that speaks MCP.** Use the built-in connectors (Google Search
  Console, Google Analytics 4, PageSpeed, Serper, DataForSEO, Wikipedia, image generation) or register any
  remote MCP server from the interface, with a token header or an OAuth login. You
  pick which of its tools agents get and which ask you before each call.

- **Skills, loaded only when needed.** A skill is a method in a Markdown file. An
  agent's prompt lists only each skill's name and description; the full method enters
  the context when the agent starts a task that needs it. Write skills in the
  interface, or let the managing agent write them for your approval.

- **Memory you can read and edit.** Each agent has a brief and dated notes in plain
  Markdown files. After a conversation, a small model proposes what to remember, and
  nothing is saved until you approve it.

- **Autonomy with a leash.** An agent with a plan works on milestones you approve,
  proposes each change as an experiment with a measured baseline, and can run on a
  schedule. Unattended runs never get an approval: what they needed waits in your
  inbox. Changes ship as pull requests you merge.

- **Long conversations that stay cheap.** History is append-only. When the context
  grows, old tool results are cleared from the model's view (saved to the workspace,
  so the agent can read them again) and, past a larger size, the conversation is
  summarized. Request prefixes stay byte-identical between steps, so prompt caching
  holds.

- **Every step is traced.** One JSONL line per model step: input, tool calls,
  results, tokens, cost and duration. Traces never leave your machine.

- **Its promises are tests.** Every guarantee above is an obligation in
  [the Contract](AGENTS.md#the-contract-imp-rules-13-20-29) (C1–C21), each a test run
  against a scripted fake model: deterministic, free, and run on every commit.

## How it works

```
 browser ──HTTP + WebSocket──▶ server (Node) ───────────────▶ model provider
   UI      owner session only   ├─ agent registry   profiles on disk
                                ├─ loop             one per running conversation
                                ├─ tools            built-in, MCP, skills
                                ├─ mcp clients      hold connector credentials
                                ├─ agent state      brief, notes, plan
                                ├─ autopilot        routines, inbox, publishing
                                └─ tracer           JSONL per conversation
                                        │
                                        ▼
                               shell runner (container)
                               one workspace per agent, no secrets
```

A turn starts when you send a message. The loop builds the request from the active
agent's profile, calls the model, runs the tool calls it returns (asking you when a
rule says so), appends every message to the history and repeats until the model
answers without a tool call or the budget for that turn runs out. Every tool call gets
exactly one result, including on error, timeout or denial.

## Quick start

### On a server, with HTTPS

Each option below runs [`deploy/compose.yml`](deploy/compose.yml): Jabuti, its shell
runner and [Caddy](https://caddyserver.com/), which gets HTTPS certificates on its own.
You need only a server with ports 80 and 443 open.

| Where            | How                                                                                                                                                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hostinger**    | [![Deploy on Hostinger](https://assets.hostinger.com/vps/deploy.svg)](https://www.hostinger.com/docker-hosting?compose_url=https://raw.githubusercontent.com/guilhermemauro/jabuti/main/deploy/compose.yml&REFERRALCODE=AXUGUILHEMAI)<br>The setup code is in Docker Manager → jabuti → logs. |
| **AWS**          | CloudFormation → Create stack → upload [`deploy/aws.yml`](deploy/aws.yml). The address is in the stack's Outputs; the setup code in the instance's system log.                                                                                                                                |
| **DigitalOcean** | Create a Droplet (Ubuntu 24.04, 4 GB) and, under Advanced options → Add initialization scripts, paste the line below. Then open the Droplet's console and run `cd /opt/jabuti && docker compose logs jabuti` for the setup code.                                                              |
| **Any VPS**      | As root on Ubuntu or Debian, run the line below. It prints the address and the setup code.                                                                                                                                                                                                    |

```sh
curl -fsSL https://raw.githubusercontent.com/guilhermemauro/jabuti/main/deploy/install.sh | sh
```

Then:

1. Open `https://<the server's IP, dots as dashes>.sslip.io`, such as
   `https://203-0-113-10.sslip.io`. [sslip.io](https://sslip.io) is a free DNS
   service that turns that name into the IP, so HTTPS works before you have a domain.
2. Enter the setup code and choose the owner password **right away**: until then,
   whoever has the code claims the instance.
3. **Settings → Model keys**: add your Anthropic key.
4. **Settings → Domain**: point a domain of your own at the server (an `A` record)
   and save it there. Jabuti checks the record before saving, and Caddy gets its
   certificate on the first visit.

**Settings → Version** shows the running version and, when a newer release exists,
what changed and the command to update: `docker compose pull && docker compose up -d`
in the folder with the compose file (`/opt/jabuti` for the script), or update the
project in Hostinger's Docker Manager. To check, the server asks GitHub for the
latest release twice a day, an anonymous request that sends nothing about the instance.

Heroku and other platforms whose disk is wiped on restart do not fit: Jabuti keeps
its database, notes and agents' workspaces on disk.

### On your machine

You need [Docker](https://docs.docker.com/get-docker/) with Compose and an
[Anthropic API key](https://console.anthropic.com/).

```sh
git clone https://github.com/guilhermemauro/jabuti.git
cd jabuti
cp .env.example .env          # set ANTHROPIC_API_KEY (or set it later in Settings)
docker compose up -d --build
docker compose logs jabuti    # prints the one-time setup code
```

Open <http://localhost:4317>, enter the setup code and choose the owner password.
The instance is claimed by whoever enters that code first, so do it right away.

This setup binds to `127.0.0.1` only. To reach it from elsewhere, use the server
setup above, or put a reverse proxy with TLS in front of it: the password and the
session cookie must not travel over plain HTTP.

### First steps

1. **Settings → Agents.** The `assistant` agent comes ready. Ask it to create an
   agent for your site or project: it reads the site, proposes a brief and writes the
   profile, and you approve each change.
2. **Settings → Variables.** Add the keys your connectors need (each connector says
   where to get its key), scoped to the agents that may use them.
3. **Settings → Skills and Connectors.** Turn on the methods and MCP servers each
   agent should have.
4. Start a conversation, pick the agent, and give it work.

## Development

Requirements: Node 26+, pnpm 11 (`corepack enable`), and Docker for the agents'
shell.

```sh
pnpm install            # also installs the git hooks
cp .env.example .env    # ANTHROPIC_API_KEY, optional
pnpm dev                # server on :4317, UI with hot reload on :5173
```

Open <http://localhost:5173>; the setup code is in the server's log. Locally, each
agent's shell is a `python:3.13-slim` container started on demand. The web reader
tools (`web_read`, `page_structure`, `site_crawl`) need the runner image; to develop
with it, run everything in Docker instead:

```sh
docker compose -f compose.dev.yml up --watch
```

`pnpm check` runs the same gate as the pre-commit hook and CI: Prettier, ESLint
(strict type-checked), TypeScript, knip and the Vitest suite.

## Configuration

Almost everything is configured in the interface and stored in the data directory.
The environment holds only what the server needs to start.

| Variable                                       | Default                                  | What it does                                                                           |
| ---------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                            | none                                     | Model key. Can be set in Settings → Model keys instead.                                |
| `JABUTI_DATA_DIR`                              | `./data` (`/data` in the container)      | Database, agent profiles, notes, workspaces, traces.                                   |
| `JABUTI_HOST`                                  | `127.0.0.1` (`0.0.0.0` in the container) | Address the server listens on.                                                         |
| `JABUTI_PORT`                                  | `4317`                                   | Port.                                                                                  |
| `JABUTI_SECRET_KEY` / `JABUTI_SECRET_KEY_FILE` | generated in the data directory          | Encrypts stored secrets. Set it so the key does not live next to the data it protects. |

### Secret key

Model keys, connector tokens and variables are stored encrypted. Without
`JABUTI_SECRET_KEY`, Jabuti generates the key in the data directory (`secret.key`) and
Settings warns about it: a backup or copy of that directory carries the key that opens
it. To keep the key apart, move it into the environment, **without generating a new
one**: a new key cannot decrypt what is already stored, and every secret would have to
be entered again.

On a server installed with `deploy/compose.yml` (`/opt/jabuti` for the script):

```sh
cd /opt/jabuti
printf 'JABUTI_SECRET_KEY=%s\n' "$(docker compose exec -T jabuti cat /data/secret.key)" >> .env
chmod 600 .env
docker compose up -d
```

Open Settings: the warning is gone. Only then delete the file:

```sh
docker compose exec jabuti rm /data/secret.key
```

On Hostinger, add `JABUTI_SECRET_KEY` to the project's environment variables in
Docker Manager, with the content of `/data/secret.key` (from the container's terminal).
On your machine, put it in `.env` from `data/secret.key`. Keep a copy of the key
somewhere safe outside the server: without it, a restored backup has no secrets.
`JABUTI_SECRET_KEY_FILE` reads it from a file instead, such as a Docker secret.

Agent templates live in [`agents/`](agents) and built-in skills in [`skills/`](skills).
Your own agents and skills live in the data directory, editable in Settings or by
hand.

## What's inside

|                    |                                                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Built-in tools** | `shell`, `packages` (system packages, approved each time), `web_read`, `page_structure`, `site_crawl`, `view_images`, `delegate` (subagents), `memory` (brief and notes), `plan` (milestones, experiments, routines), `agents` (manage agents and skills), `skill` |
| **Connectors**     | `gsc`, `ga4`, `pagespeed`, `serper`, `dataforseo`, `wikipedia`, `nanobanana`, `gptimage`, plus any remote MCP server you register                                                                                                                                  |
| **Skills**         | `data-study` (turn company or public data into a study others cite), plus your own                                                                                                                                                                                 |
| **Models**         | Claude Opus, Sonnet, Haiku and Fable, through a provider-neutral loop: a provider SDK is imported only in its adapter folder                                                                                                                                       |

## Security

Jabuti runs code that a model writes, so its security model is part of the design,
not an add-on.

- **One owner.** Every API route and the WebSocket require the owner's session and
  refuse other origins. A fresh instance is claimed only with the setup code from the
  log.
- **Secrets in one process.** Variables and keys are encrypted at rest (AES-256-GCM)
  and handed only to the connectors of agents in their scope. They are never sent to
  the browser, the model or the shell, except variables you explicitly mark for an
  agent's shell.
- **Isolated shells.** Agents' commands run in a separate runner container, one Unix
  user and workspace per agent, never as root, with no environment from the server.
  Web pages are read by fixed scripts inside that sandbox, never by the server.
- **Approvals.** Risky shell commands, package installs, profile and skill changes,
  brief changes and MCP tools you mark as "ask first" all wait for you, with a diff
  or the exact arguments.
- **Local traces.** Traces hold message and tool content by design and never leave
  the machine.

Found a vulnerability? Please report it privately, as described in
[SECURITY.md](SECURITY.md).

## Project status

Jabuti is early and built in public. It runs real SEO work for its author, but
expect rough edges, breaking changes in the data format (handled by numbered
migrations) and only one model provider for now. The direction is set in
[`docs/SLICES.md`](docs/SLICES.md), and every non-obvious choice, with its reason, is
in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## Docs

| File                                             | What it is                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [`AGENTS.md`](AGENTS.md)                         | **Start here to contribute.** The story, hard constraints, design priorities and the Contract. Written for coding agents and humans alike. |
| [`docs/DECISIONS.md`](docs/DECISIONS.md)         | Every design decision, dated, with the reason and the alternatives rejected. Read it before reopening one.                                 |
| [`docs/SLICES.md`](docs/SLICES.md)               | The roadmap, one demoable slice at a time.                                                                                                 |
| [`docs/DESIGN.md`](docs/DESIGN.md)               | The interface's design system.                                                                                                             |
| [`packages/ui/AGENTS.md`](packages/ui/AGENTS.md) | Rules for the web interface.                                                                                                               |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)             | How to set up, propose and land a change.                                                                                                  |
| [`SECURITY.md`](SECURITY.md)                     | How to report a vulnerability.                                                                                                             |

### Repository layout

```text
packages/
├── server/        the harness: HTTP, WebSocket, loop, tools, MCP clients, state
├── ui/            the web interface (React + Vite)
├── protocol/      the messages between them, as zod schemas
├── runner/        the shell runner and the sandboxed page reader
└── mcp-*/         the built-in MCP connectors
contract/          the Contract: one test file per obligation, on a fake model
deploy/            compose with Caddy, install script, AWS template
agents/            agent templates
skills/            built-in skills
docs/              decisions, roadmap, design system
```

## Contributing

Contributions are welcome, from a typo to a new connector. Jabuti follows
[Impatient Programming](https://impatientprogramming.org/rules/): small pull requests,
the Contract first, and no technical debt merged. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and open an issue
first for anything larger than a fix so we can agree on the shape.

## License

MIT. See [LICENSE](LICENSE).

## Acknowledgements

Jabuti is built collaboratively with [Claude Code](https://claude.com/claude-code),
following the rules in [`AGENTS.md`](AGENTS.md). The structure of this README owes a
lot to [ai-memory](https://github.com/akitaonrails/ai-memory) by Fabio Akita.
