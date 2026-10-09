# Relay 3.0 design system — "broadsheet with a signal"

Relay is text-first, so the interface is built like a well-set newspaper column rather than a dashboard.

## Principles

1. **Reading comes first.** Post bodies are set in a serif (Newsreader) at a comfortable measure (≤ 640px column) and
   size the reader controls (Settings → Appearance: text size, serif/sans, theme).
2. **Chrome stays quiet.** Interface text is Inter Tight; metadata (handles, times, counts, action labels) is IBM Plex
   Mono at 12–12.5px in `--ink-3`. Actions are *labelled* (`reply 3 · repost · like 12 · save`), not icon soup.
3. **One signal colour.** Vermilion `--signal` marks the active state, focus, mentions and links, unread badges and the
   single primary action on a screen. Everything else is paper and ink neutrals.
4. **Rules, not cards.** Lists are separated by 1px hairlines (`--rule`). No big rounded cards, no gradients, no
   glassmorphism, no drop shadows except popovers/dialogs (`--shadow-pop`).
5. **Honest numbers only.** No vanity stats or fake activity. Counts can be hidden entirely (Settings → hide counts).
6. **Motion is functional.** 120–200ms eases for hover/press, a 4px rise for new content and dialogs, and nothing
   loops except spinners. `prefers-reduced-motion` disables it all.

## Tokens (`src/styles/tokens.css`)

| Token | Use |
|---|---|
| `--paper`, `--paper-raised`, `--paper-sunk` | page background, inputs/dialogs, hover wells |
| `--ink`, `--ink-2`, `--ink-3` | primary text, secondary text, metadata |
| `--rule`, `--rule-strong` | hairlines, control borders |
| `--signal`, `--signal-ink`, `--signal-wash`, `--on-signal` | accent, accent text, accent background tint, text on accent |
| `--moss*`, `--amber*`, `--danger*` | success, warning, destructive |
| `--font-read`, `--font-ui`, `--font-mono` | body text, UI, metadata |
| `--read-size`, `--read-leading` | user-adjustable reading size |
| `--s-1 … --s-10` | 4px spacing scale |
| `--col`, `--rail-left`, `--rail-right` | layout widths |

Dark theme is a warm ink (`#14130f`) with paper-coloured text, driven by `prefers-color-scheme` and overridable with
`html[data-theme]`.

## Primitives (`src/styles/base.css`, `src/styles/components.css`)

- Buttons: `.btn` + `.btn-primary` (ink), `.btn-signal` (the one key action), `.btn-danger`, `.btn-ghost`, `.btn-sm`,
  `.btn-block`. Pill-shaped, 36px min height. Put `<span class="spinner" />` inside while busy and set `disabled`.
- Text actions: `.act` (mono, used in post action rows; `aria-pressed` turns it signal-coloured). `.icon-btn` for
  icon-only buttons — always with `aria-label`.
- Forms: `.field` > `label` + `.input|.textarea|.select` + `.hint` / `.field-error`; set `aria-invalid` and
  `aria-describedby`. `.switch` for toggles (label wrapping text + `<input type="checkbox">`). `.segmented` for 2–4
  option pickers (`aria-pressed`).
- `.tabs` with `aria-current="page"` (links) or `aria-selected` (buttons).
- `.tag`, `.tag-signal|moss|amber`, `.badge` (unread count), `.notice`, `.notice-signal|danger|amber`.
- Type helpers: `.page-title` (serif heading), `.kicker` (mono small caps label), `.meta`, `.read`.
- Components: `Avatar`, `PostItem`, `RichText`, `Time`, `Dialog`, `ConfirmDialog`, `Menu`, `InfiniteList`,
  `EmptyState`, `ErrorState`, `Loading`, `PostSkeleton`, `Icon`.

## Layout

- ≥ 1100px: left rail (wordmark, nav, compose) · centre column (640px) · right rail ("the Dial": feed controls,
  community rules link, preview notice).
- 861–1099px: left rail collapses to icons; right rail hidden (Dial reachable from the Home header).
- ≤ 860px: sticky top bar (title/back + avatar) and a bottom tab bar (Home, Explore, Compose, Notifications,
  Messages), safe-area aware. Content uses a 16px side gutter. No horizontal scroll at 320px.

## Voice

Plain, warm and direct. Empty states say what the space is for and what to do next ("Nothing here yet. Follow a few
people from Explore and their posts will show up here, newest first."). Errors say what happened and how to recover.
