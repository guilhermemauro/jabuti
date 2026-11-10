# Security policy

Jabuti runs code written by a model, holds API keys and talks to third-party
services, so we take security reports seriously.

## Reporting a vulnerability

**Do not open a public issue.** Report it privately through GitHub:
[Report a vulnerability](https://github.com/guilhermemauro/jabuti/security/advisories/new).

Please include:

- what an attacker can do, and under which conditions;
- the steps to reproduce, or a proof of concept;
- the version or commit you tested.

You will get an acknowledgement within a few days. Once a fix is ready, we will agree
with you on when to publish the advisory, and credit you unless you prefer otherwise.

## Supported versions

Jabuti is early and has no releases yet: only the latest commit on `main` is
supported.

## What counts

The guarantees in the Contract ([`AGENTS.md`](AGENTS.md)) are the security boundary.
Examples of what we want to hear about:

- reaching the server, its API or its WebSocket without the owner's session;
- a secret (a variable, a model key, an OAuth token) reaching the model, the browser,
  a trace or an agent's shell when it was not marked for that shell;
- an agent's command escaping its workspace or the runner container, or running as
  root;
- a tool call that should wait for the owner's approval running without it;
- one agent reading another agent's workspace, notes or credentials.

Things that are expected behavior, not vulnerabilities: an agent in auto mode running
any command or installing packages in its sandbox without asking, and a variable you marked
for an agent's shell being readable by that agent's model.
