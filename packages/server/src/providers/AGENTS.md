# providers/ — model adapters

The loop talks only to `ModelProvider` (`types.ts`). Each provider is one directory here, and only that directory imports the provider's SDK (C13, enforced by ESLint and `contract/C13.test.ts`).

## Adding a provider (OpenAI, Z.ai, DeepInfra…)

1. Add its official SDK, with a line in the root Decisions section.
2. Write `providers/<name>/index.ts` exporting `create<Name>Provider(apiKey)`. Translate neutral messages to the API and back; map every SDK error to a `ModelError` with a next step.
3. List its models and prices in `catalog.ts`, ids `<name>/<model>`.
4. Register the factory in `index.ts` and read `<NAME>_API_KEY` in `src/config`.
5. Add the provider SDK to `providerSdks` in `eslint.config.js` and to `PROVIDER_SDKS` in `contract/C13.test.ts`.
6. One real end-to-end run through the UI.

## Rules

- **Replay verbatim.** An assistant message stores neutral `parts` plus the provider's own `raw` record. When the same provider reads it back, send `raw` unchanged: thinking blocks and signatures are rejected if edited. Another provider rebuilds from `parts`.
- **A changed prefix must not fail the request.** The system prompt and tools change legitimately mid-conversation (profile edit, model or agent switch). Reasoning bound to the old prefix is dropped, never sent back as an error (C13).
- **Prices drive the budget.** Wrong prices in `catalog.ts` mean wrong cost stops (C1). Check the provider's pricing page.
- **Anthropic:** beta Messages API, streaming with top-level `cache_control` (caches system, tools and history). Adaptive thinking with `block_binding.prefix_mismatch_behavior: "drop_block"` (beta `thinking-binding-controls-2026-08-01`): a thinking block made under an earlier system prompt or tools is dropped instead of a 400. Cost: that turn loses its earlier reasoning. Deferred: server-side refusal `fallbacks`, and `eager_input_streaming` until the UI shows tool input as it streams.
