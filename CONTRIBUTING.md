# Contributing to Jabuti

Thanks for wanting to help. Jabuti is small on purpose, and the rules below keep it
that way. They are short; please read them before your first pull request.

## Before you start

- **Read [`AGENTS.md`](AGENTS.md).** It holds the project's story, its hard
  constraints, its design priorities and the Contract. It is written for coding
  agents, and it applies to humans in exactly the same way.
- **Read [`docs/DECISIONS.md`](docs/DECISIONS.md) before reopening a decision.** Most
  "why not X?" questions are answered there, with the alternatives that were rejected.
- **Open an issue first** for anything larger than a fix: a new tool, connector,
  provider or screen. Agreeing on the shape first saves you a rewrite.

## What fits, and what does not

Welcome:

- Bug fixes, with a test that fails without the fix.
- New MCP connectors, as their own `packages/mcp-*` package.
- New skills, in `skills/<name>/SKILL.md`.
- Model provider adapters, in `packages/server/src/providers/<name>/`.
- Documentation, clearer error messages, accessibility.

Out of scope, by design:

- **Agent frameworks** (LangChain, LangGraph, CrewAI, Mastra, agent SDKs and the
  like). Writing the loop by hand is the point of the project.
- **New dependencies without a reason.** Anything beyond the allowed libraries in
  `AGENTS.md` needs a line in `docs/DECISIONS.md` saying why.
- **A new core tool when a skill or a connector would do.** Every built-in tool costs
  context on every request: capability goes first to a skill, then to an MCP server,
  and only last to the core.

## Setting up

```sh
corepack enable          # pnpm 11, as pinned in package.json
pnpm install             # installs dependencies and the git hooks
cp .env.example .env     # an Anthropic key, only to run the app
pnpm dev                 # server on :4317, UI on :5173
```

You need Node 26+ and Docker (agents' shells run in containers). The tests need no
API key and no Docker: they run against a scripted fake model and a fake sandbox.

## Making a change

1. **Contract first.** If your change adds or changes a guarantee, update the
   obligation in `AGENTS.md`, then its test in `contract/`, then the code. If you are
   changing existing behavior, pin it with a test before touching it.
2. **Reproduce first.** For a bug, reproduce it through the real entry point and name
   the line before editing.
3. **Keep it small.** One idea per pull request. Small pull requests get reviewed
   today; large ones wait.
4. **Fold learning back.** Before you open the pull request, remove dead paths, merge
   duplicates, and update `AGENTS.md`, the Contract and `docs/DECISIONS.md` where
   your change makes them out of date.
5. **Run the gate.** `pnpm check` runs Prettier, ESLint (strict type-checked),
   TypeScript, knip and the tests. The pre-commit hook runs it too. Never commit with
   `--no-verify`, and change a lint rule in `eslint.config.js` rather than adding a
   disable comment.

### Tests that earn their place

A test should fail if the feature breaks. Before you submit, ask: could this test pass
with the feature broken? One Contract test that catches many mistakes beats many
tests that catch the same one. Fixtures are always synthetic: no real credentials,
customer data or personal information, ever.

### Commit messages

The subject starts with a label, checked by the `commit-msg` hook:

- `fix:` only for a defect in code that has shipped;
- `feat:` for new behavior;
- `refine:` for everything else (refactors, docs, tests, tooling).

An optional scope is fine: `feat(mcp): register remote servers`.

## Pull requests

- Describe what changed and why, and link the issue.
- Name any accepted edge case, in a code comment or in the description.
- Say how you verified it. Tests on the fake model prove the Contract; a change to a
  user-facing flow also needs one run with a real model through the interface, so say
  if you could not do that.
- Expect review comments about scope: "can this be a skill?", "is this in the
  Contract?". They are not personal; they keep the core small.

## Reporting bugs and asking for features

Use the issue templates. For a bug, include what you did, what you expected, what
happened, and the relevant lines from the server log or the conversation's trace
(`data/traces/`). **Traces contain your conversations: redact them before you paste.**

Security issues are different: never open a public issue for them. See
[SECURITY.md](SECURITY.md).

## Code of conduct

Be kind and assume good faith. This project follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
