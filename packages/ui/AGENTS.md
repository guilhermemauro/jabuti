# AGENTS.md — packages/ui

- The look follows [`docs/DESIGN.md`](../../docs/DESIGN.md) (Forest Console). Its front matter tokens are the source of truth: colors come only from the custom properties at the top of `src/styles.css`, never a hex elsewhere.
- Hanken Grotesk for interface text, JetBrains Mono for model ids, commands, costs, ids and code. Fonts are bundled (`@fontsource`); the UI never loads anything from a third party.
- Icons are SVG components in `src/Icons.tsx` (24×24, 1.75 stroke, currentColor). Each agent gets an animal from the pack there, distinct while animals last; add animals to the pack rather than reusing one.
- Show only what Jabuti really does: no control without a feature behind it, no invented status, version or metric.
