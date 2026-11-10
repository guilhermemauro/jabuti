---
name: Forest Console
colors:
  surface: "#f5fbf6"
  surface-dim: "#d5dbd6"
  surface-bright: "#f5fbf6"
  surface-container-lowest: "#ffffff"
  surface-container-low: "#eff5f0"
  surface-container: "#e9efea"
  surface-container-high: "#e4eae5"
  surface-container-highest: "#dee4df"
  on-surface: "#171d1a"
  on-surface-variant: "#404943"
  inverse-surface: "#2c322f"
  inverse-on-surface: "#ecf2ed"
  outline: "#707972"
  outline-variant: "#c0c9c1"
  surface-tint: "#2d694d"
  primary: "#125238"
  on-primary: "#ffffff"
  primary-container: "#2f6b4f"
  on-primary-container: "#aae9c6"
  inverse-primary: "#96d4b2"
  secondary: "#436653"
  on-secondary: "#ffffff"
  secondary-container: "#c2e9d1"
  on-secondary-container: "#476a57"
  tertiary: "#3a4c44"
  on-tertiary: "#ffffff"
  tertiary-container: "#52645b"
  on-tertiary-container: "#cce0d5"
  error: "#ba1a1a"
  on-error: "#ffffff"
  error-container: "#ffdad6"
  on-error-container: "#93000a"
  primary-fixed: "#b1f0cd"
  primary-fixed-dim: "#96d4b2"
  on-primary-fixed: "#002113"
  on-primary-fixed-variant: "#105137"
  secondary-fixed: "#c5ebd4"
  secondary-fixed-dim: "#aacfb8"
  on-secondary-fixed: "#002113"
  on-secondary-fixed-variant: "#2c4e3c"
  tertiary-fixed: "#d3e7dc"
  tertiary-fixed-dim: "#b7cbc1"
  on-tertiary-fixed: "#0e1f18"
  on-tertiary-fixed-variant: "#394b43"
  background: "#f5fbf6"
  on-background: "#171d1a"
  surface-variant: "#dee4df"
typography:
  headline-xl:
    fontFamily: Hanken Grotesk
    fontSize: 28px
    fontWeight: "600"
    lineHeight: 36px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Hanken Grotesk
    fontSize: 22px
    fontWeight: "600"
    lineHeight: 28px
    letterSpacing: -0.015em
  headline-md:
    fontFamily: Hanken Grotesk
    fontSize: 18px
    fontWeight: "600"
    lineHeight: 24px
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Hanken Grotesk
    fontSize: 15px
    fontWeight: "400"
    lineHeight: 22px
  body-md:
    fontFamily: Hanken Grotesk
    fontSize: 13px
    fontWeight: "400"
    lineHeight: 19px
  body-sm:
    fontFamily: Hanken Grotesk
    fontSize: 12px
    fontWeight: "400"
    lineHeight: 16px
  label-md:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: "500"
    lineHeight: 16px
    letterSpacing: -0.01em
  label-sm:
    fontFamily: JetBrains Mono
    fontSize: 11px
    fontWeight: "500"
    lineHeight: 14px
  code-block:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: "400"
    lineHeight: 18px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  gutter: 1rem
  margin: 1.25rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1.25rem
  space-xl: 1.75rem
---

## Brand & Style

This design system drives a technical, AI-native autonomous SEO operations platform. The interface balances high developer density with calm, enduring focus. It takes cues from precision developer workbenches, terminal harnesses, and modern workspace tooling.

The aesthetic blends **Modern Technical SaaS** with **Tactile Botanical Minimalism**:

- **Confidence & Longevity:** Deep forest tortoise hues anchor the interface with stability, patience, and deliberate execution, countering the frantic noise of fast-churn AI chat wrappers.
- **Operator Focus:** High information density, clear nested structures, and immediate visibility into tool delegations, token cost thresholds, and runtime execution state.
- **Craft & Tactility:** Subtle low-contrast panel separation, monospaced code blocks, and crisp pill markers that give engineers and SEO strategists total transparency into agent thought loops.

## Colors

The palette is rooted in evergreen organic depths, paired with cool slate-tinted neutrals for clarity and low eye strain during prolonged technical workflows.

The tokens in the front matter are the source of truth; the UI uses no other colors (`packages/ui/src/styles.css`). The one addition is a warning terracotta for what waits for the owner and for budgets, which has no token.

### Palette Architecture

- **Primary (`primary` `#125238`, hover `primary-container` `#2f6b4f`):** Deep tortoise green. Used for critical action buttons, active navigation states, primary toggles, and emphasized agent identifiers.
- **Secondary (`secondary` `#436653`, `secondary-container` `#c2e9d1`):** Balanced sage green. Applied to subtle actions, secondary controls, conversational pill indicators, and completed run markers.
- **Mint highlight (`tertiary-fixed` `#d3e7dc`):** Reserved for active conversational selections and active navigation items.
- **Text (`on-surface` `#171d1a`, `on-surface-variant` `#404943`, `outline` `#707972`):** Dark forest-slate for primary typography; variant for secondary text; outline for metadata.
- **Canvas (`surface` `#f5fbf6`, `surface-container-*`):** Muted off-white surfaces with green-tinted neutrals to prevent stark hospital glare.
- **Status & Warning Accents:** `error` `#ba1a1a` on `error-container` `#ffdad6` for failures; terracotta `#d97706` (no token) for approvals waiting for the owner and budget thresholds.

## Typography

The type system brings together **Hanken Grotesk** for clean, legible interface copy and **JetBrains Mono** for developer ergonomics, command lines, configuration tags, model routes, and tool execution badges.

- **Headlines:** Use `Hanken Grotesk` with tight negative tracking (`-0.015em` to `-0.02em`) to establish authoritative, orderly panel headings and modal titles.
- **Body:** Set at an efficient `13px` base (`body-md`) to ensure high tabular readability across agent logs, file paths, and conversation threads without visual crowding.
- **Monospace & Metadata:** All model slugs (e.g. `anthropic/claude-opus-5-5`), terminal commands, token costs, and system prompt text areas leverage `JetBrains Mono` for rapid scanning and strict character alignment.

## Layout & Spacing

The layout is built on a structured **fixed-sidebar, fluid-workbench multi-pane shell**:

1. **Sidebar Navigation (Fixed 260px):** Houses agent instances, active thread history, action triggers (`+ New Conversation`), and application configurations.
2. **Inspector / Agent List Pane (Fixed 240px - Conditional):** In settings view, hosts secondary agent selection and quick-action submenus.
3. **Primary Canvas (Fluid Grid):** Flexibly displays active multi-turn agent chats, configuration fieldsets, and system prompts. Chat width caps at `840px` centered to guarantee comfortable reading line lengths.

### Rhythms & Breakpoints

- **Desktop (>= 1200px):** Triple-column layout fully expanded with continuous inspection and log panels.
- **Tablet (768px - 1199px):** Collapsible sidebar toggle; main workspace adapts with full-width responsive input panels.
- **Mobile (< 768px):** Drawer overlays for conversation and agent rosters; bottom sheet action controls.

## Elevation & Depth

Visual hierarchy uses a refined **flat-tactile layer model** with low-contrast outlines and micro-surfacing rather than heavy floating shadows.

- **Base Surface (`surface`):** Application canvas underpinning the shell.
- **Level 1 Panels (`surface-container-lowest`):** Work surfaces, conversation message containers, and configuration cards, defined by crisp border strokes (`1px solid surface-container-highest`).
- **Level 2 Embedded Well (`surface-container-low`; user messages `surface-container`):** Used inside form groups, agent listing side-columns, tool selection fieldsets, and user message bubbles.
- **Level 3 Code Well (`surface-container-low`):** System prompt sandboxes and shell terminals, separated by a `1px` subtle boundary.
- **Overlays & Popovers:** Modals, tool inspection dropdowns, and model selection menus employ a disciplined micro-shadow: `0 4px 12px -2px rgba(23, 29, 26, 0.08), 0 1px 3px rgba(23, 29, 26, 0.04)` (`on-surface`).

## Shapes

The design system adopts **Soft (Level 1)** geometry, establishing a disciplined, engineering-focused look:

- **Base Elements (`0.25rem` / `4px`):** Checkboxes, tags, input fields, and inline code tags.
- **Containers & Cards (`0.5rem` / `8px`):** Settings tab wrappers, chat message bubble envelopes, tool grouping panels, and agent item cards.
- **Interactive Badges & Nav Pills (`0.375rem` / `6px` to full pill for status):** Mode toggles, delegation status chips, and tab buttons.

## Components

### Buttons

- **Primary Action:** Solid `primary` with `on-primary` text. Hover: `primary-container`. Active: `on-primary-fixed-variant`. Padding `6px 12px`, `rounded` (4px), `13px` weight `500`.
- **Secondary / Ghost:** `surface-container-low` background with `primary` text and `1px solid outline-variant` border. Hover: `surface-container`.
- **Destructive:** `surface-container-lowest` background with `error` text and `error-container` border; hover fills with `error-container`.

### Input Fields & Textareas

- **Text Inputs:** `surface-container-lowest`, `1px solid outline-variant` border, `6px 10px` internal padding, `JetBrains Mono` or `Hanken Grotesk` based on content type. Focus ring is `2px solid` `primary` at 25% with a `primary` border.
- **Code & Prompt Areas:** System prompt boxes utilize monospaced font (`code-block`), `surface-container-low` background and fixed line-height (`18px`).

### Tool Call & Delegation Badges

- **Status Pills:** Compact layout containing an expand arrow, agent name, and micro status counter.
- **Failed State:** `error-container` background, `error` border, `on-error-container` text.
- **Running:** `secondary-container` background, `primary-fixed` border, `primary` text. Finished: `surface-container-low`, `outline-variant` border, `on-surface-variant` text.

### Conversation Cards & Messages

- **Agent Responses:** White card surface or raw inline left-aligned text with standard markdown typography, structured tables, and bold section headings.
- **User Messages:** Contained rounded well (`surface-container`) right-aligned, providing clear visual dialogue demarcation.

### Settings Tabs

- Soft-square segmented control on `surface-container-low`: active `surface-container-lowest` with `1px solid outline-variant` and `primary` text; inactive `on-surface-variant`, `surface-container` on hover.
