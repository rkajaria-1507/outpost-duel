# Outpost Duel — UI/UX Redesign

**Date:** 2026-07-12
**Scope:** Visual theme, layout, and interaction clarity only. Game rules/mechanics are out of scope — that's a separate follow-up spec ("complexity expansion") once this ships.

## Problem

Playtesting surfaced three issues:

1. **Layout overflow.** `.game-layout` (`css/style.css:335`) is `grid-template-columns:300px 1fr 300px` with no responsive step between 900px and 1160px. Between those widths the two fixed 300px rails plus the center board (`#board{grid-template-columns:repeat(4,1fr)}`, `css/style.css:94`, itself padded by a 20px/10px wood frame) exceed the viewport, forcing horizontal scroll even on a normal desktop window. `.player-card{min-width:220px}` inside a 300px column compounds this.
2. **Visual theme mismatch.** The current wood/parchment/gold tabletop theme (`--wood-*`, `--felt`, `--parchment*`, `--gold` in `css/style.css:1-12`) reads heavy and old-fashioned. User wants something warmer and more approachable but still game-like — confirmed via mockup review: **Ops Dashboard structure (icon chips + card grid) in earth tones**, not the technical navy/cyan HUD variant also shown.
3. **State clarity.** Turn/ownership/action-availability aren't always obvious at a glance (text-heavy tiles, sentence-based stat readouts).

## Goals

- Fix the overflow bug so the board is fully visible without horizontal scrolling at any width ≥ 900px, and degrades gracefully below that.
- Reskin to an earth-tone Ops-Dashboard look: warm cream/sand backgrounds, terracotta/olive/ochre accents, colored **vector SVG icons** (no emoji) for resources and site types, resource bar as icon+number chips.
- Make turn state, site ownership, and available actions readable at a glance.
- Preserve all existing game logic and animations (dice roll, resource pop-ups, round banner, card-drawn entrance, board-flash-on-take) — this is a reskin + layout fix, not a rewrite.

## Non-goals

- No changes to game rules, card data, bot AI, or server/multiplayer logic.
- No new mechanics (randomized tile costs, new card types, etc.) — that's the next spec.

## Design

### 1. Palette swap

Replace the `:root` palette in `css/style.css:1-12` and the wood/parchment gradient values used at `:81-90` (board frame) and `:97-101`/`:129-134` (card gradients) with an earth-tone set:

| Token | Old | New (approx) |
|---|---|---|
| `--bg` | `#0b0e16` navy | `#f3e8d3` warm sand |
| `--panel` | `#161d2c` navy | `#fffaf0` cream |
| `--gold` accent | `#f0c85a` | `#c98a2b` ochre |
| player 1 | `#ef5b50` red | `#b5502e` terracotta |
| player 2 | `#4a93ff` blue | `#3a5a7a` slate blue (kept cooler for contrast against P1) |
| wood/parchment/felt/ink group | `--wood-*`, `--felt`, `--parchment*`, `--ink` | folded into the new sand/cream/terracotta system — these separate "tabletop" tokens go away, board frame and tiles use the same palette as the rest of the UI |
| `--font-display` | Georgia/Palatino serif | kept as-is — serif headers still read well against the warm palette; revisit only if it clashes once implemented |

Exact hex values are flexible during implementation as long as they land in the same warm/earth family shown in the approved mockup (`.superpowers/brainstorm/32556-1783854732/content/visual-style-v4.html` — reference only, not shipped code).

### 2. Vector icon system

Introduce a small set of inline SVG icons (credits = coin/circle, ore = gem/diamond outline, troops = shield, influence = star/flag) to replace any emoji or plain-text stat labels in `renderHud()` (`js/game.js:1314`) and site tiles in `renderBoard()` (`js/game.js:1338`). Icons render as colored chips (icon + number) in the resource bar, and as a small colored badge per site tile indicating its category, matching the approved Ops Dashboard mockup structure.

Keep these as a small reusable JS helper (e.g. `icon(name, color)` returning an SVG string) rather than duplicating SVG markup at each call site — this is a single new small function in `js/game.js`, not a new file, to keep the codebase's existing single-file-per-concern structure.

### 3. Layout fix

- `.game-layout` (`css/style.css:335`): change fixed `300px` rails to `minmax(240px, 300px)` with the grid allowed to reflow, and add an intermediate breakpoint (e.g. `@media (max-width:1200px)` stacking to 2 columns, board+right column merge or right column collapses under board) before the existing `@media (max-width:900px)` full single-column stack.
- `.wrap{max-width:1160px}` (`css/style.css:26`): raise the ceiling or make it `100%` with padding so the 3-column grid has room to breathe on wide screens rather than being artificially capped.
- `#board{grid-template-columns:repeat(4,1fr)}` (`css/style.css:94`): keep 4-column desktop layout but add a `minmax(180px,1fr)` step so tiles shrink before the grid overflows, plus its own breakpoint to 2 columns on narrower widths.
- `.player-card{min-width:220px}` (`css/style.css:72`): drop the hard min-width inside the left column (the existing `#playerCardsPanel .player-card{min-width:0}` override at `:339` is a workaround for this same problem — the fix should make that override unnecessary or keep it as the real rule).

Verification: resize the browser window from 900px to 1920px in the running preview and confirm no horizontal scrollbar appears and all 8 board tiles remain visible/readable at each step.

### 4. State clarity

- Extend the existing `.player-card.active` glow (`css/style.css:75`) and `.loc.just-taken` flash (`:327`) patterns rather than inventing new interaction language — reuse what already works, apply it more consistently (e.g. ensure hover state exists on every clickable tile/button, not just `.mode-card` and `.loc.pickable`).
- Site tiles show an explicit ownership badge (e.g. "Yours" / player-color border) rather than relying on the reader to infer ownership from button state — this is a markup addition inside `renderBoard()`, not a new mechanic.

### 5. Inline style cleanup (opportunistic)

The exploration turned up ~14 inline `style="..."` fragments in generated HTML (`renderHud`, `renderIntrigueHand`, `showEndScreen`, modal builders, board action buttons at `js/game.js:1365-1367`). Since this redesign touches most of these render functions anyway, migrate inline layout styles (flex/gap/spacing) to CSS classes as they're touched, so the new theme lives entirely in `style.css` and isn't fighting inline overrides. Don't do a separate sweep for inline styles that aren't already being touched by the redesign — stay scoped.

## Testing / verification

- Manual pass in the Browser preview: setup screen, mid-game board (all 8 tiles across both tiers, Round 1 and Round 3+ to see Intrigue/Events unlocked), skirmish modal, end screen — confirm earth-tone theme applied consistently and no leftover navy/parchment/wood values.
- Resize check (900px–1920px) confirms no horizontal overflow.
- Confirm existing animations (dice roll, resource pop-up, round banner, card-drawn, board-flash) still fire correctly — this is a reskin, they should be visually restyled (new colors) but not functionally changed.
- No game-logic tests needed — no rules/state code changes in this spec.
